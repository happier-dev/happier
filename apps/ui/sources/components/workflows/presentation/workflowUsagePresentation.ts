import type { WorkflowProgressEnvelopeV1, WorkflowUsageV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { t } from '@/text';

/** Exact completed-attempt timing only; missing finish facts are not inferred from index timestamps. */
export function formatWorkflowInvocationElapsedLabel(timing: WorkflowProgressEnvelopeV1['timing']): string | null {
    if (timing?.finishedAt === undefined) return null;
    const ms = Date.parse(timing.finishedAt) - Date.parse(timing.startedAt);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return formatElapsedDuration(ms);
}

/**
 * Locale-aware presentation for the Workflow usage dimensions currently
 * reported by execution owners. Missing dimensions remain unknown rather than
 * being presented as zero.
 */
export function formatWorkflowUsageLabel(
    usage: WorkflowUsageV1,
    labels: Readonly<{ tokens: string; input: string; output: string }>,
): string | null {
    const parts: string[] = [];
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        parts.push(`${formatTokenCountLong(usage.inputTokens + usage.outputTokens)} ${labels.tokens}`);
    } else if (usage.inputTokens !== undefined) {
        parts.push(`${formatTokenCountLong(usage.inputTokens)} ${labels.tokens} · ${labels.input}`);
    } else if (usage.outputTokens !== undefined) {
        parts.push(`${formatTokenCountLong(usage.outputTokens)} ${labels.tokens} · ${labels.output}`);
    }
    if (usage.costUsd !== undefined) {
        parts.push(formatUsageCost(usage.costUsd, 'USD'));
    }
    return parts.length === 0 ? null : parts.join(' · ');
}
