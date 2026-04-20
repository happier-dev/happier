import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_HANDOFF_RPC_HANDLER_TOKENS = [
    'DAEMON_SESSION_HANDOFF_COMMIT',
    'applyWorkspaceReplicationPlan',
    'createWorkspaceReplicationTransfers',
    // Legacy/deleted session handoff workspace artifacts wrapper (must not be reintroduced).
    'session/handoff/workspace/sessionHandoffWorkspaceArtifacts',
    'exportWorkspaceArtifacts',
    'workspaceExportArtifacts',
] as const;

const FORBIDDEN_PREPARE_TARGET_WORKFLOW_TOKENS = [
    'SessionHandoffPrepareTargetRequestSchema.safeParse',
    'resolvePrepareTargetDirectPeerMetadataPreflight(',
    'resolvePrepareTargetBootstrap(',
    'resolvePrepareTargetResponseAfterBootstrap(',
    'invalidRequest()',
    "negotiatedTransportStrategy === 'direct_peer'",
    'sourceExportStore.load(parsed.data.handoffId)',
    'missingHandoffMetadataV2()',
    'waitForPrepareJobFastPath(runJob)',
    "bootstrap.kind === 'response'",
    'bootstrap.response',
    'const timedOutJob = await prepareJobStore.read(jobId);',
    'completedJob?.prepareTargetResult',
    'readPersistedPrepareJob(',
    'buildPrepareJobId(',
    'buildPrepareJobRecord(',
    'buildPreparePendingStatus(',
    'runSessionHandoffPrepareTargetJob(',
    'activePrepareJobs.has(',
    'activePrepareJobs.get(',
    'activePrepareJobs.set(',
    'prepareJobStore.write(',
    'restartPrepareTargetJobFromPersistedRequest',
] as const;

describe('sessionHandoff architecture', () => {
    it('keeps workspace replication engine plumbing out of the RPC handler', async () => {
        const sourcePath = new URL('./handlers.ts', import.meta.url);
        const source = await readFile(sourcePath, 'utf8');

        for (const token of FORBIDDEN_SESSION_HANDOFF_RPC_HANDLER_TOKENS) {
            expect(source).not.toContain(token);
        }
    });

    it('keeps prepare-target response resolution out of the workflow orchestration shell', async () => {
        const sourcePath = new URL('./prepareTargetWorkflow.ts', import.meta.url);
        const source = await readFile(sourcePath, 'utf8');

        for (const token of FORBIDDEN_PREPARE_TARGET_WORKFLOW_TOKENS) {
            expect(source).not.toContain(token);
        }
    });
});
