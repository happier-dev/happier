import {
    AutomationReplyHandoffTargetV1Schema,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    validateWorkflowStoredEnvelopeOuterForModeV1,
} from "@happier-dev/protocol";

/**
 * The facts Conversation admission froze on the Run. Nothing in the product
 * can edit them afterwards: the reply target, the handoff/occurrence identity,
 * and the result/reply-context envelope shells are written once and then only
 * read.
 */
export type AutomationReplyHandoffImmutableFacts = Readonly<{
    id: string;
    accountId: string;
    /** The existing Run lifecycle discriminator; no second result format is written. */
    workflowCustodyState?: string | null;
    occurrenceKey: string | null;
    replyHandoffId: string | null;
    replyHandoffActionPluginId: string | null;
    replyHandoffActionLocalId: string | null;
    replyHandoffTargetMachineId: string | null;
    replyHandoffTargetMachineInstallationId: string | null;
    replyHandoffTargetMaterializationId: string | null;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
}>;

export type AutomationReplyHandoffDispatchability =
    | "dispatchable"
    | "immutableHandoffInvalid";

function parseJson(raw: string | null): unknown | undefined {
    if (typeof raw !== "string") return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

/**
 * The one owner of "can this frozen reply handoff ever be dispatched".
 *
 * The claim path uses it to refuse work, and the Run projection and present-user
 * recovery use the same answer, so the product can never offer a Retry that the
 * claim path is guaranteed to re-block. `immutableHandoffInvalid` is terminal by
 * construction: every fact it inspects was frozen at admission, so no external
 * repair, machine change, plugin update, or later attempt can change the
 * verdict. Account currentness is deliberately not part of this classification —
 * it moves on its own and is the caller's separate, recoverable concern.
 */
export function classifyAutomationReplyHandoffDispatchability(input: Readonly<{
    facts: AutomationReplyHandoffImmutableFacts;
    mode: "plain" | "e2ee";
}>): AutomationReplyHandoffDispatchability {
    const { facts } = input;
    if (typeof facts.occurrenceKey !== "string" || typeof facts.replyHandoffId !== "string") {
        return "immutableHandoffInvalid";
    }

    const target = AutomationReplyHandoffTargetV1Schema.safeParse({
        accountId: facts.accountId,
        machineId: facts.replyHandoffTargetMachineId,
        machineInstallationId: facts.replyHandoffTargetMachineInstallationId,
        materializationId: facts.replyHandoffTargetMaterializationId,
        actionRef: {
            pluginId: facts.replyHandoffActionPluginId,
            localId: facts.replyHandoffActionLocalId,
        },
    });
    if (!target.success) return "immutableHandoffInvalid";

    const result = facts.workflowCustodyState != null
        ? validateWorkflowStoredEnvelopeOuterForModeV1({
            mode: input.mode,
            binding: { v: 1, purpose: "final_result", accountId: facts.accountId, runId: facts.id },
            envelope: parseJson(facts.resultEnvelope),
        })
        : validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
            content: "result",
            mode: input.mode,
            envelope: parseJson(facts.resultEnvelope),
        });
    if (result.kind !== "available") return "immutableHandoffInvalid";

    const replyContext = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
        content: "replyContext",
        mode: input.mode,
        envelope: parseJson(facts.replyContextEnvelope),
    });
    return replyContext.kind === "available" ? "dispatchable" : "immutableHandoffInvalid";
}
