import {
    AutomationConversationTargetsListInputV1Schema,
    AutomationConversationTargetsListResultV1Schema,
    AutomationConversationTargetVerifyInputV1Schema,
    AutomationConversationTargetVerifyResultV1Schema,
    type AutomationConversationTargetsListResultV1,
    type AutomationConversationTargetVerifyResultV1,
} from "@happier-dev/protocol";

import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";

import { loadAutomationTx } from "./automationCrudService";
import type { AutomationTargetType } from "./automationTypes";
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";

/**
 * Any plugin may bind a conversation to an Automation the Account owns, so the
 * only caller question left here is whether the host-stamped materialization is
 * still current for this Account. Which plugin is asking is not an authority
 * input; the ActionSpec declaration and its executor own that decision.
 */
export class AutomationConversationTargetVerificationCallerError extends Error {
    constructor() {
        super("automation_conversation_target_caller_not_current");
        this.name = "AutomationConversationTargetVerificationCallerError";
    }
}

async function assertCurrentAutomationConversationTargetCallerTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    caller: AutomationEventCallerV1;
}>): Promise<void> {
    try {
        await assertCurrentAutomationEventCallerMaterializationTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) {
            throw new AutomationConversationTargetVerificationCallerError();
        }
        throw error;
    }
}

function readAutomationConversationTargetLabel(row: Readonly<{ id: string; name: string }>): string {
    const name = row.name.trim();
    return name.length >= 1 && name.length <= 128 ? name : row.id;
}

/**
 * Canonical capability decision shared by target verification and the final
 * admission writer. `executionRun` currently has no truthful text-result
 * producer, while both Session targets settle through the exact-turn result
 * owner.
 */
export function classifyAutomationConversationTargetEligibilityV1(params: Readonly<{
    targetType: AutomationTargetType;
    resultDelivery: "none" | "finalResult";
}>): "eligible" | "resultDeliveryUnsupported" {
    return params.resultDelivery === "finalResult" && params.targetType === "execution_run"
        ? "resultDeliveryUnsupported"
        : "eligible";
}

/**
 * Side-effect-free target verification for conversation-binding persistence.
 * A conversation binding is an additional invocation source for an Automation
 * the Account already owns, so trigger kind does not restrict the target and
 * several bindings may name the same one. The selected result-delivery policy
 * must still be supported by that Automation's execution target.
 * Automation storage and plugin-materialization currentness remain at their
 * incumbent owners; this projection returns no definition bytes or replacement
 * version.
 */
export async function verifyAutomationConversationTargetV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetVerifyResultV1> {
    const input = AutomationConversationTargetVerifyInputV1Schema.parse(params.input);
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await inTx(async (tx) => {
        await assertCurrentAutomationConversationTargetCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: input.automationId,
        });
        if (!automation) {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: "notFound",
            });
        }
        const eligibility = classifyAutomationConversationTargetEligibilityV1({
            targetType: automation.targetType,
            resultDelivery: input.resultDelivery ?? "none",
        });
        if (eligibility !== "eligible") {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: eligibility,
            });
        }
        return AutomationConversationTargetVerifyResultV1Schema.parse({
            kind: "verified",
        });
    });
}

/**
 * Current-materialization-scoped selector for conversation-binding
 * composition. Any Automation the Account owns can take a conversation as an
 * additional invocation source, so this projects every current Automation
 * independently of its zero-or-more automatic triggers. Verification remains the final authority at
 * binding create; this projection neither carries nor grants target execution
 * authority.
 */
export async function listAutomationConversationTargetsV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetsListResultV1> {
    const input = AutomationConversationTargetsListInputV1Schema.parse(params.input);
    const limit = input.limit ?? 100;
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await inTx(async (tx) => {
        await assertCurrentAutomationConversationTargetCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        const rows = await tx.automation.findMany({
            where: {
                accountId: params.accountId,
                deletedAt: null,
                ...(input.cursor === undefined || input.cursor === null
                    ? {}
                    : { id: { gt: input.cursor } }),
            },
            orderBy: { id: "asc" },
            // One lookahead row so the picker's "Show more" affordance appears
            // only when a further Automation really exists, including when the
            // last page exactly fills the requested limit.
            take: limit + 1,
            select: {
                id: true,
                name: true,
                targetType: true,
                enabled: true,
            },
        });
        const page = rows.slice(0, limit);

        return AutomationConversationTargetsListResultV1Schema.parse({
            items: page.map((row) => ({
                automationId: row.id,
                label: readAutomationConversationTargetLabel(row),
                execution: {
                    targetType: row.targetType,
                    enabled: row.enabled,
                },
            })),
            nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
        });
    });
}
