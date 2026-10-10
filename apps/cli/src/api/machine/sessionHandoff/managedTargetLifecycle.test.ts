import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffCommitActionHandler } from './commit';
import { createSessionHandoffAbortActionHandler } from './abort';
import { buildPrepareJobRecord, buildSourceExportOnlyPrepareJobId, buildStartPendingStatus, invalidRequest, readPersistedPrepareJob } from './prepareTargetState';
import { createRequesterSessionCredentialCustody, requesterSessionCredentialPath } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

describe('managed handoff target lifecycle', () => {
  it('refuses signed predecessor abort without widening legacy route authority or touching native runners', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-signed-predecessor-abort-'));
    try {
      const sessionId = `c${'a'.repeat(24)}`;
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const status = { handoffId: 'signed-predecessor', jobId: 'prepare_signed-predecessor',
        status: 'ready_for_cutover' as const, phase: 'staging_target' as const, recoveryActions: [] };
      await store.write({ jobId: status.jobId, handoffId: status.handoffId, createdAtMs: 1, updatedAtMs: 1, status,
        prepareTargetResult: { handoffId: status.handoffId, status, remoteSessionId: 'same-native',
          directSource: { kind: 'claudeConfig', configDir: null, projectId: null }, resume: { directory: '/repo',
            agent: 'claude', resume: 'same-native', transcriptStorage: 'persisted', approvedNewDirectoryCreation: true } } });
      await store.upgradeReadyV1ToPreparedV2({ jobId: status.jobId, sessionId });
      await store.transitionPredecessorV2(status.jobId, current => ({ ...current, transitionRevision: current.transitionRevision + 1,
        updatedAtMs: 2, resume: { status: 'attempted', attemptId: 'owned-native-nonce', acceptedAtMs: 2 } }));
      const stopWitnesses: Array<string | undefined> = [];
      const manager = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain',
        // This is the authenticated Home ingress boundary, not a substitute for handoff domain logic.
        authorizeRequest: async () => ({ ok: true }), logger: () => undefined });
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager: manager, runtimeConfig: { activeServerDir },
        stopSessionForHandoff: async (id, options) => {
          expect(id).toBe(sessionId);
          stopWitnesses.push(options?.expectedSpawnNonce);
          return options?.expectedSpawnNonce === 'owned-native-nonce' ? 'stopped' : 'failed';
        } });
      const origin = { v: 1 as const, requestId: 'original-request', sourceTurnId: 'source-turn',
        caller: { kind: 'session' as const, sessionId, starterDepth: 1, turnDepth: 2 }, callerPermissionMode: 'read-only' as const };
      const request = { method: `target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2}`,
        params: { handoffId: status.handoffId, sessionId, reason: 'failed confirmation' }, callerAuthority: 'account_automation',
        sessionActionOrigin: origin, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'target',
          installationId: 'target-installation', role: 'use', encryptionMode: 'plain' },
        callerInputAuthorization: { v: 1, token: 'home-verified-child', binding: {
          accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', machineId: 'target',
          custodianAccountId: 'alice', installationId: 'target-installation', actionId: 'session.handoff.abort',
          requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'target' },
          sessionActionOrigin: origin, sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
          handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
            sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
          handoffContinuation: { handoffId: status.handoffId, rootRequestId: origin.requestId, rootRequestEnvelopeDigest: 'b'.repeat(43) },
        } } } as const;
      const mismatched = { ...request, callerInputAuthorization: { ...request.callerInputAuthorization,
        binding: { ...request.callerInputAuthorization.binding, handoffAdmission: {
          ...request.callerInputAuthorization.binding.handoffAdmission, sessionId: `c${'b'.repeat(24)}` } } } };
      expect(await manager.handleRequest(mismatched)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(stopWitnesses).toEqual([]);
      const response = await manager.handleRequest(request);
      expect(response).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(stopWitnesses).toEqual([]);
      expect(await store.findByHandoffId(status.handoffId)).toMatchObject({ terminal: { status: 'open' },
        resume: { status: 'attempted', attemptId: 'owned-native-nonce' } });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it.each(['stopped', 'failed', 'preexisting_unowned'] as const)('settles only the admitted target runner before requester custody release: %s', async stopResult => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-handoff-target-private-abort-'));
    try {
      const activeServerDir = join(happyHomeDir, 'server');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir, happyHomeDir });
      const binding = { happyHomeDir, sessionId: 'session', attribution: { serverId: 'home', accountId: 'bob',
        machineId: 'target', installationId: 'target-installation' } };
      await createRequesterSessionCredentialCustody({ ...binding, credentials: { token: 'target-private-bearer', encryption: null } });
      await sourceExportStore.save({ handoffId: 'handoff', sessionId: binding.sessionId, sourceMachineId: 'source',
        targetMachineId: 'target', exportedAtMs: 1, requesterSessionCredentialBinding: {
          sessionId: binding.sessionId, attribution: binding.attribution } });
      const status = { handoffId: 'handoff', jobId: 'prepare_handoff', status: 'ready_for_cutover' as const,
        phase: 'staging_target' as const, recoveryActions: [] };
      await prepareJobStore.write({ jobId: status.jobId, handoffId: status.handoffId, createdAtMs: 1, updatedAtMs: 1, status,
        prepareTargetResult: { handoffId: status.handoffId, status, remoteSessionId: 'same-native',
          directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
          resume: { directory: '/repo', agent: 'claude', resume: 'same-native', transcriptStorage: 'persisted',
            approvedNewDirectoryCreation: true } } });
      await prepareJobStore.upgradeReadyV1ToPreparedV2({ jobId: status.jobId, sessionId: binding.sessionId });
      await prepareJobStore.transitionPredecessorV2(status.jobId, current => ({ ...current, updatedAtMs: 2,
        transitionRevision: current.transitionRevision + 1,
        resume: stopResult === 'preexisting_unowned' ? { status: 'preexisting_unowned' }
          : { status: 'attempted', attemptId: 'admitted-spawn-nonce', acceptedAtMs: 2 } }));
      let stopped = false;
      const abort = createSessionHandoffAbortActionHandler({ activeServerDir, prepareJobStore, sourceExportStore,
        directPeerTransfer: undefined, readPersistedPrepareJob, buildPrepareJobRecord, buildStartPendingStatus,
        buildSourceExportOnlyPrepareJobId, invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined, invalidRequest,
        stopSessionForHandoff: async (sessionId: string, options?: Readonly<{ expectedSpawnNonce: string }>) => {
          expect(stopResult).not.toBe('preexisting_unowned');
          expect(sessionId).toBe(binding.sessionId);
          expect(options?.expectedSpawnNonce).toBe('admitted-spawn-nonce');
          // The physical stop boundary must settle while its ordinary credential still exists.
          await access(requesterSessionCredentialPath(binding));
          stopped = true;
          return stopResult === 'stopped' ? 'stopped' : 'failed';
        },
      });
      const result = await abort({ handoffId: status.handoffId, reason: 'target confirmation failed' });
      expect(stopped).toBe(stopResult !== 'preexisting_unowned');
      if (stopResult === 'stopped') {
        expect(result).toMatchObject({ status: { status: 'aborted' } });
        await expect(access(requesterSessionCredentialPath(binding))).rejects.toMatchObject({ code: 'ENOENT' });
      } else if (stopResult === 'failed') {
        expect(result).toMatchObject({ ok: false, errorCode: 'target_stop_failed' });
        await access(requesterSessionCredentialPath(binding));
      } else {
        expect(result).toMatchObject({ status: { status: 'aborted' } });
        await access(requesterSessionCredentialPath(binding));
      }
    } finally { await rm(happyHomeDir, { recursive: true, force: true }); }
  });
  it('aborts only its uncommitted allocation and preserves committed, source and fork files', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-target-lifecycle-'));
    try {
      const owner = createManagedSessionDirectories({ activeServerDir });
      const source = await owner.materializeForFreshSpawn({ sessionCreationTag: 'source-tag' });
      await owner.bind({ allocationId: source.allocationId, sessionId: 'session' });
      const child = await owner.materializeForFreshSpawn({ sessionCreationTag: 'fork-tag' });
      await owner.bind({ allocationId: child.allocationId, sessionId: 'child' });
      await writeFile(join(child.directory, 'keep.txt'), 'fork files');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      const deps = { activeServerDir, prepareJobStore, sourceExportStore, directPeerTransfer: undefined,
        readPersistedPrepareJob, buildPrepareJobRecord, buildStartPendingStatus, buildSourceExportOnlyPrepareJobId,
        invalidateDirectPeerRouteCacheForHandoffMachines: () => undefined, invalidRequest,
      };
      const ready = async (operationId: string, status: 'pending' | 'ready_for_cutover' = 'ready_for_cutover') => {
        const allocated = await owner.allocateForHandoff({ operationId, sessionId: 'session' });
        await prepareJobStore.write(buildPrepareJobRecord({ jobId: `prepare_${operationId}`, handoffId: operationId,
          createdAtMs: 1, status: { handoffId: operationId, status, phase: 'staging_target', recoveryActions: [] },
          prepareTargetRequest: { handoffId: operationId, operationId, sessionId: 'session', targetDirectory: { kind: 'managed' },
            sourceMachineId: 'a', targetMachineId: 'b', targetPath: '/untrusted', negotiatedTransportStrategy: 'server_routed_stream',
            sourceSessionStorageMode: 'persisted', endpointCandidates: [],
          },
        }));
        return allocated;
      };
      const committed = await ready('committed_operation');
      await writeFile(join(committed.directory, 'keep.txt'), 'committed files');
      expect(await createSessionHandoffCommitActionHandler(deps)({ handoffId: 'committed_operation', mode: 'target' })).toMatchObject({ status: { status: 'completed' } });
      expect(await createSessionHandoffAbortActionHandler(deps)({ handoffId: 'committed_operation', reason: 'late cancellation' })).toMatchObject({ status: { status: 'completed' } });
      expect(await readFile(join(committed.directory, 'keep.txt'), 'utf8')).toBe('committed files');
      const abandoned = await ready('abandoned_operation', 'pending');
      expect(await createSessionHandoffAbortActionHandler(deps)({ handoffId: 'abandoned_operation', reason: 'cancel operation' })).toMatchObject({ status: { status: 'aborted' } });
      await expect(access(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(source.directory)).resolves.toBeUndefined();
      expect(await readFile(join(child.directory, 'keep.txt'), 'utf8')).toBe('fork files');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
