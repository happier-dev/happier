import type { PluginActionInputById, PluginInvocableActionId } from './actions/service.js';
import type {
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientAuthorRequestV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
} from '@happier-dev/protocol';
import type { JsonValue } from './identity.js';
import type { Disposable, PluginCancellationOptions } from './lifecycle.js';
import { InteractionTransientAuthorRequestV1Schema as protocolInteractionTransientAuthorRequestV1Schema } from '@happier-dev/protocol/plugins/interactions/transientV1';

/** Author input validation only; host-stamped custody remains outside this schema. */
export const InteractionTransientAuthorRequestV1Schema: Readonly<{
    parse(value: unknown): InteractionTransientAuthorRequestV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: InteractionTransientAuthorRequestV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = protocolInteractionTransientAuthorRequestV1Schema;

/** @realm daemon */
export type { PluginInvocationSurface } from './invocation.js';

/**
 * The Protocol owns transient interaction shape, bounds, and terminal
 * vocabulary. The SDK publishes only the author inputs and terminal results;
 * host-stamped request custody and settlement remain host-private.
 */
export type {
    InteractionTerminalStatusV1,
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
    InteractionTransientResultV1,
} from '@happier-dev/protocol';

/**
 * Reversible author presentation for the exact mounted Session. Companion
 * widget instances are host-internal; authors use qualified widgets.* Actions.
 * Protocol owns the author subset; its neutral DTO keeps declarations self-contained.
 */
import type {
    CurrentSessionPresentationIntentV1 as CanonicalCurrentSessionPresentationIntentV1,
    SessionCompanionPresentationItem as CanonicalSessionCompanionPresentationItem,
} from './actions/dtos/pluginActionDtoSupport.generated.js';
export type CurrentSessionPresentationIntentV1 = CanonicalCurrentSessionPresentationIntentV1;
export type SessionCompanionPresentationItem = CanonicalSessionCompanionPresentationItem;

export type InteractionOptions = PluginCancellationOptions & Readonly<{
    /** Defaults to the active turn. Native asynchronous questions may live until their occurrence retires. */
    lifetime?: 'turn' | 'occurrence';
}>;
export type InteractionSeverity = 'info' | 'warning' | 'error';

export type UiWidget = Readonly<{
    placement: 'beforeComposer' | 'afterComposer';
    lines: readonly string[];
}>;

export type ApprovalRequestStatus =
    | 'open'
    | 'approved'
    | 'rejected'
    | 'executed'
    | 'failed'
    | 'canceled';

export type ApprovalRequest = Readonly<{
    approvalRequestId: string;
    status: ApprovalRequestStatus;
    actionId: string;
    input: JsonValue;
    summary: string;
    createdAtMs: number;
    updatedAtMs: number;
    decision?: Readonly<{ kind: 'approve' | 'reject'; decidedAtMs: number }>;
    execution?: Readonly<{
        executedAtMs: number;
        ok: boolean;
        result?: JsonValue;
        errorCode?: string;
        error?: string;
    }>;
}>;

export type ApprovalQueueListItem = Readonly<{
    approvalRequestId: string;
    status: ApprovalRequestStatus;
    actionId: string;
    summary: string;
    sessionId?: string;
    serverId?: string;
    updatedAtMs: number;
}>;

export type ApprovalQueueQuery = Readonly<{
    status?: ApprovalRequest['status'];
    limit?: number;
}>;

export type ApprovalQueueRequest<
    TActionId extends PluginInvocableActionId = PluginInvocableActionId,
> = Readonly<{
    actionId: TActionId;
    input: PluginActionInputById[TActionId];
    summary?: string;
}>;

export type ApprovalQueueRequestResult = Readonly<{ approvalRequestId: string }>;
export type ApprovalQueueSnapshot = Readonly<{
    items: readonly ApprovalQueueListItem[];
}>;

export interface ApprovalQueueService {
    request<TActionId extends PluginInvocableActionId>(
        request: ApprovalQueueRequest<TActionId>,
        options?: InteractionOptions,
    ): Promise<ApprovalQueueRequestResult>;
    get(
        approvalRequestId: string,
        options?: InteractionOptions,
    ): Promise<ApprovalRequest | null>;
    list(
        query?: ApprovalQueueQuery,
        options?: InteractionOptions,
    ): Promise<ApprovalQueueSnapshot>;
    watch(
        query: ApprovalQueueQuery | undefined,
        listener: (snapshot: ApprovalQueueSnapshot) => void | Promise<void>,
        options?: InteractionOptions,
    ): Promise<Disposable>;
}

export interface InteractionsService {
    requestApproval(
        request: InteractionTransientApprovalAuthorRequestV1,
        options?: InteractionOptions,
    ): Promise<InteractionTransientApprovalResultV1>;
    askQuestions(
        request: InteractionTransientQuestionsAuthorRequestV1,
        options?: InteractionOptions,
    ): Promise<InteractionTransientQuestionsResultV1>;
    confirm(
        request: InteractionTransientConfirmationAuthorRequestV1,
        options?: InteractionOptions,
    ): Promise<InteractionTransientConfirmationResultV1>;
    readonly approvals: ApprovalQueueService;
}

export interface PresentationService {
    /** Applies one reversible presentation intent to the exact current Session UI. */
    present(
        intent: CurrentSessionPresentationIntentV1,
        options?: PluginCancellationOptions,
    ): Promise<void>;
    notify(
        message: string,
        options?: Readonly<{ severity?: InteractionSeverity; signal?: AbortSignal }>,
    ): Promise<void>;
    readonly status: Readonly<{
        set(key: string, text: string | null, options?: PluginCancellationOptions): Promise<void>;
    }>;
    readonly widget: Readonly<{
        set(key: string, widget: UiWidget | null, options?: PluginCancellationOptions): Promise<void>;
    }>;
    readonly composer: Readonly<{
        replace(text: string, options?: PluginCancellationOptions): Promise<void>;
    }>;
}
