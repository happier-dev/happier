import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('protocol package root exports', () => {
    it('exports scm commit limits and operation codes for CLI consumers', () => {
        expect(protocol.SCM_COMMIT_MESSAGE_MAX_LENGTH).toBe(4096);
        expect(protocol.SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY).toBe('NOT_REPOSITORY');
        expect(typeof protocol.evaluateScmRemoteMutationPolicy).toBe('function');
        expect(typeof protocol.inferScmRemoteTarget).toBe('function');
        expect(typeof protocol.mapGitScmErrorCode).toBe('function');
        expect(typeof protocol.mapSaplingScmErrorCode).toBe('function');
        expect(typeof protocol.normalizeScmRemoteRequest).toBe('function');
    });

    it('exports SCM pull-request protocol schemas for downstream packets', () => {
        expect(typeof (protocol as any).ScmFollowupActionSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmPullRequestReferenceSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmPullRequestRunStackedResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmHostingProviderKindSchema?.safeParse).toBe('function');
        expect((protocol as any).ScmDefaultBranchPushPolicySchema.parse('requires-feature-branch'))
            .toBe('requires-feature-branch');
    });

    it('exports SCM repository provisioning protocol schemas for downstream packets', () => {
        expect(typeof (protocol as any).ScmRepositoryInitRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmRepositoryRemoveIndexLockRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmRepositoryProvisioningFailureResponseSchema?.safeParse)
            .toBe('function');
        expect(typeof (protocol as any).ScmHostingRepositoryPublishRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ScmHostingRepositoryPublishResponseSchema?.safeParse).toBe('function');
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
        expect(typeof (protocol as any).ExecutionRunTurnStreamReadResponseSchema).toBe('object');
        expect(typeof (protocol as any).ExecutionRunTurnStreamCancelRequestSchema).toBe('object');
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

    it('exports daemon voice inference schemas', () => {
        expect(typeof (protocol as any).DaemonVoiceInferenceStatusRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsSynthesizeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceModelsWarmRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsChunkRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceTtsFinalizeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttUploadInitRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttUploadFinalizeResponseSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DaemonVoiceInferenceSttTranscribeRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).ModelPackManifestSchema?.safeParse).toBe('function');
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
        expect((protocol as any).DirectSessionsProviderIdSchema.parse('ohMyPi')).toBe('ohMyPi');
        expect((protocol as any).DIRECT_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1.claudeConfig).toEqual(['claude']);
        expect(typeof (protocol as any).DirectSessionsCandidatesListRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectTranscriptPageRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectTranscriptReadAfterRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionLinkEnsureRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionFollowPolicySetRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionTakeoverRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).DirectSessionTakeoverPersistRequestSchema?.safeParse).toBe('function');
    });

    it('exports the canonical action id family catalog', () => {
        expect((protocol as any).ACTION_ID_FAMILIES_V1.intent_start).toEqual([
            'review.start',
            'subagents.plan.start',
            'subagents.delegate.start',
            'voice_agent.start',
        ]);
        expect((protocol as any).ACTION_IDS).toContain('approval.request.create');
    });

    it('exports session handoff schemas', () => {
        expect(typeof (protocol as any).SessionHandoffStartRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffPrepareTargetRequestSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).SessionHandoffStatusSchema?.safeParse).toBe('function');
        expect((protocol as any).SESSION_HANDOFF_PROGRESS_TIMELINES_V1.full).toEqual([
            'plan',
            'transfer_blobs',
            'stage_target',
            'apply',
            'import_session',
            'finalize',
        ]);
        expect(typeof (protocol as any).TransferChunkEnvelopeSchema?.safeParse).toBe('function');
        expect(Array.isArray((protocol as any).transferChunkEncryptionVectors)).toBe(true);
        expect(typeof (protocol as any).createDeterministicRandomBytesFromBase64).toBe('function');
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

    it('exports connected service profile id schema', () => {
        expect(protocol.ConnectedServiceProfileIdSchema.parse('work')).toBe('work');
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

    it('exports Live Activity remote update schemas', () => {
        expect((protocol as any).HAPPIER_FOCUS_LIVE_ACTIVITY_NAME).toBe('HappierFocusLiveActivity');
        expect(typeof (protocol as any).LiveActivityRemoteUpdateRequestV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).HappierFocusLiveActivityContentStateV1Schema?.safeParse).toBe('function');
        expect((protocol as any).LiveActivityRemoteTargetKindSchema.parse('expo_push_token')).toBe('expo_push_token');
        expect((protocol as any).LiveActivityRemoteTargetKindSchema.parse('activitykit_update_token'))
            .toBe('activitykit_update_token');
        expect(typeof (protocol as any).classifyLiveActivityApnsDeliveryResponse).toBe('function');
        expect(typeof (protocol as any).buildLiveActivityRemoteUpdateCapabilityDiagnostics).toBe('function');
        expect(typeof (protocol as any).resolveLiveActivityRemoteUpdateMode).toBe('function');
        expect((protocol as any).classifyLiveActivityApnsDeliveryResponse({
            status: 410,
            reason: 'Unregistered',
        })).toEqual({
            action: 'permanent_drop_target',
            reason: 'Unregistered',
        });
        expect((protocol as any).deriveLiveActivityApnsDeliveryFields({
            bundleId: 'dev.happier.app',
            activityId: 'activity-1',
            event: 'update',
            template: 'quietFocus',
            nowEpochSeconds: 1_000,
            quietHoursActive: false,
            alertRequested: true,
        }).priority).toBe(5);
    });

    it('exports configured ACP backend legacy aliases', () => {
        expect(typeof (protocol as any).AcpConfiguredBackendV1Schema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildAcpConfiguredBackendV1).toBe('function');
        expect(typeof (protocol as any).readAcpConfiguredBackendV1FromMetadata).toBe('function');
        expect(typeof (protocol as any).isLegacyConfiguredAcpFlavorCarrier).toBe('function');
    });

    it('keeps the agent-prefixed runtime-descriptor aliases out of the root export surface', () => {
        expect((protocol as any).AgentRuntimeDescriptorV1Schema).toBeUndefined();
        expect((protocol as any).readAgentRuntimeDescriptorV1).toBeUndefined();
        expect(typeof (protocol as any).LegacyAgentRuntimeDescriptorV1Schema?.safeParse).toBe('function');
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1).toBeUndefined();
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1FromMetadata).toBeUndefined();
        expect((protocol as any).readLegacyAgentRuntimeDescriptorV1ForProvider).toBeUndefined();
    });

    it('exports backend target schemas and helpers', () => {
        expect(typeof (protocol as any).BackendTargetRefSchema?.safeParse).toBe('function');
        expect(typeof (protocol as any).buildBackendTargetKey).toBe('function');
        expect((protocol as any).buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review' })).toBe('acpBackend:review');
    });

    it('exports the supported v1 hook handler target contract', () => {
        expect(Array.isArray(protocol.HookHandlerTargetsV1)).toBe(true);
        expect(protocol.HookHandlerTargetsV1).toEqual(['plugin']);
        expect(typeof (protocol as any).HookHandlerTargetV1Schema?.safeParse).toBe('function');
        expect(typeof protocol.isHookHandlerTargetV1).toBe('function');
    });
});
