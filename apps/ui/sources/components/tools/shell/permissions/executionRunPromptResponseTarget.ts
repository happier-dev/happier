import type { StructuredQuestionAnswerDetailsV1, StructuredQuestionAnswersV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import type { NativePermissionChoiceAnswerV1 } from '@happier-dev/protocol/sessions/permissions/nativeChoicesV1';

/**
 * One answer to a pending agent request owned by an Execution Run.
 *
 * Native permissions retain the producer's exact offered choice. Historical
 * Boolean permissions and structured questions keep their incumbent carriers.
 */
export type ExecutionRunPromptResponse =
    | Readonly<{ requestId: string; nativeChoice: NativePermissionChoiceAnswerV1 }>
    | Readonly<{ requestId: string; approved: boolean }>
    | Readonly<{ requestId: string; answers: StructuredQuestionAnswersV1; answerDetails?: StructuredQuestionAnswerDetailsV1 }>;

/**
 * The response origin a canonical prompt card uses instead of a Session.
 *
 * The cards stay the single owner of presentation and of in-flight/answered/
 * error feedback; only the transport differs. `respond` is absent whenever the
 * caller cannot vouch for the request being current, and the card then renders
 * the request without any decision control. A rejected `respond` is shown as
 * the card's own failure.
 */
export type ExecutionRunPromptResponseTarget = Readonly<{
    executionRunId: string;
    respond?: (response: ExecutionRunPromptResponse) => Promise<void>;
    /**
     * Requests whose answer the caller has sent and not yet seen settle. Their
     * controls stay withdrawn across remounts, so an opposite answer cannot race it.
     */
    pendingRequestIds: ReadonlySet<string>;
}>;

/**
 * Who a prompt card answers: a Session (the default transport) or an Execution
 * Run. Exactly one is present, so a card can never infer Session authority for
 * a request an Execution Run owns.
 */
export type PromptResponseOrigin =
    | Readonly<{ sessionId: string; executionRun?: undefined }>
    | Readonly<{ sessionId?: undefined; executionRun: ExecutionRunPromptResponseTarget }>;
