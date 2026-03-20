import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';

import {
    BackendTargetRefSchema,
    buildExecutionRunsGuidanceBlockV1,
    normalizeExecutionRunsGuidanceFingerprintV1,
    type BackendTargetRefV1,
    type ExecutionRunsGuidanceEntryV1,
} from '@happier-dev/protocol';

type ExecutionRunsGuidanceIntent = 'review' | 'plan' | 'delegate';

export type ExecutionRunsGuidanceEntry = Readonly<
    Omit<ExecutionRunsGuidanceEntryV1, 'suggestedModelId'> & {
        suggestedBackendTarget?: BackendTargetRefV1;
        suggestedModelId?: ModelMode;
    }
>;

export function coerceExecutionRunsGuidanceEntries(raw: unknown): ExecutionRunsGuidanceEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: ExecutionRunsGuidanceEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = (item as any).id;
        const description = (item as any).description;
        if (typeof id !== 'string' || id.trim().length === 0) continue;
        if (typeof description !== 'string' || description.trim().length === 0) continue;

        const title = (item as any).title;
        const enabled = (item as any).enabled;
        const suggestedIntentRaw = (item as any).suggestedIntent;
        const suggestedBackendTargetRaw = (item as any).suggestedBackendTarget;
        const suggestedModelIdRaw = (item as any).suggestedModelId;
        const exampleToolCallsRaw = (item as any).exampleToolCalls;

        const suggestedIntent =
            suggestedIntentRaw === 'review' || suggestedIntentRaw === 'plan' || suggestedIntentRaw === 'delegate'
                ? suggestedIntentRaw
                : undefined;

        const suggestedBackendTarget = (() => {
            const parsed = BackendTargetRefSchema.safeParse(suggestedBackendTargetRaw);
            return parsed.success ? parsed.data : undefined;
        })();
        const suggestedModelId =
            typeof suggestedModelIdRaw === 'string' && suggestedModelIdRaw.trim().length > 0
                ? (suggestedModelIdRaw.trim() as ModelMode)
                : undefined;

        const exampleToolCalls = Array.isArray(exampleToolCallsRaw)
            ? exampleToolCallsRaw.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
            : undefined;

        out.push({
            id: id.trim(),
            description,
            ...(typeof title === 'string' && title.trim().length > 0 ? { title: title.trim() } : {}),
            ...(typeof enabled === 'boolean' ? { enabled } : {}),
            ...(suggestedIntent ? { suggestedIntent } : {}),
            ...(suggestedBackendTarget ? { suggestedBackendTarget } : {}),
            ...(suggestedModelId ? { suggestedModelId } : {}),
            ...(exampleToolCalls && exampleToolCalls.length > 0 ? { exampleToolCalls } : {}),
        });
    }
    return out;
}

export function normalizeExecutionRunsGuidanceFingerprint(entry: ExecutionRunsGuidanceEntry): string {
    return normalizeExecutionRunsGuidanceFingerprintV1(entry as ExecutionRunsGuidanceEntryV1);
}

export function buildExecutionRunsGuidanceBlock(params: Readonly<{
    entries: readonly ExecutionRunsGuidanceEntry[];
    maxChars: number;
}>): Readonly<{
    text: string;
    includedCount: number;
    remainingCount: number;
}> {
    return buildExecutionRunsGuidanceBlockV1({
        entries: params.entries as readonly ExecutionRunsGuidanceEntryV1[],
        maxChars: params.maxChars,
    });
}
