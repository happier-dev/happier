import { describe, expect, expectTypeOf, it } from 'vitest';
import * as agents from '@happier-dev/agents';
import * as protocol from '@happier-dev/protocol';
import * as protocolRuntime from '@happier-dev/protocol/runtime';
import * as protocolTools from '@happier-dev/protocol/tools/v2';

import * as sessions from '../services/sessions.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import * as publicSessions from './index.js';
import type {
    CurrentSessionHandle as PublicCurrentSessionHandle,
    SessionMessageProvenanceV1 as PublicSessionMessageProvenanceV1,
    SessionSystemRecord as PublicSessionSystemRecord,
    SessionSystemRecordAddress as PublicSessionSystemRecordAddress,
    SessionSystemRecordDeleteRequest as PublicSessionSystemRecordDeleteRequest,
    SessionSystemRecordListQuery as PublicSessionSystemRecordListQuery,
    SessionSystemRecordPage as PublicSessionSystemRecordPage,
    SessionSystemRecordReadRequest as PublicSessionSystemRecordReadRequest,
    SessionSystemRecordReadRequestV1 as PublicSessionSystemRecordReadRequestV1,
    SessionSystemRecordReadResultV1 as PublicSessionSystemRecordReadResultV1,
    SessionSystemRecordRevision as PublicSessionSystemRecordRevision,
    SessionSystemRecordUpsertRequest as PublicSessionSystemRecordUpsertRequest,
    SessionSystemRecordWriteRequestV1 as PublicSessionSystemRecordWriteRequestV1,
} from './index.js';
import * as subagents from './subagents.js';
import * as workState from './workState.js';
import type {
    CurrentSessionHandle,
    SessionAuthService,
    SessionEvent,
    SessionHandle,
    SessionListQuery,
    SessionMcpElicitDecision,
    SessionMcpElicitRequest,
    SessionMcpElicitResult,
    SessionMcpService,
    SessionMediaPublishGeneratedRequest,
    SessionMediaService,
    SessionMediaSourceRoot,
    SessionMessagePart,
    SessionMessageProvenanceV1,
    SessionMessageRole,
    MentionRefV1,
    SessionPage,
    SessionPermissionDecision,
    SessionPermissionDecisionRequest,
    SessionPermissionDecisionResult,
    SessionPermissionFollowUpPromptDelivery,
    SessionPermissionFollowUpPromptIntent,
    SessionPermissionMode,
    SessionPermissionPersistAllowRule,
    SessionPermissionPersistAllowRuleScope,
    SessionPermissionsService,
    SessionRuntimeAuthRefreshResult,
    SessionRuntimeAuthServices,
    SessionRuntimeIssueV1,
    SessionSystemRecord,
    SessionSystemRecordAddress,
    SessionSystemRecordDeleteRequest,
    SessionSystemRecordListQuery,
    SessionSystemRecordPage,
    SessionSystemRecordReadRequest,
    SessionSystemRecordRevision,
    SessionSystemRecordUpsertRequest,
    SessionSendRequest,
    SessionSendResult,
    SessionStateCapabilitiesV1,
    SessionSummary,
    SessionUsageLimitRecoveryResumePromptModeV1,
    SessionUsageLimitRecoveryV1,
    SessionWatchEvent,
    SessionWatchQuery,
    SessionsService,
} from '../services/sessions.js';
import type {
    ExecutionRunProfileContribution,
    SubagentLifecycleDetailV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusV1,
} from './subagents.js';
import type {
    ActivitySessionSystemRecordKind,
    SessionWorkStateGoalCapabilitiesV1,
    SessionWorkStateItemV1,
    SessionWorkStateStatusV1,
    SessionWorkStateUnknownItemV1,
    SessionWorkStateV1,
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowAgentSnapshotV1,
    SessionWorkflowAgentStatusV1,
    SessionWorkflowPhaseSnapshotV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
    SessionWorkflowRunStatusReasonV1,
    SessionWorkflowRunStatusV1,
} from './workState.js';
import type {
    SubagentObservation,
    SubagentSummary,
    SubagentsService,
    WorkStateItem,
    WorkStatePublisher,
    WorkStateService,
    WorkStateTruncation,
} from '../runtime/index.js';

