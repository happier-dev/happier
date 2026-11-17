import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import { BrowserEventBatchV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { createBrowserSidecarCdpControlAdapterFactory } from '../sidecar/controlAdapterFactory';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createBrowserCdpScreencastProducer } from './cdpScreencast';
import { registerBrowserLiveCapture } from './registration';
import tweetnacl from 'tweetnacl';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createMachineLiveStreamRelayAuthorizationSigningInputV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

describe('human browser input relay', () => {
  it('admits only the controlling human viewer and current epoch through real relay, service and CDP wiring', async () => {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const transport = {
      openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
      dispatchPageCommand: async (command: (typeof commands)[number]) => {
        commands.push(command);
        return command.method === 'Runtime.evaluate' ? { result: { value: 'selected text' } } : {};
      },
      dispatchBrowserCommand: async () => ({ success: true }),
      subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
    };
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport }),
    });
    const result = await factory({ machineId: 'machine' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.contextCapture) return;
    const contextCapture = result.contextCapture;
    const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
      transport: createControlAdapterAutomationTransport({ adapter: result.adapter, contextCapture }),
    }) });
    const producer = createBrowserCdpScreencastProducer({ contextCapture });
    const registry = createMachineLiveStreamCaptureRegistry();
    const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
    const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
    const keys = tweetnacl.sign.keyPair();
    const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine', nowMs: Date.now,
      accountId: 'account', sourceMachineInstallationId: 'installation', resolveRelayAuthorizationTrustRoots: () => [
        { keyId: 'home', publicKey: Buffer.from(keys.publicKey).toString('base64url') },
      ],
      emitEnvelope: envelope => {
        envelopes.push(envelope);
        if (envelope.message.kind === 'frame') relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'machine',
          message: { kind: 'control', control: { v: 1, streamId: envelope.message.frame.streamId, kind: 'ack', nextSequence: envelope.message.frame.sequence + 1 } } });
      } });
    const view = { browserSessionId: 'browser', viewId: 'view' };
    const sourceId = browserViewKey(view);
    const start = (streamId: string, authority: 'present_user' | 'account_automation') => {
      const source = registry.resolve({ sourceId });
      if (!source.ok || !source.source.sourceOccurrenceId) throw new Error('missing Browser source');
      const level: 'view' | 'edit' = streamId === 'readonly' ? 'view' : 'edit';
      const payload = { v: 2 as const, grantId: `grant:${streamId}`, accountId: 'account', flowKind: 'live_stream' as const, routeKind: 'server_relay' as const,
        sourceMachineId: 'machine', targetMachineId: 'machine', streamId, streamFamily: 'browser.streamed', sourceId, iat: Date.now(), exp: Date.now() + 60_000,
        aud: 'happier-live-stream-relay-authorization' as const, viewerSocketId: streamId,
        viewerAccountId: 'recipient', sourceMachineInstallationId: 'installation', personalSourceAdmission: {
          homeServerIdentityId: 'home', actorAccountId: 'recipient', streamFamily: 'browser.streamed', sourceId,
          sourceOccurrenceId: source.source.sourceOccurrenceId, sessionBrowserSessionId: 'session',
        }, sessionBrowserAccess: { kind: 'session.browser' as const, sessionId: 'session', actorAccountId: 'recipient',
          custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', effectiveAccess: {
            v: 1 as const, level, sources: [{ kind: 'direct' as const, shareId: 'share' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: level, canApprovePermissions: false }] }),
          } },
      };
      return relay.start({ v: 1, streamId, viewerSocketId: streamId,
      streamFamily: 'browser.streamed', sourceId, sourceMachineId: 'machine', targetMachineId: 'machine', routeKind: 'server_relay',
      authorization: { payload, signature: { keyId: 'home', alg: 'Ed25519', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload)), keys.secretKey)).toString('base64url') } } }, authority,
        createMachineContentCodec({ encryptionMode: 'plain' }));
    };
    const input = (streamId: string, controlEpoch: number, eventId: string) => relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'machine',
      message: { kind: 'sideband_control', control: { v: 1, streamId, sourceId, eventId, kind: 'browser_input', controlEpoch,
        event: { kind: 'wheel', target: 'page', x: 0.5, y: 0.25, deltaX: 12, deltaY: 240, sequence: 1 } } } });
    try {
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      expect(await start('readonly', 'present_user')).toMatchObject({ ok: true });
      // A view-only observer must not adopt the toolbar's human hold while the
      // input-capable presentation is still connecting.
      await automation.recordHumanInput({ ...view, authority: 'present_user' });
      for (const [stream, authority] of [['one', 'present_user'], ['two', 'present_user'], ['agent', 'account_automation']] as const) {
        expect(await start(stream, authority)).toMatchObject({ ok: true });
      }
      expect(automation.isViewerControlling({ ...view, viewerId: 'one' })).toBe(true);
      expect(automation.isViewerControlling({ ...view, viewerId: 'readonly' })).toBe(false);
      for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
        params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
      expect(envelopes.some(envelope => envelope.message.kind === 'frame' && envelope.message.frame.streamId === 'readonly'
        && envelope.message.frame.payloadKind === 'image_keyframe')).toBe(true);
      expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'machine', message: { kind: 'sideband_control', control: {
        v: 1, streamId: 'readonly', sourceId, eventId: 'view-keyframe', kind: 'request_keyframe',
      } } })).toEqual({ ok: true });
      expect(input('readonly', 0, 'forbidden-view-input')).toEqual({ ok: false, reasonCode: 'capture_source_denied' });
      expect(relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'machine', message: { kind: 'sideband_control', control: {
        v: 1, streamId: 'readonly', sourceId, eventId: 'legacy-view-input', kind: 'keyboard_text', text: 'forbidden',
      } } })).toEqual({ ok: false, reasonCode: 'capture_source_denied' });
      expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
      expect(input('agent', 0, 'agent')).toEqual({ ok: false, reasonCode: 'input_not_supported' });
      expect(input('one', automation.getStatus(view).controlEpoch, 'first')).toEqual({ ok: true });
      await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent'))
        .toContainEqual(expect.objectContaining({ params: expect.objectContaining({ type: 'mouseWheel', x: 200, y: 50, deltaX: 12, deltaY: 240 }) })));
      const epoch = automation.getStatus(view).controlEpoch;
      expect(input('two', epoch, 'other')).toEqual({ ok: false, reasonCode: 'viewer_not_controlling' });
      expect(input('one', epoch - 1, 'stale')).toEqual({ ok: false, reasonCode: 'stale_control' });
      const effectCount = commands.filter(command => command.method === 'Input.dispatchMouseEvent').length;
      expect(effectCount).toBe(1);
      for (const listener of [...listeners]) listener({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp-page', params: { type: 'prompt', message: 'private dialog' } });
      await vi.waitFor(() => expect(envelopes.some(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'metadata'
        && Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8').includes('private dialog'))).toBe(true));
      const privateFrames = envelopes.filter(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'metadata'
        && Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8').includes('private dialog'));
      expect(privateFrames.every(envelope => envelope.message.kind === 'frame' && envelope.message.frame.streamId !== 'agent')).toBe(true);
      for (const envelope of privateFrames) if (envelope.message.kind === 'frame') {
        expect(BrowserEventBatchV1Schema.safeParse(JSON.parse(Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8'))).success).toBe(true);
      }
      await automation.getInputControl(view).beginConfidentialityHold();
      const clipboardRequest = { v: 1 as const, ...view, automationRequestId: 'private-copy', navigationGeneration: 0,
        requestedBy: 'user' as const, requesterRef: { kind: 'streamViewer' as const, id: 'one' },
        actionKind: 'clipboardRead' as const, payload: {}, timeoutMs: 5_000 };
      expect(await automation.execute(clipboardRequest)).toMatchObject({ status: 'succeeded',
        interactionResult: { kind: 'clipboard', text: 'selected text' } });
      expect(await automation.execute({ ...clipboardRequest, automationRequestId: 'private-agent', requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' } })).toMatchObject({ status: 'failed', errorCode: 'policy_denied' });
    } finally { await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); await result.dispose?.(); }
  });
});
