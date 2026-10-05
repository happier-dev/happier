import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createScmCapabilities, sealEncryptedDataKeyEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { encodeBase64 } from '@/api/encryption';
import { encryptStoredSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('Session-backed SCM owner workspace', () => {
  const sessionId = 'c111111111111111111111111';
  const machineKey = new Uint8Array(32).fill(17);
  const encryptedCredentials = { token: 'scm-owner-token', encryption: {
    type: 'dataKey', publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey, machineKey,
  } } satisfies StoredCredentials;

  const cases = ['plain', 'e2ee', 'e2eeSession', 'layout0', 'absent', 'modeMismatch', 'wrongKey'] as const;
  it.each(cases)('reads the authenticated owner workspace (%s) before real SCM dispatch', async (scenario) => {
    await withTempDir('scm-owner-workspace-', async (workspace) => {
      const encrypted = scenario === 'e2ee' || scenario === 'e2eeSession' || scenario === 'wrongKey';
      const accountMode = encrypted || scenario === 'modeMismatch' ? 'e2ee' : 'plain';
      const credentials: StoredCredentials = encrypted ? encryptedCredentials : { token: 'scm-owner-token', encryption: null };
      const ownerMetadata = { v: 1 as const, workspace: { path: workspace } };
      const sessionKey = new Uint8Array(32).fill(21);
      const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: scenario === 'e2eeSession' ? 'e2ee' : 'plain', share: null,
        dataEncryptionKey: scenario === 'e2eeSession' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
          dataKey: sessionKey, recipientPublicKey: encryptedCredentials.encryption.publicKey,
          randomBytes: (length) => new Uint8Array(length).fill(22),
        })) : null,
        ...(scenario === 'layout0' ? { metadata: JSON.stringify({ path: workspace }) } : {
          metadataLayoutVersion: 1, metadata: scenario === 'e2eeSession' ? encryptStoredSessionPayload({
            mode: 'e2ee', ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' }, payload: { v: 1 },
          }) : JSON.stringify({ v: 1 }),
          ownerMetadata: scenario === 'absent' ? undefined : encrypted
            ? sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata,
              material: { type: 'dataKey', machineKey: scenario === 'wrongKey' ? new Uint8Array(32).fill(19) : machineKey },
              randomBytes: (length) => new Uint8Array(length).fill(20),
            }) : { t: 'plain' as const, v: ownerMetadata },
        }),
      });
      const sessionResponse = V2SessionByIdResponseSchema.parse({ session: rawSession });
      // HTTP is the boundary. Account mode, envelope opening, workspace admission,
      // Action dispatch and the saved-result filesystem reader all remain real.
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const href = String(url);
        const data = href.endsWith('/v1/account/encryption/currentness')
          ? { mode: accountMode, version: 1, signingKeyFingerprint: accountMode === 'e2ee' ? 'a'.repeat(64) : null,
              contentKeyFingerprint: accountMode === 'e2ee' ? 'b'.repeat(64) : null, updatedAt: 1 }
          : href.includes(`/sessions/${sessionId}`) ? sessionResponse : null;
        if (!data) throw new Error(`Unexpected test HTTP request ${href}`);
        return { data, status: 200 };
      });
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId, mode: 'plain', ctx: null, scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
      }));
      const result = await executor.execute('scm.diffSummary.result.read', {
        // Session Actions must use their owner workspace even when a different cwd is supplied.
        cwd: '/unrelated/input-worktree', resultId: '11111111-1111-4111-8111-111111111111',
      }, { surface: 'cli', defaultSessionId: sessionId });
      expect(result).toMatchObject(scenario === 'plain' || scenario === 'e2ee' || scenario === 'e2eeSession' || scenario === 'layout0'
        ? { ok: true, result: { success: false, errorCode: 'result_not_found' } }
        : { ok: false, errorCode: 'scm_action_worktree_unavailable' });
    });
  });
});

describe('exact-machine SCM Action targeting', () => {
  it('admits machine saved inventory without a fabricated directory and refuses a Session-wide inventory', async () => {
    const calls: unknown[] = [];
    const inventory = { success: true, results: [], count: 0, bytes: 0,
      sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => { calls.push({ method, request }); return inventory; } },
    }));
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result: inventory });
    expect(calls).toEqual([{ method: 'scm.diffSummary.result.list', request: {} }]);
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      defaultSessionId: 'session', externalActionTarget: { kind: 'session', sessionId: 'session' },
    })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    expect(calls).toHaveLength(1);
  });
  it('uses the admitted machine transport and exact directory without requiring a Session', async () => {
    const calls: Array<Readonly<{ method: string; request: unknown; signal?: AbortSignal }>> = [];
    const signal = new AbortController().signal;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token',
      sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'selected-machine',
        // The injected boundary is the authenticated exact-daemon transport.
        invoke: async (method, request, options) => {
          calls.push({ method, request, signal: options?.signal });
          return { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' };
        },
      },
    }));

    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'selected-machine' }, signal,
    })).resolves.toEqual({ ok: true, result: { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' } });
    expect(calls).toEqual([{ method: 'scm.pullRequest.list', request: { cwd: '/chosen/worktree', outcomeVersion: 1 }, signal }]);
  });

  it('does not reuse an admitted transport for a different machine or infer a directory', async () => {
    let invoked = false;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'admitted-machine',
        invoke: async () => { invoked = true; return { success: true }; },
      },
    }));
    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'different-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    await expect(executor.execute('scm.pullRequest.list', {}, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'admitted-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(invoked).toBe(false);
  });

  it('capability-negotiates advanced mutation options at the exact selected target before dispatch', async () => {
    const cases = [
      { id: 'scm.commit.undoLast', input: { cwd: '/repo', expectedHeadOid: 'a'.repeat(40) }, bits: { writeCommitUndoLast: true }, capability: 'writeCommitUndoLast' },
      { id: 'scm.remote.push', input: { cwd: '/repo', dirtyPolicy: 'autostash' }, bits: { writeRemotePolicies: true }, capability: 'writeRemotePolicies' },
      { id: 'scm.remote.push', input: { cwd: '/repo', remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) }, bits: { writeRemoteForceWithLease: true }, capability: 'writeRemoteForceWithLease' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Amend', mode: 'amend' }, bits: { writeCommitAmend: true }, capability: 'writeCommitAmend' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Sign off', signOff: true }, bits: { writeCommitSignOff: true }, capability: 'writeCommitSignOff' },
    ] as const;
    for (const item of cases) {
      for (const capabilities of [undefined, createScmCapabilities(), createScmCapabilities(item.bits)]) {
        const methods: string[] = [];
        const executor = createActionExecutor(createCliActionDeps({ token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'target', invoke: async (method) => {
            methods.push(method);
            return method === 'scm.backend.describe' ? { success: true, ...(capabilities ? { capabilities } : {}) } : { success: true };
          } },
        }));
        const result = await executor.execute(item.id, item.input, {
          surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'target' },
          actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { [item.id]: ['rpc'] } },
        });
        const supported = capabilities?.[item.capability] === true;
        expect(result).toMatchObject({ ok: true, result: supported ? { success: true } : { success: false, errorCode: 'FEATURE_UNSUPPORTED', outcome: { kind: 'failed' } } });
        expect(methods).toEqual(supported ? ['scm.backend.describe', item.id] : ['scm.backend.describe']);
      }
    }
  });
});