if (false) {
/* @sdk-negative-type-case:src-sessions-projections-test-ts-234:LS0gd2hvbGUtcmVjb3JkIG1ldGFkYXRhIG11dGF0aW9uIGlzIG5vdCBhbiBhdXRob3IgY2FwYWJpbGl0eS4:dHlwZSBSYXdNZXRhZGF0YVdyaXRlciA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5TZXNzaW9uTWV0YWRhdGFXcml0ZVJlcXVlc3Q7 */
type RawMetadataWriter = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-235:LS0gcmF3IEFnZW50IHN0YXRlIGlzIG5vdCBhbiBhdXRob3IgY2FwYWJpbGl0eS4:dHlwZSBSYXdBZ2VudFN0YXRlV3JpdGVyID0gaW1wb3J0KCcuLi9zZXJ2aWNlcy9zZXNzaW9ucy5qcycpLlNlc3Npb25BZ2VudFN0YXRlV3JpdGVSZXF1ZXN0Ow */
type RawAgentStateWriter = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-236:LS0gdW5yZXN0cmljdGVkIFByb3RvY29sIHN0YXRlLWZpZWxkIGlkcyByZW1haW4gaG9zdC1pbnRlcm5hbC4:dHlwZSBCcm9hZFN0YXRlRmllbGRJZCA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5TZXNzaW9uU3RhdGVGaWVsZElkOw */
type BroadStateFieldId = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-237:LS0gdW5yZXN0cmljdGVkIFByb3RvY29sIHN0YXRlLWZpZWxkIHZhbHVlcyByZW1haW4gaG9zdC1pbnRlcm5hbC4:dHlwZSBCcm9hZFN0YXRlRmllbGRWYWx1ZSA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5TZXNzaW9uU3RhdGVGaWVsZFZhbHVlOw */
type BroadStateFieldValue = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-238:LS0gb3duZXIvc2Vzc2lvbiBwcm9qZWN0aW9uIG1ldGFkYXRhIGlzIG5vdCBleHBvc2VkIGJ5IHRoZSBjYW5vbmljYWwgaGFuZGxlLg:dHlwZSBPd25lclByb2plY3Rpb24gPSBpbXBvcnQoJy4uL3NlcnZpY2VzL3Nlc3Npb25zLmpzJykuU2Vzc2lvbk93bmVyTWV0YWRhdGE7 */
type OwnerProjection = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-239:LS0gZXhhY3Qtb3duZXIgb3BlcmF0aW9uIHByb2dyZXNzIGlzIG5vdCBhIEdlbmVyYWwgU2Vzc2lvbnMgcHJvamVjdGlvbi4:dHlwZSBFeHRlcm5hbFByb2dyZXNzID0gaW1wb3J0KCcuLi9zZXJ2aWNlcy9zZXNzaW9ucy5qcycpLkV4dGVybmFsU2Vzc2lvbk9wZXJhdGlvblByb2dyZXNzVjE7 */
type ExternalProgress = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-240:LS0gZ2VuZXJhdGlvbi1wcml2YXRlIGZvbGxvdyBhdXRob3JpdHkgc3RheXMgb24gdGhlIENMSSBjb21wb3NpdGlvbiBwb3J0Lg:dHlwZSBQcml2YXRlRm9sbG93ID0gaW1wb3J0KCcuLi9zZXJ2aWNlcy9zZXNzaW9ucy5qcycpLkhvc3RFeHRlcm5hbFNlc3Npb25zU2VydmljZTs */
type PrivateFollow = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-241:LS0gdGhlIHByZWRlY2Vzc29yIGhvc3QtY2F0YWxvZyB3cml0ZSB2b2NhYnVsYXJ5IGlzIG5vdCB0aGUgYXV0aG9yIHJlY29yZCBBUEku:dHlwZSBMZWdhY3lTeXN0ZW1SZWNvcmRXcml0ZSA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5TZXNzaW9uU3lzdGVtUmVjb3JkV3JpdGVSZXF1ZXN0Ow */
type LegacySystemRecordWrite = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-242:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgY29tbWFuZCBEVE9zIGFyZSBub3QgcGFydCBvZiB0aGUgZmluYWwgU2Vzc2lvbiByb290Lg:dHlwZSBMZWdhY3lTdWJhZ2VudENvbXBsZXRlID0gaW1wb3J0KCcuL2luZGV4LmpzJykuU3ViYWdlbnRDb21wbGV0ZVBhcmFtc1YxOw */
type LegacySubagentComplete = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-243:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgbG9va3VwIERUT3MgYXJlIG5vdCBwYXJ0IG9mIHRoZSBmaW5hbCBTZXNzaW9uIHJvb3Qu:dHlwZSBMZWdhY3lTdWJhZ2VudEdldCA9IGltcG9ydCgnLi9pbmRleC5qcycpLlN1YmFnZW50R2V0UGFyYW1zVjE7 */
type LegacySubagentGet = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-244:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgbGlzdCBEVE9zIGFyZSBub3QgcGFydCBvZiB0aGUgZmluYWwgU2Vzc2lvbiByb290Lg:dHlwZSBMZWdhY3lTdWJhZ2VudExpc3QgPSBpbXBvcnQoJy4vaW5kZXguanMnKS5TdWJhZ2VudExpc3RQYXJhbXNWMTs */
type LegacySubagentList = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-245:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgbXV0YXRpb24gRFRPcyBhcmUgbm90IHBhcnQgb2YgdGhlIGZpbmFsIFNlc3Npb24gcm9vdC4:dHlwZSBMZWdhY3lTdWJhZ2VudFN0YXR1c1VwZGF0ZSA9IGltcG9ydCgnLi9pbmRleC5qcycpLlN1YmFnZW50U3RhdHVzVXBkYXRlUGFyYW1zVjE7 */
type LegacySubagentStatusUpdate = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-246:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgd2F0Y2ggZXZlbnRzIGFyZSBub3QgcGFydCBvZiB0aGUgZmluYWwgU2Vzc2lvbiByb290Lg:dHlwZSBMZWdhY3lTdWJhZ2VudFdhdGNoRXZlbnQgPSBpbXBvcnQoJy4vaW5kZXguanMnKS5TdWJhZ2VudFdhdGNoRXZlbnRWMTs */
type LegacySubagentWatchEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-247:LS0gcHJlZGVjZXNzb3IgU3ViYWdlbnQgd2F0Y2ggcGFyYW1ldGVycyBhcmUgbm90IHBhcnQgb2YgdGhlIGZpbmFsIFNlc3Npb24gcm9vdC4:dHlwZSBMZWdhY3lTdWJhZ2VudFdhdGNoUGFyYW1zID0gaW1wb3J0KCcuL2luZGV4LmpzJykuU3ViYWdlbnRXYXRjaFBhcmFtc1YxOw */
type LegacySubagentWatchParams = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-248:LS0gcmF3IHBlcnNpc3RlZCBTZXNzaW9uIG1ldGFkYXRhIHJlbWFpbnMgUHJvdG9jb2wtb3duZWQgYW5kIGhvc3QtaW50ZXJuYWwu:dHlwZSBSYXdTZXNzaW9uTWV0YWRhdGEgPSBpbXBvcnQoJy4uL3NlcnZpY2VzL3Nlc3Npb25zLmpzJykuU2Vzc2lvbk1ldGFkYXRhOw */
type RawSessionMetadata = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-249:LS0gdGhlIGNvbXBhdGliaWxpdHkgbWV0YWRhdGEgY2FycmllciBpcyBub3QgYW4gYXV0aG9yIFNlc3Npb24gcHJvamVjdGlvbi4:dHlwZSBSYXdSdW50aW1lRGVzY3JpcHRvckNhcnJpZXIgPSBpbXBvcnQoJy4uL3NlcnZpY2VzL3Nlc3Npb25zLmpzJykuUnVudGltZURlc2NyaXB0b3JNZXRhZGF0YUNhcnJpZXI7 */
type RawRuntimeDescriptorCarrier = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-250:LS0gcGVyc2lzdGVkIHJ1bnRpbWUgZGVzY3JpcHRvcnMgYXJlIG5vdCBhbiBhdXRob3IgU2Vzc2lvbiBwcm9qZWN0aW9uLg:dHlwZSBSYXdSdW50aW1lRGVzY3JpcHRvciA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5SdW50aW1lRGVzY3JpcHRvclYxOw */
type RawRuntimeDescriptor = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-251:LS0gcGVyc2lzdGVkIGhhbmRvZmYgcmVjb3ZlcnkgcGxhbnMgcmVtYWluIFByb3RvY29sLW93bmVkLg:dHlwZSBSYXdIYW5kb2ZmUmVzdW1lUGxhbiA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5TZXNzaW9uSGFuZG9mZlJlc3VtZVBsYW47 */
type RawHandoffResumePlan = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-252:LS0gdW5yZXN0cmljdGVkIEFnZW50IHN0YXRlIHVwZGF0ZXMgYXJlIG5vdCBhbiBhdXRob3IgU2Vzc2lvbiBjYXBhYmlsaXR5Lg:dHlwZSBSYXdTZXNzaW9uU3RhdGVVcGRhdGUgPSBpbXBvcnQoJy4uL3NlcnZpY2VzL3Nlc3Npb25zLmpzJykuU2Vzc2lvblN0YXRlVXBkYXRlVjE7 */
type RawSessionStateUpdate = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-253:LS0gbWF0ZXJpYWxpemVkIHJlY2lwaWVudCByZXF1ZXN0cyBiZWxvbmcgdG8gdGhlIHJlY2lwaWVudC1vcGVyYXRpb24gb3duZXIu:dHlwZSBSYXdNYXRlcmlhbGl6ZWRSZWNpcGllbnRSZXF1ZXN0ID0gaW1wb3J0KCcuLi9zZXJ2aWNlcy9zZXNzaW9ucy5qcycpLk1hdGVyaWFsaXplZFJlY2lwaWVudE9wZXJhdGlvblJlcXVlc3RWMTs */
type RawMaterializedRecipientRequest = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-254:LS0gcmVjaXBpZW50IG9wZXJhdGlvbnMgYmVsb25nIHRvIHRoZSByZWNpcGllbnQtb3BlcmF0aW9uIG93bmVyLg:dHlwZSBSYXdSZWNpcGllbnRPcGVyYXRpb24gPSBpbXBvcnQoJy4uL3NlcnZpY2VzL3Nlc3Npb25zLmpzJykuUmVjaXBpZW50T3BlcmF0aW9uVjE7 */
type RawRecipientOperation = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-255:LS0gdGhlIHByZWRlY2Vzc29yIHJhdyBTZXNzaW9uIHJlZmVyZW5jZSBpcyBkZWxldGVkLCBub3QgYWxpYXNlZC4:dHlwZSBSYXdQbHVnaW5TZXNzaW9uUmVmID0gaW1wb3J0KCcuL2luZGV4LmpzJykuUGx1Z2luU2Vzc2lvblJlZlYxOw */
type RawPluginSessionRef = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-projections-test-ts-256:LS0gdGhlIHJhdyBjb21wYXRpYmlsaXR5LW1ldGFkYXRhIHJlYWRlciBzdGF5cyBhdCB0aGUgUHJvdG9jb2wgb3duZXIu:dHlwZSBSYXdSdW50aW1lRGVzY3JpcHRvclJlYWRlciA9IHR5cGVvZiBpbXBvcnQoJy4vaW5kZXguanMnKS5yZWFkUnRpbWVEZXNjcmlwdG9yVjFGcm9tTWV0YWRhdGE7 */
type RawRuntimeDescriptorReader = never; /* @sdk-negative-type-case-end */
    void (null as unknown as RawMetadataWriter);
    void (null as unknown as RawAgentStateWriter);
    void (null as unknown as BroadStateFieldId);
    void (null as unknown as BroadStateFieldValue);
    void (null as unknown as OwnerProjection);
    void (null as unknown as ExternalProgress);
    void (null as unknown as PrivateFollow);
    void (null as unknown as LegacySystemRecordWrite);
    void (null as unknown as LegacySubagentComplete);
    void (null as unknown as LegacySubagentGet);
    void (null as unknown as LegacySubagentList);
    void (null as unknown as LegacySubagentStatusUpdate);
    void (null as unknown as LegacySubagentWatchEvent);
    void (null as unknown as LegacySubagentWatchParams);
    void (null as unknown as RawSessionMetadata);
    void (null as unknown as RawRuntimeDescriptorCarrier);
    void (null as unknown as RawRuntimeDescriptor);
    void (null as unknown as RawHandoffResumePlan);
    void (null as unknown as RawSessionStateUpdate);
    void (null as unknown as RawMaterializedRecipientRequest);
    void (null as unknown as RawRecipientOperation);
    void (null as unknown as RawPluginSessionRef);
    void (null as unknown as RawRuntimeDescriptorReader);
}

