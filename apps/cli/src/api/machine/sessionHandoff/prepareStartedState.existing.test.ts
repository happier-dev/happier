import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { prepareStartedState } from './prepareStartedState';
import { buildStartPendingStatus } from './prepareTargetState';

describe('handoff existing native state source custody', () => {
  it.each([['source', 'target'], ['source', 'source']])('retains a source record without exporting or publishing native bytes (%s to %s)', async (sourceMachineId, targetMachineId) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-existing-source-'));
    try {
      const nativePath = join(activeServerDir, 'native-state');
      await writeFile(nativePath, 'incumbent native bytes');
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      const result = await prepareStartedState({ activeServerDir,
        callInput: { handoffId: 'existing', sourceStopState: 'already_inactive', metadata: { path: '/source/project' },
          request: { sessionId: 'session', sourceMachineId, targetMachineId, stateTransfer: 'existing',
            targetPath: '/target/project', workspaceAction: { kind: 'none' }, sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer' },
        }, sourceExportStore,
        exportSessionBundle: async () => { throw new Error('No-transfer handoff attempted native export'); },
        directPeerTransfer: { publishTransfer: () => { throw new Error('No-transfer handoff published native bytes'); }, clearPublishedTransfer: () => undefined },
        buildStartPendingStatus,
      });
      expect(result.targetPath).toBe('/target/project');
      expect(result.endpointCandidates).toEqual([]);
      expect(result.nextState.handoffMetadataV2).toBeUndefined();
      expect(await sourceExportStore.load('existing')).toMatchObject({ sessionId: 'session', stateTransfer: 'existing' });
      expect((await sourceExportStore.load('existing'))?.agentBundle).toBeUndefined();
      expect(await readFile(nativePath, 'utf8')).toBe('incumbent native bytes');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
