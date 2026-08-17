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
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";

export const AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1 = "happier.channels";

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
 * Side-effect-free target verification for Channels persistence. Automation
 * storage and plugin-materialization currentness remain at their incumbent
 * owners; this projection returns no definition bytes or replacement version.
 */
export async function verifyAutomationConversationTargetV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetVerifyResultV1> {
    if (params.caller.pluginId !== AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1) {
        throw new AutomationConversationTargetVerificationCallerError();
    }
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
        if (automation.triggerKind !== "conversation") {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: "notConversation",
            });
        }
        if (automation.templateVersion !== input.expectedTemplateVersion) {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: "templateVersionMismatch",
            });
        }
        if (input.resultDelivery === "finalResult" && automation.targetType === "execution_run") {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: "resultDeliveryUnsupported",
            });
        }
        return AutomationConversationTargetVerifyResultV1Schema.parse({
            kind: "verified",
            templateVersion: automation.templateVersion,
        });
    });
}

/**
 * Narrow, current-materialization-scoped selector for Channels binding
 * composition. Verification remains the final authority at binding create;
 * this projection neither carries nor grants target execution authority.
 */
export async function listAutomationConversationTargetsV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetsListResultV1> {
    if (params.caller.pluginId !== AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1) {
        throw new AutomationConversationTargetVerificationCallerError();
    }
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
                triggerKind: "conversation",
                ...(input.cursor === undefined || input.cursor === null
                    ? {}
                    : { id: { gt: input.cursor } }),
            },
            orderBy: { id: "asc" },
            take: limit + 1,
            select: { id: true, name: true, templateVersion: true },
        });
        const hasNextPage = rows.length > limit;
        const items = rows.slice(0, limit).map((row) => ({
            automationId: row.id,
            templateVersion: row.templateVersion,
            label: readAutomationConversationTargetLabel(row),
        }));

        return AutomationConversationTargetsListResultV1Schema.parse({
            items,
            nextCursor: hasNextPage ? items[items.length - 1]?.automationId ?? null : null,
        });
    });
}
