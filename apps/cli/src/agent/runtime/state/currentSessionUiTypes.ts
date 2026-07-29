import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { PluginCurrentSessionService, PluginServices, PluginSessionsService } from '@happier-dev/plugin-sdk/runtime';
import type { HostExternalSessionsService } from '@/session/external/privateContract';

export type HostSessionQuestion =
    | Readonly<{ id: string; prompt: string; selection: 'text'; required?: boolean; presentation: { inputMode: 'singleLine' | 'multiLine'; placeholder?: string; initialValue?: string; whitespace: 'preserve' | 'trim'; allowEmpty: boolean } }>
    | Readonly<{ id: string; prompt: string; selection: 'single' | 'multiple'; required?: boolean; choices: readonly [{ id: string; label: string; description?: string }, ...{ id: string; label: string; description?: string }[]]; allowCustom?: boolean }>;
export type HostSessionChoiceAnswer =
    | Readonly<{ kind: 'choice'; choiceId: string }>
    | Readonly<{ kind: 'custom'; value: string }>;
export type HostSessionTextPresentation = Extract<
    HostSessionQuestion,
    { selection: 'text' }
>['presentation'];
export type HostSessionQuestionAnswer =
    | Readonly<{ questionId: string; selection: 'text'; value: string }>
    | Readonly<{ questionId: string; selection: 'single'; answer: { kind: 'choice'; choiceId: string } | { kind: 'custom'; value: string } }>
    | Readonly<{ questionId: string; selection: 'multiple'; answers: readonly [{ kind: 'choice'; choiceId: string } | { kind: 'custom'; value: string }, ...({ kind: 'choice'; choiceId: string } | { kind: 'custom'; value: string })[]] }>;
export type HostSessionPersistedApproval = Readonly<{
    scope: 'session' | 'workspace' | 'account';
    toolName?: string;
}>;
export type HostSessionApprovalEffects = Readonly<{
    replaceInput?: JsonValue;
    persistApprovals?: readonly [HostSessionPersistedApproval, ...HostSessionPersistedApproval[]];
    permissionModeId?: string;
    followUp?: Readonly<{ text: string; delivery: 'nextTurn' | 'followUp' }>;
}>;
export type HostSessionApprovalRequest = Readonly<{
    kind: 'approval';
    requestId: string;
    title: string;
    description?: string;
    subject: { kind: 'tool'; name: string; input: JsonValue } | { kind: 'operation'; label: string; input?: JsonValue };
    allowedPersistenceScopes?: readonly ['session' | 'workspace' | 'account', ...('session' | 'workspace' | 'account')[]];
}>;
export type HostSessionQuestionsRequest = Readonly<{
    kind: 'questions';
    requestId: string;
    title?: string;
    questions: readonly [HostSessionQuestion, ...HostSessionQuestion[]];
}>;
export type HostSessionConfirmationRequest = Readonly<{
    kind: 'confirmation';
    requestId: string;
    title: string;
    message: string;
}>;
export type HostSessionInteractionRequest =
    | HostSessionApprovalRequest
    | HostSessionQuestionsRequest
    | HostSessionConfirmationRequest;
export type HostSessionApprovalResult =
    | Readonly<{ kind: 'approval'; status: 'approved'; effects?: HostSessionApprovalEffects; rationale?: string }>
    | Readonly<{ kind: 'approval'; status: 'denied'; rationale?: string; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ kind: 'approval'; status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ kind: 'approval'; status: 'unavailable'; diagnostic: PluginDiagnosticData }>;
export type HostSessionQuestionsResult =
    | Readonly<{ kind: 'questions'; status: 'answered'; answers: readonly HostSessionQuestionAnswer[] }>
    | Readonly<{ kind: 'questions'; status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ kind: 'questions'; status: 'unavailable'; diagnostic: PluginDiagnosticData }>;
export type HostSessionConfirmationResult =
    | Readonly<{ kind: 'confirmation'; status: 'answered'; confirmed: boolean }>
    | Readonly<{ kind: 'confirmation'; status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ kind: 'confirmation'; status: 'unavailable'; diagnostic: PluginDiagnosticData }>;
export type HostSessionInteractionResult =
    | HostSessionApprovalResult
    | HostSessionQuestionsResult
    | HostSessionConfirmationResult;
export type HostSessionInteractionOptions = Readonly<{
    signal?: AbortSignal;
    permissionContext?: Readonly<{ origin: 'host_acp_fs_write' }>;
}>;
export interface HostCurrentSessionInteractionsService {
    request(request: HostSessionApprovalRequest, options?: HostSessionInteractionOptions): Promise<HostSessionApprovalResult>;
    request(request: HostSessionQuestionsRequest, options?: HostSessionInteractionOptions): Promise<HostSessionQuestionsResult>;
    request(request: HostSessionConfirmationRequest, options?: HostSessionInteractionOptions): Promise<HostSessionConfirmationResult>;
}

export type HostSessionPresentationStatefulResult =
    | Readonly<{ status: 'applied' | 'unchanged'; revision: string }>
    | Readonly<{ status: 'conflict' | 'unavailable'; diagnostic: PluginDiagnosticData }>;
export type HostSessionPresentationOneShotResult = HostSessionPresentationStatefulResult
    | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>;
export interface HostCurrentSessionPresentationService {
    notify(request: { operationId: string; message: string; severity: 'info' | 'warning' | 'error' }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationOneShotResult>;
    setStatus(request: { operationId: string; key: string; text: string | null }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationStatefulResult>;
    setWidget(request: { operationId: string; key: string; placement: 'beforeComposer' | 'afterComposer'; lines: readonly string[] | null }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationStatefulResult>;
    setSurfaceTitle(request: { operationId: string; title: string | null }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationStatefulResult>;
    replaceComposerText(request: { operationId: string; text: string }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationOneShotResult>;
}

export type HostCurrentSessionUiServices = Readonly<{
    interactions: HostCurrentSessionInteractionsService;
    presentation?: HostCurrentSessionPresentationService;
}>;

export type HostPluginServices = Omit<PluginServices, 'sessions'> & Readonly<{
    sessions: Omit<PluginSessionsService, 'current'> & Readonly<{
        current: PluginCurrentSessionService & HostCurrentSessionUiServices;
        external: HostExternalSessionsService;
    }>;
}>;
