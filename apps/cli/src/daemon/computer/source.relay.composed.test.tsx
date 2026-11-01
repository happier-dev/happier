import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
  MachineLiveStreamDecodedEnvelopeV1Schema,
  MachineLiveStreamRelayEnvelopeV1Schema,
  createMachineLiveStreamRelayAuthorizationSigningInputV1,
  type MachineLiveStreamRelayEnvelopeV1,
  type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

import { native } from './driver/nativeComputerBoundary.testkit';
import { createComputerCaptureSource } from './source';
import { createMachineLiveStreamRelayTerminator } from '../peer/mediation/stream/relay';
import { createFakeSocket, getSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { TEST_MACHINE_INSTALLATION_ID } from '../../../../server/sources/app/api/testkit/machineAdmissionPersistenceBoundary';
import { renderScreen } from '../../../../ui/sources/dev/testkit/render/renderScreen';
import { flushHookEffects } from '../../../../ui/sources/dev/testkit/hooks/flushHookEffects';
import { createMachineLiveStreamSocketTransport } from '../../../../ui/sources/sync/domains/machines/peer/mediation/stream/socketTransport';
import { useSimulatorRelayIngestion, type SimulatorRelayTransport } from '../../../../ui/sources/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { LiveStreamPlayer } from '../../../../ui/sources/components/stream/LiveStreamPlayer';

// Native capture, Socket.IO delivery, persistence and platform rendering are boundaries;
// capture, relay authorization/credit, ingestion and presentation owners stay real.
vi.mock('../../../../server/sources/storage/db', async () => {
  const { createMachineAdmissionPersistenceBoundary } = await import('../../../../server/sources/app/api/testkit/machineAdmissionPersistenceBoundary');
  return { db: createMachineAdmissionPersistenceBoundary('user-1').db };
});
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('../../../../ui/sources/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('../../../../ui/sources/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('../../../../ui/sources/text', async () => {
  const { createTextModuleMock } = await import('../../../../ui/sources/dev/testkit/mocks/text');
  return createTextModuleMock();
});
vi.mock('../../../../ui/sources/components/ui/text/Text', async () => {
  const { createUiTextModuleMock } = await import('../../../../ui/sources/dev/testkit/mocks/uiText');
  return createUiTextModuleMock();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

// Distinct valid one-pixel PNGs model a changing X11 display, not native damage detection.
const images = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
] as const;
const desktopFrame = (data: string) => ({ content: [{ type: 'image', mimeType: 'image/png', data }],
  structuredContent: { display: 'primary', capture_id: 'desktop-capture', screenshot_width: 1, screenshot_height: 1,
    screen_width: 1, screen_height: 1, scale_factor: 1 } });

describe.skipIf(process.platform !== 'linux')('Computer capture through the server relay and viewer', () => {
  it('renders a second changed native frame after the viewer acknowledges the first', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const { machineLiveStreamRelayHandler } = await import('../../../../server/sources/app/api/socket/machineLiveStreamRelayHandler');
    const second = deferred<ReturnType<typeof desktopFrame>>();
    const later = deferred<ReturnType<typeof desktopFrame>>();
    const started = deferred<void>();
    let startResult: Awaited<ReturnType<ReturnType<typeof createMachineLiveStreamRelayTerminator>['start']>> | undefined;
    let captures = 0;
    native.call.mockImplementation(async ({ name }) => {
      if (name === 'check_permissions') return { structuredContent: { x11: true, xsend_event: true } };
      if (name === 'get_desktop_state') {
        captures += 1;
        return captures === 1 ? desktopFrame(images[0]) : captures === 2 ? second.promise : later.promise;
      }
      throw new Error(`Unexpected native method ${name}`);
    });
    const source = createComputerCaptureSource({ sessionId: 'computer-relay',
      target: { kind: 'display', displayId: ':99' }, executablePath: '/managed/cua-driver' });
    const jobs: Array<() => void | Promise<unknown>> = [];
    const received: MachineLiveStreamRelayEnvelopeV1[] = [];
    const listeners = new Set<(envelope: unknown) => void>();
    const transportErrors: unknown[] = [];
    const viewerSocket = createFakeSocket({ id: 'computer-viewer', data: { clientType: 'user-scoped' } });
    const sourceSocket = createFakeSocket({ id: 'computer-source', data: { clientType: 'machine-scoped',
      machineId: 'machine-source', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID } });
    const daemon = createMachineLiveStreamRelayTerminator({ machineId: 'machine-source', captureAdapter: source.adapter,
      nowMs: Date.now, emitEnvelope(envelope) {
        jobs.push(async () => {
          const sealed = await sealMachineLiveStreamEnvelopeV1(envelope, { mode: 'plain' });
          if (!sealed.ok) throw new Error(sealed.code);
          await getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(MachineLiveStreamRelayEnvelopeV1Schema.parse(sealed.value));
        });
      } });
    const socketTransport = createMachineLiveStreamSocketTransport({
      isCurrent: () => true, resolveContent: async () => ({ mode: 'plain' }), onError: error => transportErrors.push(error),
      emit: envelope => { jobs.push(async () => getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(envelope)); },
      deliver(envelope) { received.push(envelope); for (const listener of listeners) listener(envelope); },
    });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const now = Date.now();
    const payload = { v: 1 as const, grantId: 'computer-relay-grant', accountId: 'user-1',
      sourceMachineId: 'machine-source', targetMachineId: 'machine-source', viewerSocketId: viewerSocket.id,
      flowKind: 'live_stream' as const, routeKind: 'server_relay' as const, streamId: 'computer-stream',
      streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1' as const, iat: now, exp: now + 60_000,
      aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 };
    const request: MachineLiveStreamStartRequestV1 = { v: 1, streamId: payload.streamId, streamFamily: 'screen',
      sourceId: source.sourceId, routeKind: 'server_relay', sourceMachineId: payload.sourceMachineId,
      targetMachineId: payload.targetMachineId, viewerSocketId: viewerSocket.id, codecId: 'image.frame.v1',
      authorization: { payload, signature: { keyId: 'computer-relay-key', alg: 'Ed25519',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload)), keys.secretKey)).toString('base64url') } } };
    const context: Parameters<typeof machineLiveStreamRelayHandler>[2] = {
      io: { to: (room: string) => ({ emit: (_event: string, raw: unknown) => {
        const envelope = MachineLiveStreamRelayEnvelopeV1Schema.parse(raw);
        if (room === viewerSocket.id) jobs.push(() => socketTransport.receive(envelope));
        else jobs.push(() => { expect(daemon.applyControl(MachineLiveStreamDecodedEnvelopeV1Schema.parse(envelope))).toEqual({ ok: true }); });
      } }) },
      resolveAccountEncryptionMode: async () => 'plain', serverRoutedLiveStreamEnabled: true, relayCaps: {},
      relayAuthorizationTrustRoots: [{ keyId: 'computer-relay-key', publicKeyBase64Url: Buffer.from(keys.publicKey).toString('base64url') }],
      verifyViewerSocketOwnership: async ({ socketId }) => socketId === viewerSocket.id,
    };
    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], context);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], context);
    const transport: SimulatorRelayTransport = { send: (_event, envelope) => socketTransport.send(envelope),
      onEnvelope(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    function Viewer() {
      const state = useSimulatorRelayIngestion({ transport, sourceMachineId: payload.sourceMachineId,
        targetMachineId: payload.targetMachineId, viewerSocketId: viewerSocket.id, simulatorId: source.sourceId,
        sourceId: source.sourceId, streamId: request.streamId, streamFamily: 'screen', caps: {}, sourceCodecs: ['image.frame.v1'],
        startProduction: async () => ({ ok: true, routeKind: 'server_relay', startRequest: request, relayAuthorization: request.authorization! }),
        startDaemonRelay: async () => {
          const result = await daemon.start(request);
          startResult = result;
          started.resolve();
          return result;
        } });
      const player = state.playerStatesBySimulatorId[source.sourceId];
      return player ? <LiveStreamPlayer state={player} testID="computer-player" statusOwnedByHost /> : null;
    }
    async function flushDelivery() {
      await act(async () => {
        while (jobs.length) await jobs.shift()!();
        await flushHookEffects({ cycles: 2, turns: 2 });
      });
    }
    const screen = await renderScreen(<Viewer />);
    try {
      await act(async () => { await started.promise; });
      expect(startResult).toEqual({ ok: true, streamId: request.streamId });
      await flushDelivery();
      await flushDelivery();
      expect({ received: received.map(envelope => envelope.message.kind), sourceErrors: sourceSocket.emit.mock.calls,
        tree: screen.tree.toJSON() }).toMatchObject({
        received: expect.arrayContaining(['frame']), sourceErrors: [],
      });
      expect(screen.findHostByTestId('computer-player-frame')?.props.source).toEqual({ uri: `data:image/jpeg;base64,${images[0]}` });
      await act(async () => {
        second.resolve(desktopFrame(images[1]));
        await flushHookEffects({ cycles: 2, turns: 2 });
      });
      await flushDelivery();
      await flushDelivery();
      expect(screen.findHostByTestId('computer-player-frame')?.props.source).toEqual({ uri: `data:image/jpeg;base64,${images[1]}` });
      expect(received.filter(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'image_keyframe')).toHaveLength(2);
      expect(transportErrors).toEqual([]);
      expect(sourceSocket.emit.mock.calls).toEqual([]);
      // A metadata frame can overtake the image's ack; the latest ack still admits capture.
      for (const call of viewerSocket.emit.mock.calls) expect(call).toEqual(['rpc-error', {
        type: 'machine-live-stream', error: 'stale_live_stream_ack',
      }]);
    } finally {
      await screen.unmount();
      await daemon.dispose();
      second.resolve(desktopFrame(images[1]));
      later.resolve(desktopFrame(images[1]));
      await source.close();
      await getSocketHandler(sourceSocket, 'disconnect')();
      await getSocketHandler(viewerSocket, 'disconnect')();
    }
  });
});
