/** @moduleRealm daemon */
import type { PluginOperationAvailability } from '../availability.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { ProjectKeyV1, SessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 } from '../sessions/authoring.js';
export type { ProjectKeyV1, SessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 } from '../sessions/authoring.js';
import type {
    SessionMcpElicitDecisionV1,
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
    SessionMcpServiceV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionPermissionDecisionV1,
    SessionPermissionFollowUpPromptDeliveryV1,
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionModeV1,
    SessionPermissionsServiceV1,
    SessionRuntimeAuthRefreshResultV1,
    SessionRuntimeAuthServicesV1,
} from '@happier-dev/agents';
import type { AgentSessionAuthRefreshRequest } from '../agentRuntime/context.js';
import type {
    PluginActionInputById,
    PluginActionResultById,
} from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import type { ExternalSessionsService } from './externalSessions.js';
import { AgentPermissionIntentV1Schema as protocolAgentPermissionIntentV1Schema } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { isSlashCommandSupported as protocolIsSlashCommandSupported, normalizeSlashCommandName as protocolNormalizeSlashCommandName, readLeadingSlashCommandName as protocolReadLeadingSlashCommandName, readSlashCommandNames as protocolReadSlashCommandNames } from '@happier-dev/protocol/sessions/slashCommands';
import { hasSessionInputContentV1 as protocolHasSessionInputContentV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAuthoringV1';
import { readPendingLocalId as protocolReadPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { resolveTranscriptBodySessionMessageRole as protocolResolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { SessionIdSchema as protocolSessionIdSchema, SessionIndexedIdentifierMaxLengthV1 as protocolSessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/protocol/sessions/idsV1';
import { SessionMessageProvenanceV1Schema as protocolSessionMessageProvenanceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionRuntimeIssueV1Schema as protocolSessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY as protocolSessionCapabilityNoticeSidecarKey,
    SessionCapabilityNoticeV1Schema as protocolSessionCapabilityNoticeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { SessionUsageLimitRecoveryV1Schema as protocolSessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SPAWN_SESSION_ERROR_CODES as protocolSpawnSessionErrorCodes } from '@happier-dev/protocol/spawnSession';
import { SessionAuthoringCheckoutCreationDraftV1Schema as protocolSessionAuthoringCheckoutCreationDraftV1Schema } from '@happier-dev/protocol/sessions/authoring/creationFieldsV1';
import { SessionServerStartSpawnDraftV1Schema as protocolSessionServerStartSpawnDraftV1Schema, SessionSpawnNewInputV2Schema as protocolSessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { HappierStructuredInputV1Schema as protocolHappierStructuredInputV1Schema, normalizeSessionAttachmentUploadPath as protocolNormalizeSessionAttachmentUploadPath, readHappierStructuredInputV1FromMeta as protocolReadHappierStructuredInputV1FromMeta, readStructuredInputMentionSourcesV1 as protocolReadStructuredInputMentionSourcesV1, sanitizeHappierStructuredInputV1 as protocolSanitizeHappierStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { MENTION_KIND_V1 as protocolMentionKindV1, MentionRefV1Schema as protocolMentionRefV1Schema } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { CHANGE_TITLE_TOOL_NAME_ALIASES as protocolChangeTitleToolNameAliases, isChangeTitleToolNameAlias as protocolIsChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2/aliases';
import { ProjectKeyV1Schema as protocolProjectKeyV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readSessionModesMetadata as protocolReadSessionModesMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { NATIVE_TOOL_APPROVAL_REQUEST_SOURCE as protocolNativeToolApprovalRequestSource, NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE as protocolNativeToolApprovalOnceRequestSource } from '@happier-dev/protocol/sessions/permissions/v1';
import { buildAgentRequestSemanticSummary as protocolBuildAgentRequestSemanticSummary } from '@happier-dev/protocol/activity/agentRequestSummary';
import { StructuredQuestionAnswersV1Schema as protocolStructuredQuestionAnswersV1Schema } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';

/** Accepted native mode facts; parsing and retained V1 normalization stay Protocol-owned. */
export type SessionModeCatalog = Readonly<{
    v: 2;
    agentId: string;
    updatedAt: number;
    currentModeId: string | null;
    availableModes: readonly Readonly<{ id: string; name: string; description?: string }>[];
}>;

export const readSessionModesMetadata: (
    metadata: Readonly<Record<string, unknown>> | null | undefined,
) => SessionModeCatalog | null = protocolReadSessionModesMetadata;

/**
 * Portable structural view of a Protocol-owned validator. The runtime value
 * remains the canonical Protocol value; SDK declarations never expose its
 * private Protocol or Zod implementation types.
 */
export interface SessionSchema<T> {
    parse(value: unknown): T;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false; error: unknown }>;
}

/** Lossless answers keyed by the live requester's canonical question identity. */
export type StructuredQuestionAnswersV1 = Readonly<Record<string, readonly string[]>>;

/** The canonical validator retains answer arrays and their immutable, null-prototype carrier. */
export const StructuredQuestionAnswersV1Schema: SessionSchema<StructuredQuestionAnswersV1> = protocolStructuredQuestionAnswersV1Schema;

/** Semantic question facts shared by Session request renderers and native mediators. */
export type AgentRequestQuestionSummary = Readonly<{
    answerKey: string;
    header?: string | null;
    question: string;
    selection: 'text' | 'single' | 'multiple';
    required: boolean;
    allowCustom: boolean;
    choices: readonly Readonly<{ label: string; value: string; description?: string | null }>[];
    freeformDescription?: string;
    freeformPlaceholder?: string;
}>;

/** Protocol alone owns normalization; the SDK projects the question portion consumed by mediators. */
export function summarizeAgentRequestQuestions(questions: readonly unknown[]): readonly AgentRequestQuestionSummary[] {
    return protocolBuildAgentRequestSemanticSummary({
        kind: 'user_action',
        toolName: 'AskUserQuestion',
        toolInput: { questions },
    }).questions;
}

export const ProjectKeyV1Schema: SessionSchema<ProjectKeyV1> = protocolProjectKeyV1Schema;

/** Browser-safe Session-create input projected at the SDK author boundary. */
export const SessionSpawnNewInputV2Schema: SessionSchema<SessionSpawnNewInputV2> = /* @__PURE__ */ projectProtocolValue(protocolSessionSpawnNewInputV2Schema);

/**
 * SDK-local author declaration for the one Protocol-owned worktree draft.
 * Session spawning and target preparation consume this exact schema; this
 * structural projection keeps external declarations independent of Protocol.
 */
export type SessionAuthoringCheckoutCreationDraftV1 = {
    kind: 'git_worktree';
    displayName: string;
    baseRef: string | null;
    branchMode?: 'new' | 'existing';
};
export const SessionAuthoringCheckoutCreationDraftV1Schema:
    SessionSchema<SessionAuthoringCheckoutCreationDraftV1> = protocolSessionAuthoringCheckoutCreationDraftV1Schema;

/** Browser-safe server-start draft projected at the SDK author boundary. */
export const SessionServerStartSpawnDraftV1Schema: SessionSchema<SessionServerStartSpawnDraftV1> = /* @__PURE__ */ projectProtocolValue(protocolSessionServerStartSpawnDraftV1Schema);

/**
 * Declaration-neutral projection of the Protocol provenance union. The
 * runtime schema below remains the Protocol authority; spelling the public
 * shape here keeps external author declarations closed over the SDK instead
 * of naming a private Protocol package.
 */
export type SessionMessageProvenanceV1 =
    | {
        v: 1;
        kind: 'happierApp';
        actor: { kind: 'owner' } | { kind: 'sharedCollaborator' } | { kind: 'person'; accountId: string };
    }
    | { v: 1; kind: 'cli' }
    | { v: 1; kind: 'voice' }
    | {
        v: 1;
        kind: 'happierSession';
        sourceSessionId: string;
        via: 'action' | 'mcp';
        callerDepth?: number;
    }
    | {
        v: 1;
        kind: 'pluginSession';
        pluginId: string;
        contributionLocalId: string;
        surface: 'cli' | 'mcp' | 'agent' | 'ui' | 'background' | 'unspecified';
        sourceRef?: string;
        sourceRevisionOrEpoch?: string;
        externalActor?: { kind: 'human' | 'bot'; displayNameSnapshot?: string };
        contentProvenance?: 'original' | 'forwarded' | 'viaBot';
    }
    | {
        v: 1;
        kind: 'automation';
        automationId: string;
        runId: string;
    }
    | {
        v: 1;
        kind: 'host';
        producer:
            | 'happierApp'
            | 'cli'
            | 'sessionAction'
            | 'happierMcp'
            | 'pluginSession'
            | 'automation'
            | 'voiceInput'
            | 'externalSessionHistory'
            | 'runtimeTranscript'
            | 'executionRunVoice'
            | 'hostOnboarding'
            | 'agentRuntimeFirstInput';
    };
/** Canonical runtime validator with an SDK-local author declaration. */
export const SessionMessageProvenanceV1Schema: SessionSchema<SessionMessageProvenanceV1> = protocolSessionMessageProvenanceV1Schema;

export type MentionRefV1 = {
    [key: string]: unknown;
    kind: string;
    ref: string;
    token: string;
    label?: string;
};
/**
 * SDK-local structural projection of a structured image input. The Protocol
 * validator remains the runtime authority; this declaration keeps consumers
 * able to name the validated fields without carrying Protocol/Zod types.
 */
export type StructuredImageInputV1 = {
    [key: string]: unknown;
    id: string;
    kind: 'localImage' | 'image';
    path?: string;
    url?: string;
    mimeType?: string;
    label?: string;
};
/** SDK-local structural projection of a vendor-plugin mention. */
export type VendorPluginMentionV1 = {
    [key: string]: unknown;
    backendId?: string;
    agentId?: string;
    vendorPluginRef: string;
    label?: string;
};
/** SDK-local structural projection of a skill mention. */
export type SkillMentionV1 = {
    [key: string]: unknown;
    id?: string;
    origin?: 'vendor' | 'happier';
    name: string;
    path?: string;
    label?: string;
    projectionRef?: string;
    backendId?: string;
    agentId?: string;
};
export type HappierStructuredInputV1 = {
    v: 1;
    mentions?: MentionRefV1[];
    vendorPluginMentions?: VendorPluginMentionV1[];
    skillMentions?: SkillMentionV1[];
    imageInputs?: StructuredImageInputV1[];
};
export type StructuredInputMentionSourcesV1 = Readonly<{
    mentions: readonly MentionRefV1[];
    vendorPluginMentions: readonly VendorPluginMentionV1[];
    skillMentions: readonly SkillMentionV1[];
}>;
/** @realm any */
export const MENTION_KIND_V1: Readonly<{
    file: 'happier.file';
    skill: 'happier.skill';
    vendorPlugin: 'happier.vendorPlugin';
    session: 'happier.session';
}> = protocolMentionKindV1;
/** @realm any */
export const MentionRefV1Schema: SessionSchema<MentionRefV1> = protocolMentionRefV1Schema;
/** @realm any */
export const HappierStructuredInputV1Schema: SessionSchema<HappierStructuredInputV1> = protocolHappierStructuredInputV1Schema;
/** @realm any */
export const normalizeSessionAttachmentUploadPath: (value: unknown) => string | null = protocolNormalizeSessionAttachmentUploadPath;
/** @realm any */
export const readHappierStructuredInputV1FromMeta: (
    value: unknown,
    options?: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }>,
) => HappierStructuredInputV1 | null = protocolReadHappierStructuredInputV1FromMeta;
/** @realm any */
export const readStructuredInputMentionSourcesV1: (
    envelope: HappierStructuredInputV1 | null | undefined,
) => StructuredInputMentionSourcesV1 = protocolReadStructuredInputMentionSourcesV1;
/** @realm any */
export const sanitizeHappierStructuredInputV1: (
    value: unknown,
    options?: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }>,
) => HappierStructuredInputV1 | null = protocolSanitizeHappierStructuredInputV1;

export type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
export type SessionUsageLimitRecoveryResumePromptModeV1 = 'standard' | 'off' | 'custom';
export type SessionUsageLimitRecoveryV1 = Readonly<{
    v: 1;
    status: 'armed' | 'waiting' | 'checking' | 'paused' | 'exhausted' | 'cancelled';
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1;
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
    resetAtMs: number | null;
    nextCheckAtMs: number | null;
    attemptCount: number;
    maxAttempts: number;
    lastProbeError: string | null;
    selectedAuth: unknown;
    recoveryCredits?: unknown;
}>;
export type SessionRuntimeIssueV1 = Readonly<{
    v: 1;
    scope: 'primary_session';
    status: 'failed';
    code: string;
    source: string;
    occurredAt: number;
    sessionSeq?: number;
    agentId?: string;
    agentTurnId?: string;
    sanitizedPreview?: string;
    usageLimit?: unknown;
    temporaryThrottle?: unknown;
    agentProcessExitAfterSwitch?: unknown;
}>;
export type SessionStateCapabilitiesV1 = Readonly<{
    identity?: unknown;
    intent?: unknown;
    display?: unknown;
    runtime?: unknown;
    view?: unknown;
}>;
/** Structural projection; the Protocol validator owns notice admission. */
export type SessionCapabilityNoticeV1 = {
    v: 1;
    items: {
        kind: 'mcp_server' | 'skill' | 'prompt_library';
        name: string;
        itemId?: string;
        code: string;
        detail?: string;
    }[];
};
/** @realm any */
export const SESSION_CAPABILITY_NOTICE_SIDECAR_KEY: 'capabilityNoticeV1' = protocolSessionCapabilityNoticeSidecarKey;
/** @realm any */
export const SessionCapabilityNoticeV1Schema: SessionSchema<SessionCapabilityNoticeV1> = protocolSessionCapabilityNoticeV1Schema;
/** @realm any */
export const SPAWN_SESSION_ERROR_CODES: Readonly<Record<string, string>> = protocolSpawnSessionErrorCodes;
/** @realm any */
export const SessionRuntimeIssueV1Schema: SessionSchema<SessionRuntimeIssueV1> = protocolSessionRuntimeIssueV1Schema;
/** @realm any */
export const SessionUsageLimitRecoveryV1Schema: SessionSchema<SessionUsageLimitRecoveryV1> = protocolSessionUsageLimitRecoveryV1Schema;
/** @realm any */
export const isSlashCommandSupported: (slashCommands: unknown, commandName: string) => boolean = protocolIsSlashCommandSupported;
/** @realm any */
export const normalizeSlashCommandName: (value: unknown) => string | null = protocolNormalizeSlashCommandName;
/** @realm any */
export const readLeadingSlashCommandName: (value: unknown) => string | null = protocolReadLeadingSlashCommandName;
/** @realm any */
export const readSlashCommandNames: (value: unknown) => readonly string[] = protocolReadSlashCommandNames;
/** @realm any */
export const readPendingLocalId: (value: unknown) => string | null = protocolReadPendingLocalId;
/**
 * Whether a Session input carries something to deliver.
 *
 * It is the exact rule `SessionHandle.send` and its Action surface binding
 * admit by, published so a producer plans against the admission it will meet
 * instead of re-deriving it: blank text is a real input when at least one
 * attachment rides with it, and neither is refused.
 *
 * @realm any
 */
export const hasSessionInputContentV1: (
    input: Readonly<{ text: string; attachmentCount: number }>,
) => boolean = protocolHasSessionInputContentV1;
/** @realm any */
export const resolveTranscriptBodySessionMessageRole: (
    input: Readonly<{
        protocol: 'acp' | 'codex';
        body: unknown;
    }>,
) => SessionMessageRole = protocolResolveTranscriptBodySessionMessageRole;

export type AgentPermissionIntentV1 = 'default' | 'read-only' | 'safe-yolo' | 'yolo' | 'plan';
export type SessionId = string;
/** @realm any */
export const AgentPermissionIntentV1Schema: ProtocolComposableSchema<AgentPermissionIntentV1> = protocolAgentPermissionIntentV1Schema;
/** @realm any */
export const SessionIdSchema: ProtocolComposableSchema<SessionId> = protocolSessionIdSchema;
/** @realm any */
export const SessionIndexedIdentifierMaxLengthV1: number = protocolSessionIndexedIdentifierMaxLengthV1;
/** @realm any */
export const CHANGE_TITLE_TOOL_NAME_ALIASES: readonly string[] = protocolChangeTitleToolNameAliases;
/** @realm any */
export const isChangeTitleToolNameAlias: (name: string) => boolean = protocolIsChangeTitleToolNameAlias;

export type SessionMcpElicitDecision = SessionMcpElicitDecisionV1;
export type SessionMcpElicitRequest = SessionMcpElicitRequestV1;
export type SessionMcpElicitResult = SessionMcpElicitResultV1;
export type SessionMcpService = SessionMcpServiceV1;
export type SessionPermissionDecisionRequest = SessionPermissionDecisionRequestV1;
export type SessionPermissionDecisionResult = SessionPermissionDecisionResultV1;
export type SessionPermissionDecision = SessionPermissionDecisionV1;
export type SessionPermissionFollowUpPromptDelivery = SessionPermissionFollowUpPromptDeliveryV1;
export type SessionPermissionFollowUpPromptIntent = SessionPermissionFollowUpPromptIntentV1;
export type SessionPermissionMode = SessionPermissionModeV1;
export type SessionPermissionsService = SessionPermissionsServiceV1;
export const NATIVE_TOOL_APPROVAL_REQUEST_SOURCE: 'native_tool_approval' = protocolNativeToolApprovalRequestSource;
export const NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE: 'native_tool_approval_once' = protocolNativeToolApprovalOnceRequestSource;
export type SessionRuntimeAuthRefreshResult = SessionRuntimeAuthRefreshResultV1;
export type SessionRuntimeAuthServices = SessionRuntimeAuthServicesV1;
export type SessionSystemRecordRevision = string;
export type SessionSystemRecordAddress =
    | Readonly<{
        owner: 'plugin';
        namespace: string;
        kind: string;
        localId: string;
    }>
    | Readonly<{
        owner: 'host';
        namespace: string;
        kind: string;
        localId: string;
    }>;
export type SessionSystemRecord = Readonly<{
    id: string;
    address: SessionSystemRecordAddress;
    content: JsonValue;
    revision: SessionSystemRecordRevision;
    createdAt: string;
    updatedAt: string;
}>;
export type SessionSystemRecordListQuery =
    | Readonly<{
        owner: 'plugin';
        namespace: string;
        kind?: string;
        localId?: string;
        limit?: number;
        cursor?: string | null;
    }>
    | Readonly<{
        owner: 'host';
        namespace: string;
        kind?: string;
        localId?: string;
        limit?: number;
        cursor?: string | null;
    }>;
export type SessionSystemRecordPage = Readonly<{
    records: readonly SessionSystemRecord[];
    nextCursor: string | null;
    hasNext: boolean;
}>;
export type SessionSystemRecordUpsertRequest = Readonly<{
    address: SessionSystemRecordAddress;
    content: JsonValue;
    expectedRevision?: SessionSystemRecordRevision | null;
}>;
export type SessionSystemRecordReadRequest = Readonly<{
    address: SessionSystemRecordAddress;
}>;
export type SessionSystemRecordDeleteRequest = Readonly<{
    address: SessionSystemRecordAddress;
    expectedRevision?: SessionSystemRecordRevision;
}>;

export type SessionSummary = Readonly<{
    id: string;
    title?: string;
    machineId?: string;
    projectId?: string;
    agentId?: string;
    /** Protected birth facts were opened; omission means their presence is unknown. */
    hasAttestedContext?: boolean;
    state: 'active' | 'idle' | 'stopped' | 'archived';
    runtimeAvailability: PluginOperationAvailability;
    storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
    encryptionMode: 'e2ee' | 'plain';
    updatedAtMs: number;
}>;
/**
 * One declared Composer attachment carried by a Session input.
 *
 * It is the same author half `attachment.add` carries in a composer: the
 * plugin names its own declared attachment and supplies key, value and
 * presentation. The host qualifies the plugin id from the calling plugin and
 * stamps the instance identity and declared type label, then runs the ordinary
 * attachment admission, `prepareForSend` and `resolveForDispatch` lifecycle.
 */
export type SessionSendAttachment = NonNullable<
    Exclude<
        PluginActionInputById['session.message.send'],
        Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >['attachments']
>[number];
/**
 * Sends Session input through the host. A plugin can set `toolAnswerDelivery`
 * when its provider requires a user message to carry an answer already recorded
 * on an interactive question tool; Happier keeps that delivery out of chat.
 */
export type SessionSendRequest =
  | Readonly<Omit<Extract<
      PluginActionInputById['session.message.send'],
      Readonly<{ kind: 'sessionSubagentLaunch' }>
    >, 'sessionId'>>
  | Readonly<Omit<Extract<
      PluginActionInputById['session.message.send'],
      Readonly<{ kind: 'sessionSubagentCommand' }>
    >, 'sessionId'>>
  | Readonly<Omit<Exclude<
      PluginActionInputById['session.message.send'],
      Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >, 'sessionId' | 'message'> & {
    kind: 'userText';
    text: Exclude<
        PluginActionInputById['session.message.send'],
        Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >['message'];
    /**
     * Declared attachment drafts delivered with this input. Resending under the
     * same `idempotencyKey` rejoins the existing durable input rather than
     * queueing a second Message, so an unknown outcome is safe to retry.
     */
    attachments?: Exclude<
        PluginActionInputById['session.message.send'],
        Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >['attachments'];
    /** Exact participant target; omission sends to the main Session. */
    recipient?: Exclude<
        PluginActionInputById['session.message.send'],
        Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >['recipient'];
    source?: Exclude<
        PluginActionInputById['session.message.send'],
        Readonly<{ kind: 'sessionSubagentLaunch' | 'sessionSubagentCommand' }>
    >['source'];
  }>;
/** A host-bound Session handle always sends to that one exact Session. */
export type SessionSendResult = Exclude<PluginActionResultById['session.message.send'], Readonly<{ kind: 'fanout' }>>;
export type SessionMessagePart =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'structured'; mediaType: string; value: JsonValue }>;
export type SessionEvent =
    | Readonly<{ sequence: number; kind: 'changed'; summary: SessionSummary }>
    | Readonly<{ sequence: number; kind: 'message'; message: { version: 1; messageId: string; sender: 'user' | 'agent' | 'system' | 'tool'; parts: readonly [SessionMessagePart, ...SessionMessagePart[]] } }>
    | Readonly<{ sequence: number; kind: 'activity'; activity: { state: 'active' | 'idle' | 'stopped'; observedAtMs: number } }>
    | Readonly<{ sequence: number; kind: 'removed'; sessionId: string }>;

export type WorkStateItem = Readonly<{
    localId: string;
    kind: 'goal' | 'task' | 'todo';
    origin: 'vendor' | 'happier' | 'derived';
    status: 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
    statusReason?: 'blocked' | 'usageLimited' | 'budgetLimited' | 'interrupted';
    title: string;
    summary?: string;
    providerRef?: string;
    order?: number;
    parentProviderRef?: string;
    priority?: string;
    progress?: number;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    createdAtMs?: number;
    startedAtMs?: number;
    completedAtMs?: number;
    updatedAtMs: number;
    providerData?: JsonValue;
}>;
export type WorkStateTruncation =
    | Readonly<{ reason: 'itemLimit'; omittedCount: number }>
    | Readonly<{ reason: 'providerLimit' | 'byteLimit'; omittedCount?: number }>;
export interface WorkStatePublisher {
    publish(request: { sourceSequence: number; observedAtMs: number; items: readonly WorkStateItem[]; primaryLocalId?: string | null; truncation?: WorkStateTruncation }, options?: { signal?: AbortSignal }): Promise<
        | { status: 'applied' | 'unchanged'; revision: string; sourceSequence: number }
        | { status: 'ignoredStale'; revision: string; currentSourceSequence: number }
        | { status: 'conflict' | 'unavailable'; diagnostic: PluginDiagnosticData }
    >;
}
export interface WorkStateService { publisher(declaredSourceId: string): WorkStatePublisher }

export type SessionMediaPublishGeneratedRequest = Readonly<{
    localId: string;
    path: string;
    referencePaths?: readonly string[];
    description?: string;
    toolCallId?: string;
    createdAtMs?: number;
}>;
export interface SessionMediaSourceRoot {
    publishGenerated(
        request: SessionMediaPublishGeneratedRequest,
        options?: PluginCancellationOptions,
    ): Promise<Readonly<{ status: 'published' }>>;
    dispose(): void;
}
export interface SessionMediaService {
    registerSourceRoot(
        request: Readonly<{ rootPath: string }>,
        options?: PluginCancellationOptions,
    ): Promise<SessionMediaSourceRoot>;
}

export type SessionRuntimeAuthRefreshRequest = AgentSessionAuthRefreshRequest;
export interface SessionAuthService {
    readonly services: Readonly<{
        refreshRuntimeAuth(
            request: SessionRuntimeAuthRefreshRequest,
            options?: PluginCancellationOptions,
        ): Promise<SessionRuntimeAuthRefreshResult>;
    }>;
}

/**
 * One host-stamped Session capability. The Session id and caller identity are
 * bound by the host that creates the handle; author calls never re-supply them.
 */
export interface SessionHandle {
    summary(options?: PluginCancellationOptions): Promise<SessionSummary>;
    send(request: SessionSendRequest, options?: PluginCancellationOptions): Promise<SessionSendResult>;
    /**
     * Copies a trusted plugin-local file through the hosted Session's existing
     * attachment transfer owner. The host derives the workspace destination;
     * a source path on another machine is unavailable, never a local fallback.
     */
    materializeAttachment(request: Readonly<{
        sourcePath: string;
        name: string;
        messageLocalId: string;
    }>, options?: PluginCancellationOptions): Promise<Readonly<{ path: string; bytes: Uint8Array }>>;
    listSystemRecords(
        query: SessionSystemRecordListQuery,
        options?: PluginCancellationOptions,
    ): Promise<SessionSystemRecordPage>;
    upsertSystemRecord(
        request: SessionSystemRecordUpsertRequest,
        options?: PluginCancellationOptions,
    ): Promise<SessionSystemRecord>;
    readSystemRecord(
        request: SessionSystemRecordReadRequest,
        options?: PluginCancellationOptions,
    ): Promise<SessionSystemRecord | null>;
    deleteSystemRecord(
        request: SessionSystemRecordDeleteRequest,
        options?: PluginCancellationOptions,
    ): Promise<void>;
    watch(listener: (event: SessionEvent) => void): Disposable;
    readonly auth: SessionAuthService;
    readonly permissions: SessionPermissionsService;
    readonly mcp: SessionMcpService;
    readonly media: SessionMediaService;
    readonly subagents: SubagentsService;
}
/**
 * The host-stamped current Session capability. Unlike handles returned by
 * inventory lookup, it is bound to the live invocation that owns title mutation.
 */
export interface CurrentSessionHandle extends SessionHandle {
    setDisplayTitle(title: string | null, options?: PluginCancellationOptions): Promise<void>;
}
export type SubagentSummary = Readonly<{ id: string; parentSessionId: string; groupId?: string; status: 'starting' | 'running' | 'completed' | 'failed' | 'aborted'; updatedAtMs: number }>;
export interface SubagentsService {
    list(query?: { parentSessionId?: string; groupId?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly SubagentSummary[]; nextCursor?: string }>;
    get(id: string, options?: { parentSessionId?: string; signal?: AbortSignal }): Promise<SubagentSummary | null>;
    watch(query: { parentSessionId?: string; id?: string }, listener: (event: { kind: 'snapshot' | 'upserted' | 'removed' | 'resyncRequired'; item?: SubagentSummary; id?: string }) => void): Disposable;
}
export type SessionWatchQuery = Readonly<{
    machineId?: string;
    projectId?: string;
    state?: SessionSummary['state'];
}>;
export type SessionWatchEvent =
    | Readonly<{ kind: 'snapshot'; revision: string; items: readonly SessionSummary[] }>
    | Readonly<{ kind: 'upserted'; revision: string; item: SessionSummary }>
    | Readonly<{ kind: 'removed'; revision: string; id: string }>
    | Readonly<{ kind: 'resyncRequired'; revision: string }>;
export type SessionListQuery = Readonly<{
    cursor?: string;
    limit?: number;
    machineId?: string;
    projectId?: string;
    state?: SessionSummary['state'];
}>;
export type SessionPage = Readonly<{
    items: readonly SessionSummary[];
    nextCursor?: string;
}>;
export interface SessionsService {
    readonly current: CurrentSessionHandle | null;
    list(query?: SessionListQuery, options?: PluginCancellationOptions): Promise<SessionPage>;
    get(id: string, options?: { signal?: AbortSignal }): Promise<SessionHandle | null>;
    watch(query: SessionWatchQuery, listener: (event: SessionWatchEvent) => void): Disposable;
    readonly subagents: SubagentsService;
    readonly external: ExternalSessionsService;
}

