import {Livechat} from "../api";

const WEB_RTC_EVENTS = {
	WEB_RTC: "webrtc",
	STATUS: "status",
	CALL: "call",
	JOIN: "join",
	CANDIDATE: "candidate",
	DESCRIPTION: "description",
};

class WebRTCTransportClass {
	constructor(webrtcInstance) {
		this.debug = true;
		this.webrtcInstance = webrtcInstance;
	}

	log(...args) {
		if (this.debug === true) {
			console.log(...args);
		}
	}

	startCall(data) {
		this.log(
			"WebRTCTransportClass - startCall",
			this.webrtcInstance.room,
			this.webrtcInstance.selfId
		);
		Livechat.notifyVisitorCalling(this.webrtcInstance.room, {
			from: this.webrtcInstance.selfId,
			room: this.webrtcInstance.room,
			media: data.media,
		});
	}

	sendCandidate(data) {
		data.from = this.webrtcInstance.selfId;
		data.room = this.webrtcInstance.room;
		this.log('WebRTCTransportClass - sendCandidate', data);
		Livechat.notifyWebrtcAgent(data.to, WEB_RTC_EVENTS.CANDIDATE, data);
	}

	sendDescription(data) {
		data.from = this.webrtcInstance.selfId;
		data.room = this.webrtcInstance.room;
		this.log('WebRTCTransportClass - sendDescription', data);
		Livechat.notifyWebrtcAgent(data.to, WEB_RTC_EVENTS.DESCRIPTION, data);
	}

}

export class WebRTC {
	/*
  		@param seldId {String}
  		@param room {String}
   */

	constructor(selfId, room) {
		this.config = {
			iceServers: [],
		};
		this.debug = true;
		this.TransportClass = WebRTCTransportClass;
		this.selfId = selfId;
		this.room = room;
		let servers =
			"stun:stun01.sipphone.com,stun:stun.ekiga.net,stun:stun.fwdnet.net,stun:stun.ideasip.com,stun:stun.iptel.org";
		if (servers && servers.trim() !== "") {
			servers = servers.replace(/\s/g, "");
			servers = servers.split(",");

			servers.forEach((server) => {
				server = server.split("@");
				const serverConfig = {
					urls: server.pop(),
				};
				if (server.length === 1) {
					server = server[0].split(":");
					serverConfig.username = decodeURIComponent(server[0]);
					serverConfig.credential = decodeURIComponent(server[1]);
				}
				this.config.iceServers.push(serverConfig);
			});
		}
		this.media = {
			video: false,
			audio: true,
		};
		this.localStream = null;
		this.localUrl = "";
		this.audioEnabled = true;
		this.videoEnabled = true;
		this.peerConnections = {};
		this.remoteItems = [];
		this.remoteItemsById = {};
		this.navigator = undefined;
		const userAgent = navigator.userAgent.toLocaleLowerCase();

		if (userAgent.indexOf("electron") !== -1) {
			this.navigator = "electron";
		} else if (userAgent.indexOf("chrome") !== -1) {
			this.navigator = "chrome";
		} else if (userAgent.indexOf("firefox") !== -1) {
			this.navigator = "firefox";
		} else if (userAgent.indexOf("safari") !== -1) {
			this.navigator = "safari";
		}
		this.transport = new this.TransportClass(this);
	}

	log(...args) {
		if (this.debug === true) {
			console.log.apply(console, args);
		}
	}

	onError(...args) {
		console.error.apply(console, args);
	}

	updateRemoteItems() {
		const items = [];
		const itemsById = {};
		const { peerConnections } = this;

		Object.entries(peerConnections).forEach(([id, peerConnection]) => {
			peerConnection.getRemoteStreams().forEach((remoteStream) => {
				const item = {
					id,
					url: remoteStream,
					state: peerConnection.iceConnectionState,
				};
				switch (peerConnection.iceConnectionState) {
					case 'checking':
						item.stateText = 'Connecting...';
						break;
					case 'connected':
					case 'completed':
						item.stateText = 'Connected';
						item.connected = true;
						break;
					case 'disconnected':
						item.stateText = 'Disconnected';
						break;
					case 'failed':
						item.stateText = 'Failed';
						break;
					case 'closed':
						item.stateText = 'Closed';
				}
				items.push(item);
				itemsById[id] = item;
			});
		});
		this.remoteItems = items;
		this.remoteItemsById = itemsById;
	}

	/*
  		@param id {String}
   */

