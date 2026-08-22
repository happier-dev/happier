import type {
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1,
    InteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientRequesterV1,
    InteractionTransientResultV1,
    SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { CurrentSessionPresentationOwnerV1 } from '@happier-dev/protocol/sessions';
import type { PluginDiagnosticData, PluginServices } from '@happier-dev/plugin-sdk';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';

/**
 * Host-private aliases of the Protocol interaction contract. These retain the
 * current-Session seam's names without introducing a second request/result
 * vocabulary or an author-controlled request stamp.
 */
export type HostSessionQuestion = InteractionTransientAuthorQuestionV1;
export type HostSessionChoiceAnswer = InteractionTransientChoiceSelectionV1;
export type HostSessionQuestionAnswer = InteractionTransientQuestionAnswerV1;
export type HostSessionApprovalRequest = InteractionTransientApprovalAuthorRequestV1;
export type HostSessionQuestionsRequest = InteractionTransientQuestionsAuthorRequestV1;
export type HostSessionConfirmationRequest = InteractionTransientConfirmationAuthorRequestV1;
export type HostSessionInteractionRequest = InteractionTransientAuthorRequestV1;
export type HostSessionApprovalResult = InteractionTransientApprovalResultV1;
export type HostSessionQuestionsResult = InteractionTransientQuestionsResultV1;
export type HostSessionConfirmationResult = InteractionTransientConfirmationResultV1;
export type HostSessionInteractionResult = InteractionTransientResultV1;

/**
 * Requester facts are derived by the invocation owner, while the canonical
 * current-Session owner adds request/session identity, timestamps, expiry,
 * and all lifecycle settlement. The optional fallback is only host-originated
 * caller attribution; the Native Agent adapter passes it to that same owner.
 */
export type HostSessionInteractionOptions = Readonly<{
    signal?: AbortSignal;
    requester?: InteractionTransientRequesterV1;
    permissionContext?: Readonly<{
        origin?: 'host_acp_fs_write';
        owner?: PermissionRequestOwner;
        /** Exact active turn, stamped by the invocation host rather than a plugin. */
        turnId?: string | null;
        /** Immutable authority carried from the exact admitted input, if any. */
        causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1 | null;
    }>;
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

/** Invocation facts are host-stamped before the session owner adds `sessionId`. */
export type HostSessionPresentationOwner = Readonly<
    Omit<CurrentSessionPresentationOwnerV1, 'sessionId'>
>;

export interface HostCurrentSessionPresentationService {
    notify(request: { operationId: string; message: string; severity: 'info' | 'warning' | 'error' }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationOneShotResult>;
    setStatus(request: { operationId: string; key: string; text: string | null; owner: HostSessionPresentationOwner }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationStatefulResult>;
    setWidget(request: { operationId: string; key: string; placement: 'beforeComposer' | 'afterComposer'; lines: readonly string[] | null; owner: HostSessionPresentationOwner }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationStatefulResult>;
    /** Retirement cleanup removes every transient row owned by this exact invocation. */
    purgeOwner(request: {
        operationId: string;
        owner: HostSessionPresentationOwner;
    }): Promise<HostSessionPresentationStatefulResult>;
    replaceComposerText(request: { operationId: string; text: string }, options?: { signal?: AbortSignal }): Promise<HostSessionPresentationOneShotResult>;
}

export type HostCurrentSessionUiServices = Readonly<{
    interactions: HostCurrentSessionInteractionsService;
    presentation?: HostCurrentSessionPresentationService;
}>;

export type HostPluginServices = PluginServices;
