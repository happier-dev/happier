import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import {
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  SessionMetadataTuplePatchV1Schema,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  decodeExternalActionResolvedTargetV1,
  projectSessionAccessCapabilitiesV1,
  type ActionExecutorContext,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { encodeBase64 } from '@/api/encryption';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createRequesterSessionStopEffect } from './requesterSessionStop';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { readSessionMetadataTupleWriterSnapshot } from '@/session/metadata/updateSessionMetadataWithRetry';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { retireExactTerminalControlServiceability } from '@/daemon/sessions/retireTerminalControlServiceability';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

describe('createRequesterSessionStopEffect', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the admitted transition purpose for source resolution and the native Stop', async () => {
    const sessionId = 'cmwlgfetg00vo5jmcd04fj6zb';
    const target = { kind: 'session' as const, sessionId };
    const keys = tweetnacl.sign.keyPair();
    const authorization = {
      token: 'signed-root',
      binding: { actionId: 'session.agent.transition', requestId: 'transition-request',
        serverIdentityId: 'home-1', accountId: 'member', machineId: 'machine-1',
        installationId: 'installation-1', target },
    } as unknown as ExternalActionExecutionAuthorizationV1;
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user',
      actionRequestId: 'transition-request', externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    const requester = { authorization, credentials: { token: 'requester-token', encryption: null },
      serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true } as unknown as RequesterAccountActionContext;
    const rawSession = createSessionRecordFixture({ id: sessionId, machineId: 'machine-1', encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo' }) });
    const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: rawSession } });
    const physicalStop = vi.fn(async () => ({ status: 'stopped' as const }));
    const stop = createRequesterSessionStopEffect({ requester, purpose: { kind: 'external_action' },
      machineId: 'machine-1', installation: { installationId: 'installation-1', privateKey: encodeBase64(keys.secretKey, 'base64url') },
      stopSession: physicalStop });

    await expect(stop({ sessionId, stopIntent: 'lifecycle_control', context })).resolves.toMatchObject({ stopped: true });
    expect(physicalStop).toHaveBeenCalledOnce();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    for (const [, config] of reads.mock.calls) {
      expect(config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(authorization.binding.actionId);
    }
  });

  it.each([
    ['session.delete', 'plain', 'session'], ['session.delete', 'e2ee', 'session'],
    ['session.sections.archive', 'plain', 'session'], ['session.sections.archive', 'e2ee', 'session'],
    ['session.stop', 'plain', 'machine'], ['session.archive', 'plain', 'machine'],
  ] as const)('records and retires a %s local Stop with its admitted target (%s Account)', async (rootActionId, mode, targetKind) => {
    const sessionId = 'cmwlgfetg00vo5jmcd04fj6zb';
    const machineTarget = { kind: 'machine' as const, machineId: 'machine-1' };
    const keys = tweetnacl.sign.keyPair();
    const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const credentials = { token: 'requester-token', encryption: mode === 'plain' ? null : encryption };
    const crypto = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption });
    const currentness = {
      mode, version: 1, signingKeyFingerprint: null, updatedAt: 1,
      contentKeyFingerprint: mode === 'plain' ? null
        : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(crypto.contentPublicKeyFingerprint),
    };
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: mode, storedContentMode: 'plain',
      metadata: { path: '/repo', machineId: machineTarget.machineId, lifecycleState: 'running',
        terminal: { mode: 'tmux', controlServiceabilityV1: { v: 1, attachmentId: 'voice-runner', state: 'servable', observedAt: 1 } } },
      agentState: null });
    let rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      share: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    // Boundary fixture: the admitted root fields used by the real installed signer.
    const authorization = { token: 'signed-root', binding: { actionId: rootActionId, requestId: 'clear-request',
      serverIdentityId: 'home-1', accountId: 'member', machineId: machineTarget.machineId,
      installationId: 'installation-1', accountEncryptionMode: mode, target: machineTarget } } as unknown as ExternalActionExecutionAuthorizationV1;
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionRequestId: 'clear-request',
      externalActionExecutionAuthorization: authorization, externalActionTarget: machineTarget };
    const requester = { authorization, credentials, serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
    } as unknown as RequesterAccountActionContext;
    // HTTP is the boundary: retain real resolution, tuple opening/sealing, Stop orchestration and signing.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      throw new Error(`Unexpected Stop HTTP read: ${path}`);
    });
    const signedPatches: { effect: unknown; target: unknown }[] = [];
    vi.spyOn(axios, 'patch').mockImplementation(async (url, body, config) => {
      expect(new URL(String(url)).pathname).toBe(`/v2/sessions/${sessionId}`);
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner') throw new Error('Expected the existing owner tuple');
      signedPatches.push({ effect: config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER],
        target: decodeExternalActionResolvedTargetV1(String(config?.headers?.[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER])) });
      rawSession = { ...rawSession, metadataVersion: patch.sharedMetadata.expectedVersion + 1,
        metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: rawSession.metadataVersion }, agentState: { version: rawSession.agentStateVersion } } };
    });
    const stop = createRequesterSessionStopEffect({ requester, purpose: { kind: 'external_action' },
      machineId: machineTarget.machineId, installation: { installationId: 'installation-1', privateKey: keys.secretKey },
      // Only physical process exit is replaced; publication uses the real retirement owner.
      stopSession: async (id, options, _resume, recordExplicitIntent) => {
        await recordExplicitIntent();
        await retireExactTerminalControlServiceability({ ...options.metadataContext!, credentials, sessionId: id,
          attachmentId: 'voice-runner', terminalMode: 'tmux', stoppedAt: 1234 });
        return { status: 'stopped' };
      } });
    const result = await stop({ sessionId, stopIntent: 'explicit_stop', context });
    const stopTarget = targetKind === 'session' ? { kind: 'session', sessionId } : machineTarget;
    expect(signedPatches).toEqual([
      { effect: 'session.stop', target: stopTarget },
      { effect: 'session.stop', target: stopTarget },
    ]);
    expect(result).toMatchObject({ ok: true, stopped: true });
    const metadata = readSessionMetadataTupleWriterSnapshot({ credentials, rawSession,
      accountEncryptionCurrentness: { ...currentness, recipientEnvelopeReadiness: mode === 'plain'
        ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } } }).value.metadata;
    expect(readSessionExplicitStopV1FromMetadata(metadata)).toMatchObject({ requestId: 'clear-request' });
    expect(metadata).toMatchObject({ lifecycleState: 'stopped', lifecycleStateSince: 1234 });
    expect(context.externalActionTarget).toBe(machineTarget);
    expect(context.externalActionExecutionAuthorization).toBe(authorization);
    expect(authorization.binding).toMatchObject({ actionId: rootActionId, target: machineTarget });
    expect(rawSession.ownerMetadata?.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
  });
  it.each([
    ['session.stop', 'session.stop'],
    ['session.archive', 'session.stop'],
    ['session.delete', 'session.stop'],
    ['session.sections.archive', 'session.stop'],
  ] as const)(
    'signs the received native Stop of a %s root as its admitted %s phase',
    async (rootActionId, effect) => {
      // MACH-PRINCIPAL-AUDIT-1116: Home admits the hosted Stop as the session.stop
      // phase, so its reads and owner-tuple retirement must carry that effect.
      const keys = tweetnacl.sign.keyPair();
      const target = { kind: 'session' as const, sessionId: 'hosted-session' };
      // Boundary fixture: only the binding fields the local header signer reads.
      const authorization = {
        token: 'signed-root',
        binding: {
          actionId: rootActionId,
          requestId: 'request-1',
          serverIdentityId: 'home-1',
          accountId: 'member',
          machineId: 'machine-1',
          installationId: 'installation-1',
          target,
        },
      } as unknown as ExternalActionExecutionAuthorizationV1;
      const requester = {
        authorization,
        credentials: { token: 'member-token', encryption: null },
        serverHttpBaseUrl: 'https://home.test',
        isCurrent: async () => true,
      } as unknown as RequesterAccountActionContext;
      const signedEffects: unknown[] = [];
      const stop = createRequesterSessionStopEffect({
        requester,
        purpose: {
          kind: 'machine_rpc',
          method: RPC_METHODS.STOP_SESSION,
          params: { sessionId: target.sessionId },
        },
        machineId: 'machine-1',
        installation: {
          installationId: 'installation-1',
          privateKey: keys.secretKey,
        },
        // The physical process Stop is the boundary; it observes the headers its retirement PATCH would carry.
        stopSession: async (sessionId, options) => {
          const headers =
            options.metadataContext?.resolveAuthorizationHeaders?.({
              method: 'PATCH',
              path: `/v2/sessions/${sessionId}`,
              body: { mode: 'owner' },
            });
          signedEffects.push(headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]);
          return { status: 'stopped' } as never;
        },
      });
      await stop({
        sessionId: target.sessionId,
        stopIntent: 'explicit' as never,
        context: {
          surface: 'cli',
          authority: 'present_user',
          externalActionExecutionAuthorization: authorization,
          externalActionTarget: target,
        } as never,
      });
      expect(signedEffects).toEqual([effect]);
    },
  );
});