	stopPeerConnection = (id) => {
		const peerConnection = this.peerConnections[id];
		if (peerConnection == null) {
			return;
		}
		delete this.peerConnections[id];
		peerConnection.close();
		this.updateRemoteItems();
	}

	getPeerConnection(id) {
		if (this.peerConnections[id] != null) {
			return this.peerConnections[id];
		}
		const peerConnection = new RTCPeerConnection(this.config);

		peerConnection.createdAt = Date.now();
		peerConnection.remoteMedia = {};
		this.peerConnections[id] = peerConnection;
		const eventNames = ['icecandidate', 'addstream', 'removestream', 'iceconnectionstatechange', 'datachannel', 'identityresult', 'idpassertionerror', 'idpvalidationerror', 'negotiationneeded', 'peeridentity', 'signalingstatechange'];

		eventNames.forEach((eventName) => {
			peerConnection.addEventListener(eventName, (e) => {
				this.log(id, e.type, e);
			});
		});

		peerConnection.addEventListener('icecandidate', (e) => {
			if (e.candidate == null) {
				return;
			}
			this.transport.sendCandidate({
				to: id,
				candidate: {
					candidate: e.candidate.candidate,
					sdpMLineIndex: e.candidate.sdpMLineIndex,
					sdpMid: e.candidate.sdpMid,
				},
			});
		});
		peerConnection.addEventListener('addstream', () => {
			this.updateRemoteItems();
		});
		peerConnection.addEventListener('removestream', () => {
			this.updateRemoteItems();
		});
		peerConnection.addEventListener('iceconnectionstatechange', () => {
			if ((peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') && peerConnection === this.peerConnections[id]) {
				this.stopPeerConnection(id);
			}
			this.updateRemoteItems();
		});
		return peerConnection;
	}

	_getUserMedia(media, onSuccess, onError) {
		const onSuccessLocal = (stream) => {
			if (AudioContext && stream.getAudioTracks().length > 0) {
				const audioContext = new AudioContext();
				const source = audioContext.createMediaStreamSource(stream);
				const volume = audioContext.createGain();
				source.connect(volume);
				const peer = audioContext.createMediaStreamDestination();
				volume.connect(peer);
				volume.gain.value = 0.6;
				stream.removeTrack(stream.getAudioTracks()[0]);
				stream.addTrack(peer.stream.getAudioTracks()[0]);
				stream.volume = volume;
				this.audioContext = audioContext;
			}
			onSuccess(stream);
		};
		if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
			return navigator.mediaDevices
				.getUserMedia(media)
				.then(onSuccessLocal)
				.catch(onError);
		}
		navigator.getUserMedia(media, onSuccessLocal, onError);
	}

	/*
  		@param callback {Function}
   */

	getLocalUserMedia(callRemote, ...args) {
		this.log("getLocalUserMedia", [callRemote, ...args]);
		if (this.localStream != null) {
			return callRemote(null, this.localStream);
		}
		const onSuccess = (stream) => {
			this.localStream = stream;
			this.localUrl = stream;
			this.videoEnabled = this.media.video === true;
			this.audioEnabled = this.media.audio === true;
			const { peerConnections } = this;
			Object.entries(peerConnections).forEach(([, peerConnection]) =>
				peerConnection.addStream(stream)
			);
			document.querySelector('video#localVideo').srcObject=stream;
            document.querySelector('#localVideoLabel').style = "position: absolute; bottom: 0px; padding-top: 5px; width: 100%; color: #fffbfb; text-align: center; padding-bottom: 5px; font-weight: bold; background-color: rgba(0, 0, 0, 0.19);"
			callRemote(null, this.localStream);
		};
		const onError = (error) => {
			callRemote(false);
			this.onError(error);
		};
		this._getUserMedia(this.media, onSuccess, onError);
	}

	startCall(media = {}, ...args) {
		this.log("startCall", [media, ...args]);
		this.media = media;
		this.getLocalUserMedia(() => {
			this.transport.startCall({
				media: this.media,
			});
		});
	}

	onUserStream(type, data) {
		switch(type){
			case 'join':
				this.onRemoteJoin(data);
				break;
			case 'description':
				this.onRemoteDescription(data);
				break;
			case 'candidate':
				this.onRemoteCandidate(data);
				break;
			default:
		}
	}

