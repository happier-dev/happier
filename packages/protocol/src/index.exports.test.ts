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
});
