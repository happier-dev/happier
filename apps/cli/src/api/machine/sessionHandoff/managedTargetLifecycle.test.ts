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

describe('managed handoff target lifecycle', () => {
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