describe('General Sessions package-local projections', () => {
    it('re-exports canonical runtime values by identity', () => {
        expect(sessions.SessionMessageProvenanceV1Schema)
            .toBe(protocol.SessionMessageProvenanceV1Schema);
        expect(publicSessions.SessionMessageProvenanceV1Schema)
            .toBe(protocol.SessionMessageProvenanceV1Schema);
        expect(publicSessions.isNonSteerablePromptPayload)
            .toBe(agents.isNonSteerablePromptPayload);
        expect(publicSessions.parseSpecialCommand).toBe(agents.parseSpecialCommand);
        expect(sessions.CHANGE_TITLE_TOOL_NAME_ALIASES).toBe(protocolTools.CHANGE_TITLE_TOOL_NAME_ALIASES);
        expect(sessions.isChangeTitleToolNameAlias).toBe(protocolTools.isChangeTitleToolNameAlias);
        expect(sessions.HappierStructuredInputV1Schema).toBe(protocolRuntime.HappierStructuredInputV1Schema);
        expect(sessions.MentionRefV1Schema).toBe(protocolRuntime.MentionRefV1Schema);
        expect(sessions.readHappierStructuredInputV1FromMeta).toBe(protocolRuntime.readHappierStructuredInputV1FromMeta);
        expect(sessions.normalizeSessionAttachmentUploadPath)
            .toBe(protocolRuntime.normalizeSessionAttachmentUploadPath);
        expect(sessions.sanitizeHappierStructuredInputV1)
            .toBe(protocolRuntime.sanitizeHappierStructuredInputV1);
        expect(sessions.SPAWN_SESSION_ERROR_CODES).toBe(protocol.SPAWN_SESSION_ERROR_CODES);
        expect(sessions.SessionUsageLimitRecoveryV1Schema).toBe(protocol.SessionUsageLimitRecoveryV1Schema);
        expect(sessions.SessionRuntimeIssueV1Schema).toBe(protocol.SessionRuntimeIssueV1Schema);
        expect(sessions.isSlashCommandSupported).toBe(protocol.isSlashCommandSupported);
        expect(sessions.normalizeSlashCommandName).toBe(protocol.normalizeSlashCommandName);
        expect(sessions.readLeadingSlashCommandName).toBe(protocol.readLeadingSlashCommandName);
        expect(sessions.readSlashCommandNames).toBe(protocol.readSlashCommandNames);
        expect(sessions.resolveTranscriptBodySessionMessageRole).toBe(protocol.resolveTranscriptBodySessionMessageRole);
    });

    it('publishes opened Session System Records projections without stored envelopes', () => {
        for (const module of [sessions, publicSessions]) {
            expect('SessionSystemRecordJsonValueSchema' in module).toBe(false);
        }
    });

    it('keeps persisted structured mentions positionless', () => {
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
        };

        expect(sessions.MentionRefV1Schema.parse(mention)).toEqual(mention);
        expect(sessions.HappierStructuredInputV1Schema.parse({
            v: 1,
            mentions: [mention],
        }).mentions).toEqual([mention]);
    });

    it('does not publish raw Session persistence keys or whole-metadata readers', () => {
        for (const symbol of [
            'LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY',
            'SESSION_CONFIG_OPTION_OVERRIDES_KEY',
            'SESSION_CONFIG_OPTIONS_STATE_KEY',
            'SESSION_MODELS_STATE_KEY',
            'SESSION_MODES_STATE_KEY',
            'SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY',
        ]) {
            expect(symbol in sessions).toBe(false);
        }
    });

    it('does not publish cross-domain helpers from the Sessions owner', () => {
        expect('SecretStringV1Schema' in sessions).toBe(false);
        expect('registerSensitiveDiagnosticValues' in sessions).toBe(false);
        expect('zodSchemaToJsonSchemaObject' in sessions).toBe(false);
        expect('materializeRecipientOperationRequestV1' in sessions).toBe(false);
        expect('readRuntimeDescriptorV1FromMetadata' in sessions).toBe(false);
    });

    it('projects canonical Session contracts through local author types', () => {
        expectTypeOf<protocol.SessionMessageProvenanceV1>()
            .toMatchTypeOf<SessionMessageProvenanceV1>();
        expectTypeOf<PublicSessionMessageProvenanceV1>()
            .toEqualTypeOf<SessionMessageProvenanceV1>();
        expectTypeOf<SessionMessageRole>().toEqualTypeOf<protocol.SessionMessageRole>();
        expectTypeOf<MentionRefV1['start']>().toEqualTypeOf<unknown>();
        expectTypeOf<MentionRefV1['end']>().toEqualTypeOf<unknown>();
        expectTypeOf<protocol.SessionRuntimeIssueV1>().toMatchTypeOf<SessionRuntimeIssueV1>();
        expectTypeOf<protocol.SessionStateCapabilitiesV1>().toMatchTypeOf<SessionStateCapabilitiesV1>();
        expectTypeOf<SessionUsageLimitRecoveryResumePromptModeV1>()
            .toEqualTypeOf<protocol.SessionUsageLimitRecoveryResumePromptModeV1>();
        expectTypeOf<protocol.SessionUsageLimitRecoveryV1>()
            .toMatchTypeOf<SessionUsageLimitRecoveryV1>();
        expectTypeOf<SessionMcpElicitDecision>().toEqualTypeOf<agents.SessionMcpElicitDecisionV1>();
        expectTypeOf<SessionMcpElicitRequest>().toEqualTypeOf<agents.SessionMcpElicitRequestV1>();
        expectTypeOf<SessionMcpElicitResult>().toEqualTypeOf<agents.SessionMcpElicitResultV1>();
        expectTypeOf<SessionMcpService>().toEqualTypeOf<agents.SessionMcpServiceV1>();
        expectTypeOf<SessionPermissionDecision>().toEqualTypeOf<agents.SessionPermissionDecisionV1>();
        expectTypeOf<SessionPermissionDecisionRequest>().toEqualTypeOf<agents.SessionPermissionDecisionRequestV1>();
        expectTypeOf<SessionPermissionDecisionResult>().toEqualTypeOf<agents.SessionPermissionDecisionResultV1>();
        expectTypeOf<SessionPermissionFollowUpPromptDelivery>().toEqualTypeOf<agents.SessionPermissionFollowUpPromptDeliveryV1>();
        expectTypeOf<SessionPermissionFollowUpPromptIntent>().toEqualTypeOf<agents.SessionPermissionFollowUpPromptIntentV1>();
        expectTypeOf<SessionPermissionMode>().toEqualTypeOf<agents.SessionPermissionModeV1>();
        expectTypeOf<SessionPermissionPersistAllowRule>().toEqualTypeOf<agents.SessionPermissionPersistAllowRuleV1>();
        expectTypeOf<SessionPermissionPersistAllowRuleScope>().toEqualTypeOf<agents.SessionPermissionPersistAllowRuleScopeV1>();
        expectTypeOf<SessionPermissionsService>().toEqualTypeOf<agents.SessionPermissionsServiceV1>();
        expectTypeOf<SessionRuntimeAuthRefreshResult>().toEqualTypeOf<agents.SessionRuntimeAuthRefreshResultV1>();
        expectTypeOf<SessionRuntimeAuthServices>().toEqualTypeOf<agents.SessionRuntimeAuthServicesV1>();
        expectTypeOf<protocol.SessionSystemRecord>().toMatchTypeOf<SessionSystemRecord>();
        expectTypeOf<protocol.SessionSystemRecordAddress>().toMatchTypeOf<SessionSystemRecordAddress>();
        expectTypeOf<protocol.SessionSystemRecordDeleteRequest>()
            .toMatchTypeOf<SessionSystemRecordDeleteRequest>();
        expectTypeOf<protocol.SessionSystemRecordListQuery>()
            .toMatchTypeOf<SessionSystemRecordListQuery>();
        expectTypeOf<protocol.SessionSystemRecordPage>().toMatchTypeOf<SessionSystemRecordPage>();
        expectTypeOf<protocol.SessionSystemRecordReadRequest>()
            .toMatchTypeOf<SessionSystemRecordReadRequest>();
        expectTypeOf<protocol.SessionSystemRecordRevision>()
            .toMatchTypeOf<SessionSystemRecordRevision>();
        expectTypeOf<protocol.SessionSystemRecordUpsertRequest>()
            .toMatchTypeOf<SessionSystemRecordUpsertRequest>();
        expectTypeOf<PublicSessionSystemRecord>().toEqualTypeOf<SessionSystemRecord>();
        expectTypeOf<PublicSessionSystemRecordAddress>().toEqualTypeOf<SessionSystemRecordAddress>();
        expectTypeOf<PublicSessionSystemRecordDeleteRequest>().toEqualTypeOf<SessionSystemRecordDeleteRequest>();
        expectTypeOf<PublicSessionSystemRecordListQuery>().toEqualTypeOf<SessionSystemRecordListQuery>();
        expectTypeOf<PublicSessionSystemRecordPage>().toEqualTypeOf<SessionSystemRecordPage>();
        expectTypeOf<PublicSessionSystemRecordReadRequest>().toEqualTypeOf<SessionSystemRecordReadRequest>();
        expectTypeOf<PublicSessionSystemRecordRevision>().toEqualTypeOf<SessionSystemRecordRevision>();
        expectTypeOf<PublicSessionSystemRecordUpsertRequest>().toEqualTypeOf<SessionSystemRecordUpsertRequest>();
        expectTypeOf<PublicSessionSystemRecordReadRequestV1>()
            .toEqualTypeOf<agents.SessionSystemRecordReadRequestV1>();
        expectTypeOf<PublicSessionSystemRecordReadResultV1>()
            .toEqualTypeOf<agents.SessionSystemRecordReadResultV1>();
        expectTypeOf<PublicSessionSystemRecordWriteRequestV1>()
            .toEqualTypeOf<agents.SessionSystemRecordWriteRequestV1>();
        expectTypeOf<SessionHandle>().not.toHaveProperty('readMetadata');
        expectTypeOf<SessionHandle>().not.toHaveProperty('setDisplayTitle');
        expectTypeOf<SessionHandle['listSystemRecords']>().toEqualTypeOf<(
            query: SessionSystemRecordListQuery,
            options?: PluginCancellationOptions,
        ) => Promise<SessionSystemRecordPage>>();
        expectTypeOf<SessionHandle['upsertSystemRecord']>().toEqualTypeOf<(
            request: SessionSystemRecordUpsertRequest,
            options?: PluginCancellationOptions,
        ) => Promise<SessionSystemRecord>>();
        expectTypeOf<SessionHandle['readSystemRecord']>().toEqualTypeOf<(
            request: SessionSystemRecordReadRequest,
            options?: PluginCancellationOptions,
        ) => Promise<SessionSystemRecord | null>>();
        expectTypeOf<SessionHandle['deleteSystemRecord']>().toEqualTypeOf<(
            request: SessionSystemRecordDeleteRequest,
            options?: PluginCancellationOptions,
        ) => Promise<void>>();
        expectTypeOf<CurrentSessionHandle>().toHaveProperty('setDisplayTitle');
        expectTypeOf<PublicCurrentSessionHandle>().toEqualTypeOf<CurrentSessionHandle>();
        expectTypeOf<SessionHandle>().not.toHaveProperty('readAgentState');
        expectTypeOf<SessionHandle>().not.toHaveProperty('readStateField');
        expectTypeOf<SessionHandle>().not.toHaveProperty('writeStateField');
        expectTypeOf<SessionAuthService>().toHaveProperty('services');
        expectTypeOf<SessionEvent>().toMatchTypeOf<{ sequence: number }>();
        expectTypeOf<SessionMediaPublishGeneratedRequest>().toHaveProperty('localId');
        expectTypeOf<SessionMediaService>().toHaveProperty('registerSourceRoot');
        expectTypeOf<SessionMediaSourceRoot>().toHaveProperty('publishGenerated');
        expectTypeOf<SessionMessagePart>().toHaveProperty('kind');
        expectTypeOf<Extract<SessionSendRequest, { kind: 'userText' }>>().toMatchTypeOf<Readonly<{
            kind: 'userText';
            text: string;
            idempotencyKey: string;
        }>>();
        expectTypeOf<SessionSendResult>().toHaveProperty('status');
        expectTypeOf<SessionListQuery>().toEqualTypeOf<Readonly<{
            cursor?: string;
            limit?: number;
            machineId?: string;
            projectId?: string;
            state?: SessionSummary['state'];
        }>>();
        expectTypeOf<SessionPage>().toEqualTypeOf<Readonly<{
            items: readonly SessionSummary[];
            nextCursor?: string;
        }>>();
        expectTypeOf<SessionSummary>().toHaveProperty('id');
        expectTypeOf<SessionWatchEvent>().toHaveProperty('kind');
        expectTypeOf<SessionWatchQuery>().toHaveProperty('state');
        expectTypeOf<SessionsService>().toHaveProperty('current');
        expectTypeOf<SessionsService['current']>().toEqualTypeOf<CurrentSessionHandle | null>();
        expectTypeOf<Awaited<ReturnType<SessionsService['get']>>>().not.toHaveProperty('setDisplayTitle');
        expectTypeOf<SessionsService['list']>().toEqualTypeOf<(
            query?: SessionListQuery,
            options?: PluginCancellationOptions,
        ) => Promise<SessionPage>>();
    });
});

