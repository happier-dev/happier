import { describe, expect, it, vi } from 'vitest';

import {
  createSdkHandleConnection,
  createWebRtcConnection,
  createWebSocketPcmConnection,
  VOICE_WEBRTC_LIMITS,
  type VoiceConnectionDriver,
  type VoiceRealtimeTransportEvent,
} from './VoiceRealtimeConnection';

class FakeWebRtcDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
    this.bufferedAmount += new TextEncoder().encode(value).byteLength;
  }

  drainTo(bufferedAmount: number): void {
    const previous = this.bufferedAmount;
    this.bufferedAmount = bufferedAmount;
    if (
      previous > this.bufferedAmountLowThreshold
      && bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakeWebRtcPeer extends EventTarget {
  readonly channel = new FakeWebRtcDataChannel();
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'offer-sdp' }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn();

  remoteTrack(track: MediaStreamTrack, streams: readonly MediaStream[] = []): void {
    const event = new Event('track');
    Object.defineProperties(event, {
      track: { value: track },
      streams: { value: streams },
    });
    this.dispatchEvent(event);
  }
}

function installRemoteAudioElement(
  playImplementation: () => Promise<void>,
) {
  const audio = {
    autoplay: false,
    srcObject: null as MediaStream | null,
    volume: 1,
    play: vi.fn(playImplementation),
    pause: vi.fn<() => void>(),
    remove: vi.fn<() => void>(),
  };
  const createElement = vi.fn((tagName: string): unknown => {
    if (tagName !== 'audio') throw new Error(`unexpected element: ${tagName}`);
    return audio;
  });
  vi.stubGlobal('document', { createElement });
  return Object.freeze({ audio, createElement });
}

function createDriver() {
  let emitControl: ((event: unknown) => void) | null = null;
  let emitTransport: ((event: VoiceRealtimeTransportEvent) => void) | null = null;
  let emitRemoteClose: ((reason: string) => void) | null = null;
  const open = vi.fn(async (input: Parameters<VoiceConnectionDriver['open']>[0]) => {
    emitControl = input.onControl;
    emitTransport = input.onTransport;
    emitRemoteClose = input.onRemoteClose;
  });
  const sendControl = vi.fn(async (_event: unknown) => {});
  const close = vi.fn(async () => {});
  return {
    driver: { open, sendControl, close } satisfies VoiceConnectionDriver,
    open,
    sendControl,
    close,
    emitControl: (event: unknown) => emitControl?.(event),
    emitTransport: (event: VoiceRealtimeTransportEvent) => emitTransport?.(event),
    emitRemoteClose: (reason: string) => emitRemoteClose?.(reason),
  };
}

function jsonObjectWithExactUtf8Bytes(totalBytes: number): Readonly<{ values: readonly string[] }> {
  const values = ['', '', '', ''];
  let remaining = totalBytes - new TextEncoder().encode(JSON.stringify({ values })).byteLength;
  if (remaining < 0) throw new Error('fixture_too_small');
  for (let index = 0; index < values.length; index += 1) {
    const length = Math.min(64 * 1024, remaining);
    values[index] = 'x'.repeat(length);
    remaining -= length;
  }
  if (remaining !== 0) throw new Error('fixture_too_large');
  return { values };
}

describe('VoiceRealtimeConnection implementations', () => {
  it.each([
    ['sdk_handle', createSdkHandleConnection],
  ] as const)('keeps %s lifecycle and control flow transport-specific but contract-identical', async (kind, create) => {
    const fixture = createDriver();
    const connection = create({ driver: fixture.driver });
    const abortController = new AbortController();

    await connection.connect(abortController.signal);
    expect(connection.kind).toBe(kind);
    expect(connection.state()).toBe('open');

    fixture.emitControl({ type: 'provider.event', sequence: 1 });
    const iterator = connection.controlEvents(abortController.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'provider.event', sequence: 1 },
    });

    await connection.sendControl({ type: 'client.event' });
    expect(fixture.sendControl).toHaveBeenCalledWith({ type: 'client.event' });

    await connection.close({ code: 'user_stop' });
    await connection.close({ code: 'user_stop' });
    expect(connection.state()).toBe('closed');
    expect(fixture.close).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('owns PCM capture/playback only for the websocket_pcm connection', async () => {
    const fixture = createDriver();
    const pcm = {
      start: vi.fn(async (_signal: AbortSignal) => {}),
      stop: vi.fn(async () => {}),
      playbackCursorMs: vi.fn(() => 275),
      beginOutputInterruptionCandidate: vi.fn(() => 'ducked' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    };
    const connection = createWebSocketPcmConnection({ driver: fixture.driver, pcm });

    await connection.connect(new AbortController().signal);
    expect(connection.kind).toBe('websocket_pcm');
    expect(pcm.start).toHaveBeenCalledTimes(1);
    expect(connection.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(connection.playbackCursorMs()).toBe(275);
    connection.resolveOutputInterruptionCandidate('false_alarm');
    expect(pcm.resolveOutputInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
    await connection.close({ code: 'user_stop' });
    expect(pcm.stop).toHaveBeenCalledTimes(1);
  });

  it('closes the socket without waiting for a capture stop that has not settled', async () => {
    const fixture = createDriver();
    let settleCaptureStop!: () => void;
    const captureStopped = new Promise<void>((resolve) => { settleCaptureStop = resolve; });
    const pcm = {
      start: vi.fn(async (_signal: AbortSignal) => {}),
      stop: vi.fn(async () => await captureStopped),
    };
    const connection = createWebSocketPcmConnection({ driver: fixture.driver, pcm });
    await connection.connect(new AbortController().signal);

    const closed = connection.close({ code: 'user_stop' });
    // Socket teardown is independent of capture teardown: a capture stop that
    // is still draining must not retain the transport.
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledTimes(1));
    expect(pcm.stop).toHaveBeenCalledTimes(1);

    settleCaptureStop();
    await closed;
    expect(connection.state()).toBe('closed');
  });

  it('closes a websocket PCM connection when its canonical media owner reports a terminal failure', async () => {
    const fixture = createDriver();
    const terminalListener = { current: null as ((error: Error) => void) | null };
    const removeTerminalListener = vi.fn();
    const pcm = {
      start: vi.fn(async (_signal: AbortSignal) => {}),
      stop: vi.fn(async () => {}),
      subscribeTerminal: vi.fn((listener: (error: Error) => void) => {
        terminalListener.current = listener;
        return { remove: removeTerminalListener };
      }),
    };
    const connection = createWebSocketPcmConnection({ driver: fixture.driver, pcm });
    await connection.connect(new AbortController().signal);

    terminalListener.current?.(Object.assign(new Error('pcm_capture_device_lost'), {
      code: 'pcm_capture_device_lost',
    }));

    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledWith({
      code: 'error',
      detail: 'pcm_capture_device_lost',
    }));
    expect(connection.state()).toBe('closed');
    expect(pcm.stop).toHaveBeenCalledTimes(1);
    expect(removeTerminalListener).toHaveBeenCalledTimes(1);
  });

  it('projects driver-owned duck-only output control for SDK transports', async () => {
    const fixture = createDriver();
    const beginOutputInterruptionCandidate = vi.fn(() => 'ducked' as const);
    const resolveOutputInterruptionCandidate = vi.fn();
    const driver: VoiceConnectionDriver = {
      ...fixture.driver,
      beginOutputInterruptionCandidate,
      resolveOutputInterruptionCandidate,
    };
    const connection = createSdkHandleConnection({ driver });
    await connection.connect(new AbortController().signal);

    expect(connection.beginOutputInterruptionCandidate()).toBe('ducked');
    connection.resolveOutputInterruptionCandidate('false_alarm');
    expect(resolveOutputInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
  });

  it('latches non-active output focus through a late SDK connection open and rejects absent custody', async () => {
    const fixture = createDriver();
    const setOutputFocusState = vi.fn();
    const connection = createSdkHandleConnection({
      driver: { ...fixture.driver, setOutputFocusState },
    });

    expect(connection.setOutputFocusState?.('suspended')).toBe('applied');
    await connection.connect(new AbortController().signal);
    expect(setOutputFocusState.mock.calls).toEqual([['suspended'], ['suspended']]);
    expect(connection.setOutputFocusState?.('active')).toBe('applied');
    expect(setOutputFocusState).toHaveBeenLastCalledWith('active');

    const unsupported = createSdkHandleConnection({ driver: createDriver().driver });
    expect(unsupported.setOutputFocusState?.('suspended')).toBe('unsupported');
  });

  it('starts websocket PCM capture while the transport handshake is still pending', async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const fixture = createDriver();
    fixture.driver.open = vi.fn(async () => await openGate);
    const pcm = {
      start: vi.fn(async (_signal: AbortSignal) => {}),
      stop: vi.fn(async () => {}),
    };
    const connection = createWebSocketPcmConnection({ driver: fixture.driver, pcm });

    const connecting = connection.connect(new AbortController().signal);

    await vi.waitFor(() => expect(fixture.driver.open).toHaveBeenCalledTimes(1));
    expect(pcm.start).toHaveBeenCalledTimes(1);
    expect(connection.state()).toBe('connecting');

    releaseOpen();
    await connecting;
    expect(connection.state()).toBe('open');
  });

  it('stops websocket PCM capture when the transport handshake fails', async () => {
    const fixture = createDriver();
    fixture.driver.open = vi.fn(async () => {
      throw new Error('handshake_failed');
    });
    const pcm = {
      start: vi.fn(async (_signal: AbortSignal) => {}),
      stop: vi.fn(async () => {}),
    };
    const connection = createWebSocketPcmConnection({ driver: fixture.driver, pcm });

    await expect(connection.connect(new AbortController().signal)).rejects.toThrow('handshake_failed');

    expect(pcm.start).toHaveBeenCalledTimes(1);
    expect(pcm.stop).toHaveBeenCalledTimes(1);
    expect(connection.state()).toBe('closed');
  });

  it('closes the original connection when connect is aborted and ignores late open completion', async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const fixture = createDriver();
    fixture.driver.open = vi.fn(async () => await openGate);
    const connection = createSdkHandleConnection({ driver: fixture.driver });
    const abortController = new AbortController();

    const connecting = connection.connect(abortController.signal);
    abortController.abort();
    releaseOpen();

    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.state()).toBe('closed');
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight driver open when the connection is closed directly', async () => {
    const fixture = createDriver();
    fixture.driver.open = vi.fn(async ({ signal }) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('driver_open_aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });
    const connection = createSdkHandleConnection({ driver: fixture.driver });
    const connecting = connection.connect(new AbortController().signal);
    await vi.waitFor(() => expect(connection.state()).toBe('connecting'));

    await connection.close({ code: 'replaced' });

    const outcome = await Promise.race([
      connecting.then(() => 'resolved', (error: unknown) => (
        error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
          ? 'aborted'
          : 'rejected'
      )),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(outcome).toBe('aborted');
    expect(connection.state()).toBe('closed');
  });

  it('serializes control sends and rejects sends after a remote close', async () => {
    const fixture = createDriver();
    const order: string[] = [];
    fixture.driver.sendControl = vi.fn(async (event) => {
      const value = (event as { value: string }).value;
      order.push(`start:${value}`);
      await Promise.resolve();
      order.push(`end:${value}`);
    });
    const connection = createSdkHandleConnection({ driver: fixture.driver });
    await connection.connect(new AbortController().signal);

    await Promise.all([
      connection.sendControl({ value: 'a' }),
      connection.sendControl({ value: 'b' }),
    ]);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);

    fixture.emitRemoteClose('ice_failed');
    expect(connection.state()).toBe('closed');
    await expect(connection.sendControl({ value: 'late' })).rejects.toThrow('voice_connection_not_open');
  });

  it('bounds retained generic control sends by aggregate serialized bytes before queueing', async () => {
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const fixture = createDriver();
    fixture.driver.sendControl = vi.fn(async () => {
      await firstSendGate;
    });
    const connection = createSdkHandleConnection({ driver: fixture.driver });
    await connection.connect(new AbortController().signal);

    const firstBytes = Math.floor(VOICE_WEBRTC_LIMITS.outboundControlBytes / 2);
    const secondBytes = VOICE_WEBRTC_LIMITS.outboundControlBytes - firstBytes;
    const exactAggregate = [
      connection.sendControl(jsonObjectWithExactUtf8Bytes(firstBytes)),
      connection.sendControl(jsonObjectWithExactUtf8Bytes(secondBytes)),
    ];
    await vi.waitFor(() => expect(fixture.driver.sendControl).toHaveBeenCalledTimes(1));

    const overflow = connection.sendControl({ value: 'x' });
    const overflowOutcome = await Promise.race([
      overflow.then(
        () => 'resolved',
        (error: unknown) => (
          error instanceof Error && error.message === 'voice_connection_outbound_overflow'
            ? 'typed_overflow'
            : 'other_rejection'
        ),
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(overflowOutcome).toBe('typed_overflow');
    expect(connection.state()).toBe('closed');
    releaseFirstSend();
    await expect(Promise.allSettled(exactAggregate)).resolves.toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'voice_connection_outbound_overflow' }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'voice_connection_outbound_overflow' }),
      },
    ]);
  });

  it('bounds retained generic control sends by count and settles every send on close', async () => {
    const never = new Promise<void>(() => {});
    const fixture = createDriver();
    fixture.driver.sendControl = vi.fn(async () => await never);
    const connection = createWebSocketPcmConnection({
      driver: fixture.driver,
      pcm: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      },
    });
    await connection.connect(new AbortController().signal);

    const retained = Array.from(
      { length: VOICE_WEBRTC_LIMITS.outboundQueueItems },
      (_, sequence) => connection.sendControl({ sequence }),
    );
    await vi.waitFor(() => expect(fixture.driver.sendControl).toHaveBeenCalledTimes(1));
    const overflow = connection.sendControl({ sequence: 'overflow' });
    const overflowOutcome = await Promise.race([
      overflow.then(
        () => 'resolved',
        (error: unknown) => (
          error instanceof Error && error.message === 'voice_connection_outbound_overflow'
            ? 'typed_overflow'
            : 'other_rejection'
        ),
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(overflowOutcome).toBe('typed_overflow');

    const settlement = await Promise.race([
      Promise.allSettled(retained),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(settlement).not.toBe('pending');
    expect(settlement).toEqual(Array.from(
      { length: VOICE_WEBRTC_LIMITS.outboundQueueItems },
      () => ({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'voice_connection_outbound_overflow' }),
      }),
    ));
    expect(connection.state()).toBe('closed');
  });

  it('removes abort listeners after connect and a pending control read settle normally', async () => {
    const fixture = createDriver();
    const connection = createSdkHandleConnection({ driver: fixture.driver });
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');

    await connection.connect(abortController.signal);
    const iterator = connection.controlEvents(abortController.signal)[Symbol.asyncIterator]();
    const pendingRead = iterator.next();
    fixture.emitControl({ type: 'provider.event' });
    await expect(pendingRead).resolves.toEqual({
      done: false,
      value: { type: 'provider.event' },
    });

    expect(removeEventListener).toHaveBeenCalledTimes(addEventListener.mock.calls.length);
  });

  it('exposes WebRTC track replacement and ICE lifecycle as transport events without PCM methods', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      attachRemoteStream: () => ({
        dispose: vi.fn(),
        beginOutputInterruptionCandidate: () => 'ducked',
        resolveOutputInterruptionCandidate: vi.fn(),
        setOutputFocusState: vi.fn(() => 'applied' as const),
      }),
    });
    const abortController = new AbortController();
    const connecting = connection.connect(abortController.signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;
    const iterator = connection.transportEvents(abortController.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'webrtc_data_channel_state', state: 'open' },
    });

    const firstTrack = { id: 'remote-a' } as MediaStreamTrack;
    const replacementTrack = { id: 'remote-b' } as MediaStreamTrack;
    peer.remoteTrack(firstTrack);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'webrtc_remote_track', track: firstTrack, streams: [] },
    });

    peer.remoteTrack(replacementTrack);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'webrtc_remote_track',
        track: replacementTrack,
        streams: [],
        replacesTrackId: 'remote-a',
      },
    });

    peer.iceConnectionState = 'disconnected';
    peer.dispatchEvent(new Event('iceconnectionstatechange'));
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'webrtc_ice_state', state: 'disconnected' },
    });
    expect('startPcm' in connection).toBe(false);
    vi.unstubAllGlobals();
  });

  it('fails closed when a late native-style remote output cannot honor held focus', async () => {
    const peer = new FakeWebRtcPeer();
    const setOutputFocusState = vi.fn(() => 'unsupported' as const);
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      attachRemoteStream: () => ({
        dispose: vi.fn(),
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate: vi.fn(),
        setOutputFocusState,
      }),
    });
    const connecting = connection.connect(new AbortController().signal);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    peer.channel.open();
    await connecting;

    // Focus can arrive before the remote track; connection ownership retains
    // the fact until media attaches, then closes instead of leaking audio.
    expect(connection.setOutputFocusState?.('suspended')).toBe('applied');
    peer.remoteTrack({ id: 'uncontrollable-remote-output' } as MediaStreamTrack);
    await vi.waitFor(() => expect(connection.state()).toBe('closed'));
    expect(setOutputFocusState).toHaveBeenCalledWith('suspended');
  });

  it('uses injected native WebRTC primitives without creating a second connection lifecycle', async () => {
    const peer = new FakeWebRtcPeer();
    const createPeerConnection = vi.fn(() => peer as unknown as RTCPeerConnection);
    const fallbackStream = { getAudioTracks: () => [] } as unknown as MediaStream;
    const createMediaStream = vi.fn(() => fallbackStream);
    const attachRemoteStream = vi.fn(() => ({
      dispose: vi.fn(),
      beginOutputInterruptionCandidate: () => 'unsupported' as const,
      resolveOutputInterruptionCandidate: vi.fn(),
      setOutputFocusState: vi.fn(() => 'applied' as const),
    }));
    const localTrack = { id: 'local-native', stop: vi.fn() } as unknown as MediaStreamTrack;
    const localStream = { getAudioTracks: () => [localTrack] } as unknown as MediaStream;
    vi.stubGlobal('RTCPeerConnection', undefined);
    vi.stubGlobal('MediaStream', undefined);

    try {
      const connection = createWebRtcConnection({
        micStream: localStream,
        duckGain: 0.18,
        signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
        control: { label: 'oai-events', onOpen: () => undefined },
        createPeerConnection,
        createMediaStream,
        attachRemoteStream,
      });
      const connecting = connection.connect(new AbortController().signal);
      await Promise.resolve();
      peer.channel.open();
      await connecting;

      const remoteTrack = { id: 'remote-native' } as MediaStreamTrack;
      peer.remoteTrack(remoteTrack);

      expect(createPeerConnection).toHaveBeenCalledTimes(1);
      expect(createMediaStream).toHaveBeenCalledWith([remoteTrack]);
      expect(attachRemoteStream).toHaveBeenCalledWith(
        fallbackStream,
        'host_fallback',
      );
      const peerOwnedStream = { getAudioTracks: () => [] } as unknown as MediaStream;
      peer.remoteTrack(
        { id: 'remote-peer-owned' } as MediaStreamTrack,
        [peerOwnedStream],
      );
      expect(attachRemoteStream).toHaveBeenLastCalledWith(
        peerOwnedStream,
        'peer',
      );
      expect(createMediaStream).toHaveBeenCalledTimes(1);
      expect(peer.addTrack).toHaveBeenCalledWith(localTrack, localStream);

      await connection.close({ code: 'user_stop' });
      expect(localTrack.stop).not.toHaveBeenCalled();
      expect(peer.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed before open when default WebRTC remote audio playback rejects', async () => {
    const peer = new FakeWebRtcPeer();
    const audioBoundary = installRemoteAudioElement(async () => {
      throw new DOMException(
        'browser autoplay policy detail must not escape',
        'NotAllowedError',
      );
    });
    const onClosed = vi.fn(async () => {});
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      onClosed,
    });

    try {
      const connecting = connection.connect(new AbortController().signal);
      const rejected = expect(connecting).rejects.toMatchObject({
        code: 'voice_webrtc_remote_audio_playback_failed',
        message: 'voice_webrtc_remote_audio_playback_failed',
      });
      await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
      const remoteStream = { id: 'remote-stream-before-open' } as unknown as MediaStream;
      peer.remoteTrack({ id: 'remote-a' } as MediaStreamTrack, [remoteStream]);
      await vi.waitFor(() => expect(audioBoundary.audio.play).toHaveBeenCalledTimes(1));
      peer.channel.open();

      await rejected;
      expect(connection.state()).toBe('closed');
      expect(peer.close).toHaveBeenCalledTimes(1);
      expect(peer.channel.readyState).toBe('closed');
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledWith({
        code: 'error',
        detail: 'voice_webrtc_remote_audio_playback_failed',
      });
      expect(audioBoundary.audio.pause).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.remove).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.srcObject).toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('fails closed after open when default WebRTC remote audio playback rejects', async () => {
    const peer = new FakeWebRtcPeer();
    const audioBoundary = installRemoteAudioElement(async () => {
      throw new DOMException(
        'browser autoplay policy detail must not escape',
        'NotAllowedError',
      );
    });
    const onClosed = vi.fn(async () => {});
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      onClosed,
    });

    try {
      const connecting = connection.connect(new AbortController().signal);
      await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
      peer.channel.open();
      await connecting;
      expect(connection.state()).toBe('open');

      const remoteStream = { id: 'remote-stream-after-open' } as unknown as MediaStream;
      peer.remoteTrack({ id: 'remote-a' } as MediaStreamTrack, [remoteStream]);

      await vi.waitFor(() => expect(connection.state()).toBe('closed'));
      expect(peer.close).toHaveBeenCalledTimes(1);
      expect(peer.channel.readyState).toBe('closed');
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledWith({
        code: 'error',
        detail: 'voice_webrtc_remote_audio_playback_failed',
      });
      expect(audioBoundary.audio.pause).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.remove).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.srcObject).toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the default WebRTC connection open when remote audio playback succeeds', async () => {
    const peer = new FakeWebRtcPeer();
    const audioBoundary = installRemoteAudioElement(async () => {});
    const onClosed = vi.fn(async () => {});
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      onClosed,
    });

    try {
      const connecting = connection.connect(new AbortController().signal);
      await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
      const remoteStream = { id: 'remote-stream-success' } as unknown as MediaStream;
      peer.remoteTrack({ id: 'remote-a' } as MediaStreamTrack, [remoteStream]);
      await vi.waitFor(() => expect(audioBoundary.audio.play).toHaveBeenCalledTimes(1));
      peer.channel.open();
      await connecting;

      expect(connection.state()).toBe('open');
      expect(peer.close).not.toHaveBeenCalled();
      expect(onClosed).not.toHaveBeenCalled();
      expect(audioBoundary.audio.srcObject).toBe(remoteStream);

      await connection.close({ code: 'user_stop' });
      expect(audioBoundary.audio.pause).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.remove).toHaveBeenCalledTimes(1);
      expect(audioBoundary.audio.srcObject).toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('ignores stale remote playback rejection after stream replacement or connection close', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    let rejectReplacedPlayback!: (error: Error) => void;
    const replacedPlayback = new Promise<void>((_resolve, reject) => {
      rejectReplacedPlayback = reject;
    });
    let rejectClosedPlayback!: (error: Error) => void;
    const closedPlayback = new Promise<void>((_resolve, reject) => {
      rejectClosedPlayback = reject;
    });
    const attachments = [
      {
        playbackStarted: replacedPlayback,
        dispose: vi.fn(),
        beginOutputInterruptionCandidate: () => 'ducked' as const,
        resolveOutputInterruptionCandidate: vi.fn(),
        setOutputFocusState: vi.fn(() => 'applied' as const),
      },
      {
        playbackStarted: Promise.resolve(),
        dispose: vi.fn(),
        beginOutputInterruptionCandidate: () => 'ducked' as const,
        resolveOutputInterruptionCandidate: vi.fn(),
        setOutputFocusState: vi.fn(() => 'applied' as const),
      },
      {
        playbackStarted: closedPlayback,
        dispose: vi.fn(),
        beginOutputInterruptionCandidate: () => 'ducked' as const,
        resolveOutputInterruptionCandidate: vi.fn(),
        setOutputFocusState: vi.fn(() => 'applied' as const),
      },
    ] as const;
    const attachRemoteStream = vi.fn()
      .mockReturnValueOnce(attachments[0])
      .mockReturnValueOnce(attachments[1])
      .mockReturnValueOnce(attachments[2]);
    const onClosed = vi.fn(async () => {});
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
      attachRemoteStream,
      onClosed,
    });

    const connecting = connection.connect(new AbortController().signal);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    peer.channel.open();
    await connecting;

    peer.remoteTrack({ id: 'remote-a' } as MediaStreamTrack);
    peer.remoteTrack({ id: 'remote-b' } as MediaStreamTrack);
    expect(attachments[0].dispose).toHaveBeenCalledTimes(1);
    rejectReplacedPlayback(new Error('stale replacement failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.state()).toBe('open');
    expect(onClosed).not.toHaveBeenCalled();

    peer.remoteTrack({ id: 'remote-c' } as MediaStreamTrack);
    expect(attachments[1].dispose).toHaveBeenCalledTimes(1);
    await connection.close({ code: 'user_stop' });
    rejectClosedPlayback(new Error('stale closed-attempt failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.state()).toBe('closed');
    expect(attachments[2].dispose).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith({ code: 'user_stop' });
    vi.unstubAllGlobals();
  });

  it('retains provider session identity synchronously once transport open completes', async () => {
    const fixture = createDriver();
    fixture.driver.open = vi.fn(async ({ onTransport }) => {
      onTransport({ type: 'session_identity', sessionId: 'provider-session-before-open' });
    });
    const connection = createSdkHandleConnection({ driver: fixture.driver });

    await connection.connect(new AbortController().signal);

    expect(connection.currentProviderSessionId()).toBe('provider-session-before-open');
  });

  it('fails closed when an unread inbound queue exceeds its configured bound', async () => {
    const fixture = createDriver();
    const connection = createSdkHandleConnection({
      driver: fixture.driver,
      maxQueuedControlEvents: 1,
    });
    await connection.connect(new AbortController().signal);

    fixture.emitControl({ sequence: 1 });
    fixture.emitControl({ sequence: 2 });
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledWith({
      code: 'error',
      detail: 'voice_connection_inbound_overflow',
    }));
    expect(connection.state()).toBe('closed');
  });

  it('opens after ordered initial controls even when remote audio playback has not settled', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const exchangeOffer = vi.fn(async () => ({ answerSdp: 'answer-sdp' }));
    const neverSettlingPlayback = new Promise<void>(() => {});
    const attachRemoteStream = vi.fn(() => ({
      playbackStarted: neverSettlingPlayback,
      dispose: vi.fn(),
      beginOutputInterruptionCandidate: () => 'ducked' as const,
      resolveOutputInterruptionCandidate: vi.fn(),
      setOutputFocusState: vi.fn(() => 'applied' as const),
    }));
    let releaseInitialControl!: () => void;
    const initialControlGate = new Promise<void>((resolve) => {
      releaseInitialControl = resolve;
    });
    const onOpen = vi.fn(async ({ sendJson }: Readonly<{
      sendJson(value: import('@happier-dev/protocol').VoiceRealtimeJsonValue): Promise<void>;
    }>) => {
      await sendJson({ type: 'session.update', sequence: 1 });
      await initialControlGate;
      await sendJson({ type: 'session.update', sequence: 2 });
    });
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer },
      control: { label: 'oai-events', onOpen },
      attachRemoteStream,
    });

    let connectSettled = false;
    const connecting = connection.connect(new AbortController().signal).then(() => {
      connectSettled = true;
    });
    await vi.waitFor(() => expect(peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
    peer.remoteTrack({ id: 'remote-a' } as MediaStreamTrack);
    expect(attachRemoteStream).toHaveBeenCalledTimes(1);
    peer.channel.open();
    await vi.waitFor(() => expect(peer.channel.sent).toEqual([
      JSON.stringify({ type: 'session.update', sequence: 1 }),
    ]));
    expect(connection.state()).toBe('connecting');
    releaseInitialControl();
    await vi.waitFor(() => expect(connectSettled).toBe(true));
    await connecting;

    expect(connection.state()).toBe('open');
    expect(exchangeOffer).toHaveBeenCalledWith({
      offerSdp: 'offer-sdp',
      signal: expect.any(AbortSignal),
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'answer-sdp',
    });
    expect(peer.channel.sent.map((value) => JSON.parse(value))).toEqual([
      { type: 'session.update', sequence: 1 },
      { type: 'session.update', sequence: 2 },
    ]);
    vi.unstubAllGlobals();
  });

  it('awaits a fire-and-forget initial control that is pending on data-channel backpressure', async () => {
    const peer = new FakeWebRtcPeer();
    peer.channel.bufferedAmount = VOICE_WEBRTC_LIMITS.outboundBufferedBytes;
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const firstInitialControl = jsonObjectWithExactUtf8Bytes(150 * 1024);
    const secondInitialControl = jsonObjectWithExactUtf8Bytes(150 * 1024);
    const initialSends: Promise<void>[] = [];
    const onOpen = vi.fn(({ sendJson }: Readonly<{
      sendJson(value: import('@happier-dev/protocol').VoiceRealtimeJsonValue): Promise<void>;
    }>) => {
      initialSends.push(
        sendJson(firstInitialControl),
        sendJson(secondInitialControl),
      );
    });
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen },
    });
    let connectSettled = false;

    const connecting = connection.connect(new AbortController().signal).finally(() => {
      connectSettled = true;
    });
    await Promise.resolve();
    peer.channel.open();
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(connection.state()).toBe('connecting');
    expect(connectSettled).toBe(false);
    expect(peer.channel.sent).toEqual([]);

    peer.channel.drainTo(0);
    await vi.waitFor(() => expect(peer.channel.sent).toHaveLength(1));
    expect(connection.state()).toBe('connecting');
    expect(connectSettled).toBe(false);

    peer.channel.drainTo(0);
    await connecting;
    await Promise.all(initialSends);

    expect(connection.state()).toBe('open');
    expect(peer.channel.sent.map((value) => JSON.parse(value))).toEqual([
      firstInitialControl,
      secondInitialControl,
    ]);
    vi.unstubAllGlobals();
  });

  it('fails connection while onOpen is still pending when a fire-and-forget initial control rejects', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const onOpen = vi.fn(({ sendJson }: Readonly<{
      sendJson(value: import('@happier-dev/protocol').VoiceRealtimeJsonValue): Promise<void>;
    }>) => {
      void sendJson(jsonObjectWithExactUtf8Bytes(
        VOICE_WEBRTC_LIMITS.outboundControlBytes + 1,
      ));
      return new Promise<void>(() => {});
    });
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen },
    });

    const connecting = connection.connect(new AbortController().signal).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await Promise.resolve();
    peer.channel.open();
    await vi.waitFor(() => expect(connection.state()).toBe('closed'));

    await expect(connecting).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'voice_connection_outbound_control_oversized' },
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(peer.channel.sent).toEqual([]);
    expect(peer.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('rejects the attempt-scoped initial sender after its barrier closes without an unhandled rejection', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const initialSender: {
      current: ((value: import('@happier-dev/protocol').VoiceRealtimeJsonValue) => Promise<void>)
        | null;
    } = { current: null };
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: {
        label: 'oai-events',
        onOpen: ({ sendJson }) => {
          initialSender.current = sendJson;
        },
      },
    });

    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;

    const initialSendJson = initialSender.current;
    if (!initialSendJson) throw new Error('initial sender was not captured');
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', captureUnhandledRejection);
    try {
      void initialSendJson({ type: 'fire-and-forget.late.initial.control' });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      await expect(initialSendJson({ type: 'awaited.late.initial.control' }))
        .rejects.toThrow('voice_webrtc_initial_control_barrier_closed');
      expect(unhandledRejections).toEqual([]);
      expect(connection.state()).toBe('open');
      expect(peer.channel.sent).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', captureUnhandledRejection);
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['', 'empty'],
    ['x'.repeat(VOICE_WEBRTC_LIMITS.controlLabelBytes + 1), 'oversized'],
    ['invalid\u0000label', 'control-character'],
    ['invalid\uD800label', 'invalid-unicode'],
  ])('rejects an %s WebRTC control label before creating a peer', async (label) => {
    const createPeer = vi.fn(() => new FakeWebRtcPeer());
    vi.stubGlobal('RTCPeerConnection', createPeer);
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label, onOpen: () => undefined },
    });

    await expect(connection.connect(new AbortController().signal))
      .rejects.toThrow('voice_webrtc_control_label_invalid');
    expect(createPeer).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('accepts a WebRTC control label exactly at the UTF-8 byte limit', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const label = 'x'.repeat(VOICE_WEBRTC_LIMITS.controlLabelBytes);
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label, onOpen: () => undefined },
    });
    const connecting = connection.connect(new AbortController().signal);
    await vi.waitFor(() => expect(peer.createDataChannel).toHaveBeenCalledWith(label));
    peer.channel.open();
    await connecting;
    vi.unstubAllGlobals();
  });

  it('enforces independent exact offer and answer SDP byte limits', async () => {
    const exactOfferSdp = 'é'.repeat(VOICE_WEBRTC_LIMITS.offerSdpBytes / 2);
    const oversizedOfferSdp = `${exactOfferSdp}x`;
    const exactAnswerSdp = 'é'.repeat(VOICE_WEBRTC_LIMITS.answerSdpBytes / 2);
    const oversizedAnswerSdp = `${exactAnswerSdp}x`;
    expect(new TextEncoder().encode(exactOfferSdp).byteLength)
      .toBe(VOICE_WEBRTC_LIMITS.offerSdpBytes);
    expect(new TextEncoder().encode(oversizedOfferSdp).byteLength)
      .toBe(VOICE_WEBRTC_LIMITS.offerSdpBytes + 1);
    expect(new TextEncoder().encode(exactAnswerSdp).byteLength)
      .toBe(VOICE_WEBRTC_LIMITS.answerSdpBytes);
    expect(new TextEncoder().encode(oversizedAnswerSdp).byteLength)
      .toBe(VOICE_WEBRTC_LIMITS.answerSdpBytes + 1);
    const exactPeer = new FakeWebRtcPeer();
    exactPeer.createOffer.mockResolvedValue({
      type: 'offer',
      sdp: exactOfferSdp,
    });
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => exactPeer));
    const exchangeOffer = vi.fn(async () => ({
      answerSdp: exactAnswerSdp,
    }));
    const exactConnection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer },
      control: { label: 'events', onOpen: () => undefined },
    });
    const exactConnecting = exactConnection.connect(new AbortController().signal);
    await vi.waitFor(() => expect(exchangeOffer).toHaveBeenCalled());
    exactPeer.channel.open();
    await expect(exactConnecting).resolves.toBeUndefined();
    await exactConnection.close({ code: 'user_stop' });
    expect(exactPeer.close).toHaveBeenCalledTimes(1);

    const oversizedOfferPeer = new FakeWebRtcPeer();
    oversizedOfferPeer.createOffer.mockResolvedValue({
      type: 'offer',
      sdp: oversizedOfferSdp,
    });
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => oversizedOfferPeer));
    const oversizedOfferExchange = vi.fn();
    await expect(createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: oversizedOfferExchange },
      control: { label: 'events', onOpen: () => undefined },
    }).connect(new AbortController().signal)).rejects.toThrowError(
      /^voice_webrtc_offer_invalid$/,
    );
    expect(oversizedOfferExchange).not.toHaveBeenCalled();
    expect(oversizedOfferPeer.close).toHaveBeenCalledTimes(1);

    const oversizedAnswerPeer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => oversizedAnswerPeer));
    await expect(createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: {
        exchangeOffer: async () => ({
          answerSdp: oversizedAnswerSdp,
        }),
      },
      control: { label: 'events', onOpen: () => undefined },
    }).connect(new AbortController().signal)).rejects.toThrowError(
      /^voice_webrtc_answer_invalid$/,
    );
    expect(oversizedAnswerPeer.setRemoteDescription).not.toHaveBeenCalled();
    expect(oversizedAnswerPeer.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('rejects malformed Unicode SDP at the shared host boundary', async () => {
    const invalidOfferPeer = new FakeWebRtcPeer();
    invalidOfferPeer.createOffer.mockResolvedValue({
      type: 'offer',
      sdp: 'v=0\r\n\ud800',
    });
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => invalidOfferPeer));
    const exchangeOffer = vi.fn();
    await expect(createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer },
      control: { label: 'events', onOpen: () => undefined },
    }).connect(new AbortController().signal)).rejects.toThrowError(
      /^voice_webrtc_offer_invalid$/,
    );
    expect(exchangeOffer).not.toHaveBeenCalled();
    expect(invalidOfferPeer.close).toHaveBeenCalledTimes(1);

    const invalidAnswerPeer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => invalidAnswerPeer));
    await expect(createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: {
        exchangeOffer: async () => ({
          answerSdp: 'v=0\r\n\udc00',
        }),
      },
      control: { label: 'events', onOpen: () => undefined },
    }).connect(new AbortController().signal)).rejects.toThrowError(
      /^voice_webrtc_answer_invalid$/,
    );
    expect(invalidAnswerPeer.setRemoteDescription).not.toHaveBeenCalled();
    expect(invalidAnswerPeer.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('enforces the outbound byte limit and bounded ordered queue', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'events', onOpen: () => undefined },
    });
    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;

    const values = ['', '', '', ''];
    let remaining = VOICE_WEBRTC_LIMITS.outboundControlBytes
      - new TextEncoder().encode(JSON.stringify({ values })).byteLength;
    for (let index = 0; index < values.length; index += 1) {
      const length = Math.min(64 * 1024, remaining);
      values[index] = 'x'.repeat(length);
      remaining -= length;
    }
    const exact = { values };
    await expect(connection.sendControl(exact)).resolves.toBeUndefined();
    expect(new TextEncoder().encode(peer.channel.sent.at(-1)!).byteLength)
      .toBe(VOICE_WEBRTC_LIMITS.outboundControlBytes);
    const oversizedValues = [...values];
    oversizedValues[oversizedValues.length - 1] += 'x';
    await expect(connection.sendControl({
      values: oversizedValues,
    })).rejects.toThrow('voice_connection_outbound_control_oversized');

    const queuePeer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => queuePeer));
    const queueConnection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'events', onOpen: () => undefined },
    });
    const queueConnecting = queueConnection.connect(new AbortController().signal);
    await Promise.resolve();
    queuePeer.channel.open();
    await queueConnecting;
    const sends = Array.from(
      { length: VOICE_WEBRTC_LIMITS.outboundQueueItems + 1 },
      (_, sequence) => queueConnection.sendControl({ sequence }),
    );
    const settled = await Promise.allSettled(sends);
    expect(settled).toHaveLength(VOICE_WEBRTC_LIMITS.outboundQueueItems + 1);
    expect(settled.some((result) => (
      result.status === 'rejected'
      && result.reason instanceof Error
      && result.reason.message === 'voice_connection_outbound_overflow'
    ))).toBe(true);
    expect(queueConnection.state()).toBe('closed');
    vi.unstubAllGlobals();
  });

  it('fails closed when the native data-channel send throws and fences later sends', async () => {
    const peer = new FakeWebRtcPeer();
    const onClosed = vi.fn();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'events', onOpen: () => undefined },
      onClosed,
    });
    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;
    vi.spyOn(peer.channel, 'send').mockImplementationOnce(() => {
      throw new Error('native_data_channel_send_failed');
    });

    await expect(connection.sendControl({ sequence: 1 }))
      .rejects.toThrow('voice_webrtc_data_channel_send_failed');
    await vi.waitFor(() => expect(connection.state()).toBe('closed'));
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith({
      code: 'error',
      detail: 'voice_webrtc_data_channel_send_failed',
    });
    await expect(connection.sendControl({ sequence: 2 }))
      .rejects.toThrow('voice_connection_not_open');
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('awaits native data-channel capacity and aborts a pending capacity wait on close', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'events', onOpen: () => undefined },
    });
    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;

    const values = ['', '', '', ''];
    let remaining = VOICE_WEBRTC_LIMITS.outboundControlBytes
      - new TextEncoder().encode(JSON.stringify({ values })).byteLength;
    for (let index = 0; index < values.length; index += 1) {
      const length = Math.min(64 * 1024, remaining);
      values[index] = 'x'.repeat(length);
      remaining -= length;
    }
    const fill = { values };
    await connection.sendControl(fill);
    expect(peer.channel.bufferedAmount).toBe(VOICE_WEBRTC_LIMITS.outboundControlBytes);

    const nextValue = { sequence: 2 };
    const nextBytes = new TextEncoder().encode(JSON.stringify(nextValue)).byteLength;
    const next = connection.sendControl(nextValue);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peer.channel.sent).toHaveLength(1);

    peer.channel.drainTo(VOICE_WEBRTC_LIMITS.outboundControlBytes - nextBytes);
    await expect(next).resolves.toBeUndefined();
    expect(peer.channel.sent).toHaveLength(2);
    expect(peer.channel.bufferedAmount).toBe(VOICE_WEBRTC_LIMITS.outboundControlBytes);

    const blocked = connection.sendControl({ sequence: 3 });
    const blockedOutcome = expect(blocked).rejects.toThrow('voice_connection_aborted');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peer.channel.sent).toHaveLength(2);
    await connection.close({ code: 'user_stop' });
    await blockedOutcome;
    vi.unstubAllGlobals();
  });

  it('bounds inbound UTF-8 bytes before JSON parsing and rejects binary control data', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
    });
    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;
    const iterator = connection.controlEvents(new AbortController().signal)[Symbol.asyncIterator]();
    const values = Array.from(
      { length: Math.ceil(VOICE_WEBRTC_LIMITS.inboundControlBytes / (64 * 1024)) + 1 },
      () => '',
    );
    let remaining = VOICE_WEBRTC_LIMITS.inboundControlBytes
      - new TextEncoder().encode(JSON.stringify({ values })).byteLength;
    for (let index = 0; index < values.length; index += 1) {
      const length = Math.min(64 * 1024, remaining);
      values[index] = 'x'.repeat(length);
      remaining -= length;
    }
    const exact = JSON.stringify({ values });
    expect(new TextEncoder().encode(exact).byteLength).toBe(VOICE_WEBRTC_LIMITS.inboundControlBytes);
    peer.channel.message(exact);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { values: expect.any(Array) },
    });

    peer.channel.message(`${exact} `);
    await vi.waitFor(() => expect(connection.state()).toBe('closed'));
    expect(peer.close).toHaveBeenCalledTimes(1);

    const binaryPeer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => binaryPeer));
    const binaryConnection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen: () => undefined },
    });
    const binaryConnecting = binaryConnection.connect(new AbortController().signal);
    await Promise.resolve();
    binaryPeer.channel.open();
    await binaryConnecting;
    binaryPeer.channel.message(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(binaryConnection.state()).toBe('closed'));
    vi.unstubAllGlobals();
  });

  it('admits the largest valid Codex final with worst-case JSON escaping', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'codex-events', onOpen: () => undefined },
    });
    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await connecting;
    const iterator = connection.controlEvents(new AbortController().signal)[Symbol.asyncIterator]();
    const largestAdmittedCodexFinal = {
      type: 'turn.done',
      turn: {
        id: '\0'.repeat(192),
        role: 'assistant',
        transcript: '\0'.repeat(64 * 1024),
      },
    };
    const serialized = JSON.stringify(largestAdmittedCodexFinal);
    expect(new TextEncoder().encode(serialized).byteLength).toBe(394_440);

    peer.channel.message(serialized);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: largestAdmittedCodexFinal,
    });
    expect(connection.state()).toBe('open');
    vi.unstubAllGlobals();
  });

  it('closes the peer when the initial-control barrier rejects without publishing open', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: {
        label: 'oai-events',
        onOpen: async () => {
          throw new Error('initial_control_rejected');
        },
      },
    });

    const connecting = connection.connect(new AbortController().signal);
    await Promise.resolve();
    peer.channel.open();
    await expect(connecting).rejects.toThrow('initial_control_rejected');
    expect(connection.state()).toBe('closed');
    expect(peer.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it.each([
    {
      failure: 'ICE',
      expectedCode: 'voice_webrtc_ice_failed',
      trigger(peer: FakeWebRtcPeer) {
        peer.iceConnectionState = 'failed';
        peer.dispatchEvent(new Event('iceconnectionstatechange'));
      },
    },
    {
      failure: 'data-channel',
      expectedCode: 'voice_webrtc_data_channel_closed',
      trigger(peer: FakeWebRtcPeer) {
        peer.channel.close();
      },
    },
    {
      failure: 'peer',
      expectedCode: 'voice_webrtc_failed',
      trigger(peer: FakeWebRtcPeer) {
        peer.connectionState = 'failed';
        peer.dispatchEvent(new Event('connectionstatechange'));
      },
    },
  ])('preserves a stable remote $failure failure code during connect without treating it as caller abort', async ({
    expectedCode,
    trigger,
  }) => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const exchangeOffer = vi.fn(async () => await new Promise<never>(() => undefined));
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer },
      control: { label: 'oai-events', onOpen: () => undefined },
    });
    const caller = new AbortController();
    const connecting = connection.connect(caller.signal).then(
      () => ({ status: 'resolved' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(exchangeOffer).toHaveBeenCalledTimes(1));

    trigger(peer);
    const outcome = await connecting;

    expect(caller.signal.aborted).toBe(false);
    expect(outcome.status).toBe('rejected');
    expect(outcome.error).not.toMatchObject({ name: 'AbortError' });
    expect(outcome.error).toMatchObject({
      code: expectedCode,
      message: expectedCode,
    });
    expect(connection.state()).toBe('closed');
    expect(peer.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('settles connect and ignores a late offer exchange when the attempt aborts during signaling', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    let releaseOffer!: (answer: Readonly<{ answerSdp: string }>) => void;
    const offerExchange = new Promise<Readonly<{ answerSdp: string }>>((resolve) => {
      releaseOffer = resolve;
    });
    const exchangeOffer = vi.fn(async () => await offerExchange);
    const onClosed = vi.fn();
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer },
      control: { label: 'oai-events', onOpen: () => undefined },
      onClosed,
    });
    const abortController = new AbortController();
    const connecting = connection.connect(abortController.signal).then(
      () => 'resolved' as const,
      (error: unknown) => (
        error instanceof Error && error.name === 'AbortError'
          ? 'aborted' as const
          : 'rejected' as const
      ),
    );
    await vi.waitFor(() => expect(exchangeOffer).toHaveBeenCalledTimes(1));

    abortController.abort();
    const settlementAtAbort = await Promise.race([
      connecting,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    releaseOffer({ answerSdp: 'answer-sdp' });
    peer.channel.open();
    await connecting;
    vi.unstubAllGlobals();

    expect(settlementAtAbort).toBe('aborted');
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(connection.state()).toBe('closed');
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['createOffer', 'abort'],
    ['createOffer', 'close'],
    ['setLocalDescription', 'abort'],
    ['setLocalDescription', 'close'],
    ['setRemoteDescription', 'abort'],
    ['setRemoteDescription', 'close'],
  ] as const)('settles connect when %s remains pending and the attempt receives %s', async (
    nativeOperation,
    interruption,
  ) => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    const neverSettles = new Promise<never>(() => {});
    if (nativeOperation === 'createOffer') {
      peer.createOffer.mockImplementation(async () => await neverSettles);
    } else if (nativeOperation === 'setLocalDescription') {
      peer.setLocalDescription.mockImplementation(async () => await neverSettles);
    } else {
      peer.setRemoteDescription.mockImplementation(async () => await neverSettles);
    }
    const onOpen = vi.fn();
    const onClosed = vi.fn();
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen },
      onClosed,
    });
    const caller = new AbortController();
    const connecting = connection.connect(caller.signal).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const pendingOperation = nativeOperation === 'createOffer'
      ? peer.createOffer
      : nativeOperation === 'setLocalDescription'
        ? peer.setLocalDescription
        : peer.setRemoteDescription;
    await vi.waitFor(() => expect(pendingOperation).toHaveBeenCalledTimes(1));

    if (interruption === 'abort') {
      caller.abort();
    } else {
      await connection.close({ code: 'user_stop' });
    }
    const settlement = await Promise.race([
      connecting,
      new Promise<Readonly<{ status: 'pending' }>>((resolve) => {
        setTimeout(() => resolve({ status: 'pending' }), 25);
      }),
    ]);
    vi.unstubAllGlobals();

    expect(settlement).toMatchObject({
      status: 'rejected',
      error: interruption === 'abort'
        ? { name: 'AbortError', message: 'voice_connection_aborted' }
        : { message: 'voice_connection_user_stop' },
    });
    expect(connection.state()).toBe('closed');
    expect(caller.signal.aborted).toBe(interruption === 'abort');
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('settles connect and closes the peer when the attempt aborts during the initial-control barrier', async () => {
    const peer = new FakeWebRtcPeer();
    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    let releaseInitialControls!: () => void;
    const initialControls = new Promise<void>((resolve) => {
      releaseInitialControls = resolve;
    });
    const onOpen = vi.fn(async () => await initialControls);
    const onClosed = vi.fn();
    const connection = createWebRtcConnection({
      micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
      duckGain: 0.18,
      signaling: { exchangeOffer: async () => ({ answerSdp: 'answer-sdp' }) },
      control: { label: 'oai-events', onOpen },
      onClosed,
    });
    const abortController = new AbortController();
    let settlement: 'pending' | 'resolved' | 'aborted' | 'rejected' = 'pending';
    const connecting = connection.connect(abortController.signal).then(
      () => {
        settlement = 'resolved';
      },
      (error: unknown) => {
        settlement = error instanceof Error && error.name === 'AbortError'
          ? 'aborted'
          : 'rejected';
      },
    );
    await Promise.resolve();
    peer.channel.open();
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    abortController.abort();
    const settlementAtAbort = await Promise.race([
      connecting.then(() => settlement),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    releaseInitialControls();
    await connecting;
    vi.unstubAllGlobals();

    expect(settlementAtAbort).toBe('aborted');
    expect(connection.state()).toBe('closed');
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
