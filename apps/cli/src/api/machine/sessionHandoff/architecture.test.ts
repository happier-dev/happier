import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
    hasUnsupportedWorkspaceAction,
} from './workspaceSyncGuard';

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

const RETIRED_WORKSPACE_TRANSFER_CORRIDOR_TOKENS = [
    'SessionHandoffWorkspaceTransferSchema',
    'SessionHandoffWorkspaceTransferStrategySchema',
    'SessionHandoffConflictPolicySchema',
    'type SessionHandoffWorkspaceTransfer,',
    'type SessionHandoffWorkspaceReplicationManifestTransferPublication,',
    'SessionHandoffWorkspaceReplicationManifestTransferPublicationSchema',
    'workspaceReplicationSourceRootPath',
    'workspaceReplicationHandoffBackTargetRootPath',
    // Rejecting the retired input by name is valid; declaring it is not.
    'workspaceReplicationManifestTransferPublication:',
    'workspaceReplicationSourceControllerMetadata',
    'workspaceReplicationReverseSourceRootPath',
    'workspaceReplicationReverseTargetRootPath',
] as const;

const PUBLIC_HANDOFF_PROTOCOL_SOURCES = [
    '../../../../../../packages/protocol/src/sessions/control/handoff/handoffTypes.ts',
    '../../../../../../packages/protocol/src/sessions/control/handoff/handoffSchemas.ts',
    '../../../../../../packages/protocol/src/sessions/control/handoff/handoffStatus.ts',
    '../../../../../../packages/protocol/src/sessions/control/handoff/handoffRpc.ts',
    '../../../../../../packages/protocol/src/index.ts',
] as const;

const LOCAL_HANDOFF_METADATA_PRODUCTION_SOURCES = [
    '../../../daemon/sessions/createDaemonSessionHandoffMetadataBridge.ts',
    '../../../daemon/sessions/createLoadLocalSessionMetadataForHandoff.ts',
    '../../../daemon/sessions/buildHandoffSessionMetadataFromTrackedSession.ts',
    '../../../daemon/spawn/resolveSpawnBackendIdentity.ts',
    '../../../daemon/startup/prepareExecuteSpawnSessionRequest.ts',
    '../../../daemon/startup/executeSpawnSessionRequest.ts',
    '../../../daemon/startup/startDaemonSessionControlRuntime.ts',
    '../../../daemon/machine/bootstrapMachineSyncRuntime.ts',
    '../../../daemon/startup/createDaemonMachineBootstrapRuntime.ts',
    '../../../daemon/startDaemon.ts',
    '../../../session/handoff/metadata/localSessionHandoffMetadataStore.ts',
    '../rpcHandlers.ts',
    '../../apiMachine.ts',
    './handlers.ts',
] as const;

const RETIRED_LOCAL_HANDOFF_METADATA_TOKENS = [
    'savePreparedTargetLocalMetadata',
    'loadLocalHandoffMetadataByVendorResumeId',
    'localExportMetadataOverlay',
    'sessionHandoffMetadataV1',
] as const;

describe('sessionHandoff architecture', () => {
    it('keeps the retired workspace transfer corridor out of the public handoff protocol surface', async () => {
        for (const relativeSource of PUBLIC_HANDOFF_PROTOCOL_SOURCES) {
            const source = await readFile(new URL(relativeSource, import.meta.url), 'utf8');
            for (const token of RETIRED_WORKSPACE_TRANSFER_CORRIDOR_TOKENS) {
                expect(source.includes(token), `${relativeSource} must not declare retired token ${token}`).toBe(false);
            }
        }
    });

    it('keeps the retired vendor-resume handoff overlay out of the daemon runtime', async () => {
        for (const relativeSource of LOCAL_HANDOFF_METADATA_PRODUCTION_SOURCES) {
            const source = await readFile(new URL(relativeSource, import.meta.url), 'utf8');
            for (const token of RETIRED_LOCAL_HANDOFF_METADATA_TOKENS) {
                expect(source.includes(token), `${relativeSource} must not contain retired token ${token}`).toBe(false);
            }
        }
    });

    it('keeps the boundary-local retired corridor detectors returning typed update-required', () => {
        const retiredTransferRequest = {
            handoffId: 'handoff_retired',
            workspaceTransfer: { enabled: true, strategy: 'sync_changes', conflictPolicy: 'replace_existing' },
        };
        expect(hasUnsupportedWorkspaceAction(retiredTransferRequest)).toBe(true);
        expect(hasUnsupportedWorkspaceAction({
            handoffId: 'handoff_retired_reverse',
            workspaceReplicationReverseSourceRootPath: '/repo/source',
            workspaceReplicationReverseTargetRootPath: '/repo/target',
        })).toBe(true);

        expect(hasUnsupportedWorkspaceAction({
            handoffId: 'handoff_released_reverse',
            mode: 'source_cleanup',
            workspaceReplicationReverseSourceRootPath: '/repo/source',
            workspaceReplicationReverseTargetRootPath: '/repo/target',
        })).toBe(true);
    });

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