describe('nested Session package-local projections', () => {
    it('keeps Subagent service types on normal runtime while retaining corrected nested aliases', () => {
        expect(subagents.parseParticipantMessageV1).toBe(protocol.parseParticipantMessageV1);
        expect(subagents.parseSubagentCommandV1).toBe(protocol.parseSubagentCommandV1);
        expect(subagents.parseSubagentLaunchV1).toBe(protocol.parseSubagentLaunchV1);
        expect(subagents.isGenericSubagentToolName).toBe(protocolTools.isGenericSubAgentToolName);
        expectTypeOf<ExecutionRunProfileContribution>()
            .toEqualTypeOf<protocol.PluginExecutionRunProfileContributionV2>();
        expectTypeOf<SubagentLifecycleDetailV1>().toEqualTypeOf<agents.SubagentLifecycleDetailV1>();
        expectTypeOf<SubagentRefInputV1>().toEqualTypeOf<agents.SubagentRefInputV1>();
        expectTypeOf<SubagentRefV1>().toEqualTypeOf<agents.SubagentRefV1>();
        expectTypeOf<SubagentStatusV1>().toEqualTypeOf<agents.SubagentStatusV1>();
        expectTypeOf<SubagentObservation>().toHaveProperty('observationId');
        expectTypeOf<SubagentSummary>().toHaveProperty('id');
        expectTypeOf<SubagentsService>().toHaveProperty('observe');
    });

    it('keeps Work State service types on normal runtime and predecessor values on the Protocol owner', () => {
        expect(workState.ACTIVITY_SESSION_SYSTEM_RECORD_KINDS).toBe(protocol.ACTIVITY_SESSION_SYSTEM_RECORD_KINDS);
        expect(workState.SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE).toBe(protocol.SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE);
        expect(workState.SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION).toBe(protocol.SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION);
        expect(workState.SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX).toBe(protocol.SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX);
        expect(workState.SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX).toBe(protocol.SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX);
        expect(workState.SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX).toBe(protocol.SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX);
        expect(workState.boundSessionWorkStateItemsV1).toBe(protocol.boundSessionWorkStateItemsV1);
        expect(workState.buildSessionWorkflowActivityHeadline).toBe(protocol.buildSessionWorkflowActivityHeadline);
        expect(workState.buildWorkflowRunSystemRecordLocalId).toBe(protocol.buildWorkflowRunSystemRecordLocalId);
        expect(workState.bumpWorkflowRunRecordRevision).toBe(protocol.bumpWorkflowRunRecordRevision);
        expect(workState.isTerminalWorkflowRunStatus).toBe(protocol.isTerminalWorkflowRunStatus);
        expect(workState.isWorkflowRunSnapshotMaterialChange).toBe(protocol.isWorkflowRunSnapshotMaterialChange);
        expect(workState.resolveSessionWorkStatePrimaryItemId([])).toBe(
            protocol.resolveSessionWorkStatePrimaryItemId([]),
        );
        for (const symbol of [
            'SESSION_WORK_STATE_GOAL_RPC_METHODS_V1',
            'mergeSessionWorkStateMetadataV1',
            'readSessionWorkStateV1FromMetadata',
        ]) {
            expect(symbol in workState).toBe(false);
        }
        expectTypeOf<ActivitySessionSystemRecordKind>().toEqualTypeOf<protocol.ActivitySessionSystemRecordKind>();
        expectTypeOf<SessionWorkStateGoalCapabilitiesV1>().toEqualTypeOf<protocol.SessionWorkStateGoalCapabilitiesV1>();
        expectTypeOf<SessionWorkStateItemV1>().toEqualTypeOf<protocol.SessionWorkStateItemV1>();
        expectTypeOf<SessionWorkStateStatusV1>().toEqualTypeOf<protocol.SessionWorkStateStatusV1>();
        expectTypeOf<SessionWorkStateUnknownItemV1>().toEqualTypeOf<protocol.SessionWorkStateUnknownItemV1>();
        expectTypeOf<SessionWorkStateV1>().toEqualTypeOf<protocol.SessionWorkStateV1>();
        expectTypeOf<SessionWorkflowActivityHeadlineV1>().toEqualTypeOf<protocol.SessionWorkflowActivityHeadlineV1>();
        expectTypeOf<SessionWorkflowAgentSnapshotV1>().toEqualTypeOf<protocol.SessionWorkflowAgentSnapshotV1>();
        expectTypeOf<SessionWorkflowAgentStatusV1>().toEqualTypeOf<protocol.SessionWorkflowAgentStatusV1>();
        expectTypeOf<SessionWorkflowPhaseSnapshotV1>().toEqualTypeOf<protocol.SessionWorkflowPhaseSnapshotV1>();
        expectTypeOf<SessionWorkflowRunHeadlineV1>().toEqualTypeOf<protocol.SessionWorkflowRunHeadlineV1>();
        expectTypeOf<SessionWorkflowRunSnapshotV1>().toEqualTypeOf<protocol.SessionWorkflowRunSnapshotV1>();
        expectTypeOf<SessionWorkflowRunStatusReasonV1>().toEqualTypeOf<protocol.SessionWorkflowRunStatusReasonV1>();
        expectTypeOf<SessionWorkflowRunStatusV1>().toEqualTypeOf<protocol.SessionWorkflowRunStatusV1>();
        expectTypeOf<WorkStateItem>().toHaveProperty('localId');
        expectTypeOf<WorkStatePublisher>().toHaveProperty('publish');
        expectTypeOf<WorkStateService>().toHaveProperty('publisher');
        expectTypeOf<WorkStateTruncation>().toHaveProperty('reason');
    });
});