	onRemoteJoin(data, ...args) {
		this.log('onRemoteJoin', [data, ...args]);
		let peerConnection = this.getPeerConnection(data.from);

		// needsRefresh = false
		// if peerConnection.iceConnectionState isnt 'new'
		// needsAudio = data.media.audio is true and peerConnection.remoteMedia.audio isnt true
		// needsVideo = data.media.video is true and peerConnection.remoteMedia.video isnt true
		// needsRefresh = needsAudio or needsVideo or data.media.desktop isnt peerConnection.remoteMedia.desktop

		// # if peerConnection.signalingState is "have-local-offer" or needsRefresh

		if (peerConnection.signalingState !== 'checking') {
			this.stopPeerConnection(data.from);
			peerConnection = this.getPeerConnection(data.from);
		}
		if (peerConnection.iceConnectionState !== 'new') {
			return;
		}
		peerConnection.remoteMedia = data.media;
		if (this.localStream) {
			peerConnection.addStream(this.localStream);
		}
		const onOffer = (offer) => {
			const onLocalDescription = () => {
				this.transport.sendDescription({
					to: data.from,
					type: 'offer',
					ts: peerConnection.createdAt,
					media: this.media,
					description: {
						sdp: offer.sdp,
						type: offer.type,
					},
				});
			};

			peerConnection.setLocalDescription(new RTCSessionDescription(offer), onLocalDescription, this.onError);
		};

		if (data.monitor === true) {
			peerConnection.createOffer(onOffer, this.onError, {
				mandatory: {
					OfferToReceiveAudio: data.media.audio,
					OfferToReceiveVideo: data.media.video,
				},
			});
		} else {
			peerConnection.createOffer(onOffer, this.onError);
		}
	}


	onRemoteOffer(data, ...args) {
		if (this.active !== true) {
			return;
		}

		this.log('onRemoteOffer', [data, ...args]);
		let peerConnection = this.getPeerConnection(data.from);

		if (['have-local-offer', 'stable'].includes(peerConnection.signalingState) && (peerConnection.createdAt < data.ts)) {
			this.stopPeerConnection(data.from);
			peerConnection = this.getPeerConnection(data.from);
		}

		if (peerConnection.iceConnectionState !== 'new') {
			return;
		}

		peerConnection.setRemoteDescription(new RTCSessionDescription(data.description));

		try {
			if (this.localStream) {
				peerConnection.addStream(this.localStream);
			}
		} catch (error) {
			console.log(error);
		}

		const onAnswer = (answer) => {
			const onLocalDescription = () => {
				this.transport.sendDescription({
					to: data.from,
					type: 'answer',
					ts: peerConnection.createdAt,
					description: {
						sdp: answer.sdp,
						type: answer.type,
					},
				});
			};

			peerConnection.setLocalDescription(new RTCSessionDescription(answer), onLocalDescription, this.onError);
		};

		peerConnection.createAnswer(onAnswer, this.onError);
	}

	/*
  		@param data {Object}
  			to {String}
  			from {String}
  			candidate {RTCIceCandidate JSON encoded}
   */

	onRemoteCandidate(data, ...args) {
		if (data.to !== this.selfId) {
			return;
		}
		this.log('onRemoteCandidate', [data, ...args]);
		document.querySelector('video#remoteVideo').srcObject=this.remoteItems[0].url;
        document.querySelector('#remoteVideoLabel').style = "position: absolute; bottom: 0px; padding-top: 5px; width: 100%; color: #fffbfb; text-align: center; padding-bottom: 5px; font-weight: bold; background-color: rgba(0, 0, 0, 0.19);"
		const peerConnection = this.getPeerConnection(data.from);
		if (peerConnection.iceConnectionState !== 'closed' && peerConnection.iceConnectionState !== 'failed' && peerConnection.iceConnectionState !== 'disconnected' && peerConnection.iceConnectionState !== 'completed') {
			peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
		}
	}


	/*
  		@param data {Object}
  			to {String}
  			from {String}
  			type {String} [offer, answer]
  			description {RTCSessionDescription JSON encoded}
  			ts {Integer}
  			media {Object}
  				audio {Boolean}
  				video {Boolean}
  				desktop {Boolean}
   */

	onRemoteDescription(data, ...args) {
		if (data.to !== this.selfId) {
			return;
		}
		this.log('onRemoteDescription', [data, ...args]);
		const peerConnection = this.getPeerConnection(data.from);
		if (data.type === 'offer') {
			peerConnection.remoteMedia = data.media;
			this.onRemoteOffer({
				from: data.from,
				ts: data.ts,
				description: data.description,
			});
		} else {
			peerConnection.setRemoteDescription(new RTCSessionDescription(data.description));
		}
	}
}
