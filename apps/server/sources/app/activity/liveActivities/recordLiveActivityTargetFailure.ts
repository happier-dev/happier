import type { LiveActivityApnsDeliveryClassification } from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { parseIntEnv } from "@/config/env";
import { db } from "@/storage/db";

const DEFAULT_TRANSIENT_FAILURE_BUDGET = 50;
const MAX_TRANSIENT_FAILURE_BUDGET = 10_000;

export type RecordLiveActivityTargetFailureParams = Readonly<{
    targetId: string;
    now: Date;
    code: string;
    classification: LiveActivityApnsDeliveryClassification;
    diagnostics: Prisma.InputJsonValue;
    env?: NodeJS.ProcessEnv;
}>;

export function resolveLiveActivityTargetTransientFailureBudget(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(
        env.HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET,
        DEFAULT_TRANSIENT_FAILURE_BUDGET,
        { min: 1, max: MAX_TRANSIENT_FAILURE_BUDGET },
    );
}

export async function recordLiveActivityTargetFailure(
    params: RecordLiveActivityTargetFailureParams,
): Promise<void> {
    const firstUpdate = await db.accountLiveActivityTarget.update({
        where: { id: params.targetId },
        data: {
            failureCount: { increment: 1 },
            lastFailureCode: params.code,
            diagnostics: params.diagnostics,
            ...(params.classification.action === "permanent_drop_target" ? { endedAt: params.now } : null),
        },
        select: {
            failureCount: true,
            endedAt: true,
        },
    });

    if (params.classification.action !== "transient_retry") return;
    if (firstUpdate.endedAt) return;

    const budget = resolveLiveActivityTargetTransientFailureBudget(params.env ?? process.env);
    if (firstUpdate.failureCount < budget) return;

    await db.accountLiveActivityTarget.update({
        where: { id: params.targetId },
        data: {
            endedAt: params.now,
        },
    });
}
