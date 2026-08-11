import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    RuntimeIdleAdmission,
    SessionRuntimeActivityProjection,
    SessionRuntimeActivitySnapshot,
} from './index.js';

import * as protocol from './index.js';

describe('protocol package root exports', () => {
    it('exports the unsuffixed session runtime activity contracts', () => {
        expectTypeOf<SessionRuntimeActivityProjection>().not.toBeNever();
        expectTypeOf<SessionRuntimeActivitySnapshot>().not.toBeNever();
        expectTypeOf<RuntimeIdleAdmission>().not.toBeNever();

        expect(protocol.SessionRuntimeActivitySnapshotSchema.parse({
            state: 'idle',
            activeCount: 0,
        })).toEqual({ state: 'idle', activeCount: 0 });
        expect(protocol.decideRuntimeIdleAdmission({
            state: 'idle',
            activeCount: 0,
            observedAt: 1,
            revision: 3,
        })).toEqual({ decision: 'allow', revision: 3 });
    });

    it('exports independent session capability thresholds', () => {
        expect(protocol.SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY).toBe(2);
        expect(protocol.PENDING_INPUT_PROTOCOL_VERSION_V1).toBe(1);
        expect(protocol.CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).toBe(426);
    });

    it('exports scm commit limits and operation codes for CLI consumers', () => {
        expect(protocol.SCM_COMMIT_MESSAGE_MAX_LENGTH).toBe(4096);
        expect(protocol.SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY).toBe('NOT_REPOSITORY');
        expect(typeof protocol.evaluateScmRemoteMutationPolicy).toBe('function');
        expect(typeof protocol.inferScmRemoteTarget).toBe('function');
        expect(typeof protocol.mapGitScmErrorCode).toBe('function');
        expect(typeof protocol.mapSaplingScmErrorCode).toBe('function');
        expect(typeof protocol.normalizeScmRemoteRequest).toBe('function');
    });

    it('exports automation change/update schemas through root exports', () => {
        expect(protocol.ChangeKindSchema.parse('automation')).toBe('automation');
        const parsed = protocol.UpdateBodySchema.parse({
            t: 'automation-upsert',
            automationId: 'auto_1',
            version: 1,
            enabled: true,
            updatedAt: Date.now(),
        });
        expect(parsed.t).toBe('automation-upsert');
    });

    it('exports execution run streaming schemas', () => {
        expect(typeof (protocol as any).ExecutionRunTurnStreamStartRequestSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamStartV2RequestSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunUserTranscriptDirectiveSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunUserTranscriptCommitRequestSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamReadResponseSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamCancelRequestSchema).toBe('object');
    });

    it('exports session transcript and events action input schemas', () => {
        expect(typeof (protocol as any).SessionTranscriptGetInputSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionEventsGetInputSchema?.safeParse).toBe('function');
    });

    it('exports review triage overlay schemas for execution-run consumers', () => {
        expect(typeof (protocol as any).ReviewTriageOverlaySchema?.safeParse).toBe('function');
        const parsed = (protocol as any).ReviewTriageOverlaySchema.safeParse({
            findings: [{ id: 'f1', status: 'accept' }],
        });
        expect(parsed.success).toBe(true);
    });

    it('exports bug report routing defaults', () => {
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_OWNER).toBe('happier-dev');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_REPO).toBe('happier');
        expect(protocol.BUG_REPORT_DEFAULT_ISSUE_LABELS).toEqual(['bug']);
        expect(typeof protocol.normalizeBugReportProviderUrl).toBe('function');
        expect(typeof protocol.normalizeBugReportIssueSlug).toBe('function');
        expect(typeof protocol.resolveBugReportServerDiagnosticsLines).toBe('function');
        expect(typeof protocol.searchBugReportSimilarIssues).toBe('function');

        const url = protocol.buildBugReportFallbackIssueUrl({
            title: 'Example',
            body: 'Body',
            owner: '',
            repo: '',
        });
        expect(url).toContain('https://github.com/happier-dev/happier/issues/new?');
    });

    it('exports daemon execution run schemas for machine-wide run listing', () => {
        expect(typeof (protocol as any).DaemonExecutionRunMarkerSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonExecutionRunListResponseSchema?.safeParse).toBe('function');
    });

    it('exports daemon terminal schemas for embedded terminal surfaces', () => {
        expect(typeof (protocol as any).DaemonTerminalEnsureRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonTerminalStreamReadResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonTerminalStreamEventSchema?.safeParse).toBe('function');
    });

    it('exports daemon MCP servers schemas', () => {
        expect(typeof (protocol as any).DaemonMcpServersTestRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersTestResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersDetectRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonMcpServersDetectResponseSchema?.safeParse).toBe('function');
    });

    it('exports pet package and daemon RPC schemas', () => {
        expect((protocol as any).PET_ATLAS_V1?.width).toBe(1536);
        expect(typeof (protocol as any).PetPackageManifestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).PetPackageSourceV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonPetDiscoverRequestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonPetImportResponseV1Schema?.safeParse).toBe('function');
    });

    it('exports direct sessions daemon RPC schemas', () => {
        expect(typeof (protocol as any).DirectSessionsProviderIdSchema?.safeParse).toBe('function');
        expect((protocol as any).DirectSessionsProviderIdSchema.parse('codex')).toBe('codex');
        expect((protocol as any).DirectSessionsProviderIdSchema.parse('claude')).toBe('claude');
        expect((protocol as any).DirectSessionsProviderIdSchema.parse('opencode')).toBe('opencode');
        expect(typeof (protocol as any).DirectSessionsCandidatesListRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectTranscriptPageRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectTranscriptReadAfterRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionLinkEnsureRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionTakeoverRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionTakeoverPersistRequestSchema?.safeParse).toBe('function');
    });

    it('exports session handoff schemas', () => {
        expect(typeof (protocol as any).SessionHandoffStartRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffPrepareTargetRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffStatusSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).TransferChunkEnvelopeSchema?.safeParse).toBe('function');
    });

    it('exports final session turn schemas', () => {
        expect(typeof (protocol as any).SessionTurnV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionTurnMutationV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionTurnsProjectionV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionTurnMutationReceiptV1Schema?.safeParse).toBe('function');
        expect((protocol as any).SessionTurnLedgerV1Schema).toBeUndefined();
        expect((protocol as any).SessionTurnLedgerMutationV1Schema).toBeUndefined();
    });

    it('exports session folder schemas', () => {
        expect(typeof (protocol as any).SessionFoldersV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionFolderWorkspaceRefV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionFolderAssignmentRequestSchema?.safeParse).toBe('function');
    });

    it('exports session organization schemas', () => {
        expect(typeof (protocol as any).SessionOrganizationSnapshotRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationSnapshotResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationPinSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationFolderSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationTagSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationOrderEntrySchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionOrganizationLabelSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionPinRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ReorderSessionOrganizationRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).CreateOrUpdateSessionOrganizationFolderRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationFolderRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).CreateOrUpdateSessionOrganizationTagRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationTagRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SetSessionTagAssignmentsRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).UpsertSessionOrganizationLabelRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DeleteSessionOrganizationLabelRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ImportLegacySessionOrganizationRequestSchema?.safeParse).toBe('function');
    });

    it('does not export the removed sync-only workspace replication RPC surface', () => {
        expect((protocol as any).WorkspaceReplicationEndpointSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationDiffSummarySchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationRemoteStagingModeSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationOperationIdSchema).toBeUndefined();
        expect((protocol as any).WorkspaceSyncModeSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationScanRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationDiffResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationBaselineReadResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationStageRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationApplyResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationCommitResponseSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationAbortRequestSchema).toBeUndefined();
        expect((protocol as any).WorkspaceReplicationCoordinatorDiagnosticReasonSchema).toBeUndefined();
    });

    it('exports connected service account group request policy schemas', () => {
        expect(protocol.ConnectedServiceProfileIdSchema.parse('work')).toBe('work');
        expect(protocol.ConnectedServiceAuthGroupPolicyPatchV1Schema.parse({
            autoSwitch: true,
            switchOn: { usageLimit: false },
        })).toEqual({
            autoSwitch: true,
            switchOn: { usageLimit: false },
        });
        expect(typeof (protocol as any).SessionUsageLimitRecoveryOperationResultV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).normalizeSessionUsageLimitRecoveryOperationResultV1).toBe('function');
        expect(typeof (protocol as any).normalizeMachineHomeDir).toBe('function');
        expect(typeof (protocol as any).isSameMachineLocality).toBe('function');
    });

    it('exports account encryption migrate schemas', () => {
        expect(protocol.AccountEncryptionMigrateInvalidParamsReasonSchema.parse('restore_required')).toBe('restore_required');
        const parsed = protocol.AccountEncryptionMigrateBadRequestResponseSchema.parse({
            error: 'invalid-params',
            reason: 'key_proof_required',
        });
        expect(parsed.error).toBe('invalid-params');
    });

    it('exports backend profile schemas and helpers', () => {
        expect(typeof (protocol as any).AIBackendProfileSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SavedSecretSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).getBuiltInBackendProfile).toBe('function');
        expect(Array.isArray((protocol as any).DEFAULT_BUILT_IN_BACKEND_PROFILES)).toBe(true);
        expect(typeof (protocol as any).resolveBackendProfile).toBe('function');
        expect(typeof (protocol as any).isProfileCompatibleWithAgent).toBe('function');
        expect(typeof (protocol as any).getRequiredSecretEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getRequiredConfigEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getMissingRequiredConfigEnvVarNames).toBe('function');
        expect(typeof (protocol as any).getProfileEnvironmentVariables).toBe('function');
    });

    it('exports ACP catalog settings schemas', () => {
        expect(typeof (protocol as any).AcpCatalogSettingsV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).AcpBackendDefinitionV1Schema?.safeParse).toBe('function');
    });

    it('exports configured ACP backend legacy aliases', () => {
        expect(typeof (protocol as any).AcpConfiguredBackendV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildAcpConfiguredBackendV1).toBe('function');
        expect(typeof (protocol as any).readAcpConfiguredBackendV1FromMetadata).toBe('function');
    });

    it('exports backend target schemas and helpers', () => {
        expect(typeof (protocol as any).BackendTargetRefSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildBackendTargetKey).toBe('function');
        expect((protocol as any).buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review' })).toBe('acpBackend:review');
    });

    it('exports session work-state and provider app-server schemas', () => {
        expect(typeof (protocol as any).SessionWorkStateV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).mergeSessionWorkStateV1).toBe('function');
        expect(typeof (protocol as any).mergeSessionWorkStateMetadataV1).toBe('function');
        expect(typeof (protocol as any).readDisplayableSessionWorkStateV1).toBe('function');
        expect(typeof (protocol as any).normalizeCodexAppServerGoalToSessionWorkStateItem).toBe('function');
        expect(typeof (protocol as any).normalizeOpenCodeSessionTodosToWorkStateItems).toBe('function');
        expect(typeof (protocol as any).normalizeClaudeTaskEventToWorkStateItem).toBe('function');
        expect(typeof (protocol as any).SessionWorkStateGetResponseV1Schema?.safeParse).toBe('function');
    });

    it('exports the agent-activity vocabulary and its boundary adapters', () => {
        expect(protocol.AGENT_ACTIVITY_STATUSES_V1).toContain('timedOut');
        expect(protocol.AGENT_ACTIVITY_TONES_V1).toContain('attention');
        expect(protocol.AGENT_ACTIVITY_KINDS_V1).toEqual(['workflow_run', 'workflow_agent']);
        expect(protocol.resolveAgentActivityTone('waiting')).toBe('attention');
        expect(protocol.fromExecutionRunStatus('timeout')).toBe('timedOut');
        expect(protocol.fromWorkflowRunStatus('stopped')).toBe('cancelled');
        expect(protocol.fromWorkflowAgentStatus('pending')).toBe('queued');
        expect(protocol.fromSubagentStatus('terminated')).toBe('cancelled');
    });

    it('exports the agent-activity headline, its metadata key and the shared headline ordering owner', () => {
        expect(protocol.SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY).toBe('sessionAgentActivityHeadlineV1');
        expect(typeof protocol.SessionAgentActivityEntryV1Schema?.safeParse).toBe('function');
        expect(typeof protocol.SessionAgentActivityHeadlineV1Schema?.safeParse).toBe('function');
        expect(typeof protocol.buildSessionAgentActivityHeadline).toBe('function');
        expect(typeof protocol.readSessionAgentActivityHeadlineFromMetadata).toBe('function');
        // The shared ordering/bounding owner both headline builders call (PLAN 3.1).
        expect(typeof protocol.partitionActivityHeadlineEntries).toBe('function');

        const headline = protocol.buildSessionAgentActivityHeadline({
            backendId: 'claude',
            updatedAt: 2,
            entries: [{ entryId: 'workflow_run:wf_1', kind: 'workflow_run', title: 'run', status: 'running', updatedAt: 1 }],
        });
        expect(protocol.readSessionAgentActivityHeadlineFromMetadata({
            [protocol.SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: headline,
        })?.primaryEntryId).toBe('workflow_run:wf_1');
    });

    it('exports connected-service settings schemas without the undeployed Codex-specific setting', () => {
        expect(typeof (protocol as any).ConnectedServicesDefaultAuthByAgentIdV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ConnectedServicesProviderStateSharingSettingsV1Schema?.safeParse).toBe('function');
        expect((protocol as Record<string, unknown>).ConnectedServicesCodexHomeSharingSettingsV1Schema).toBeUndefined();
    });
});
