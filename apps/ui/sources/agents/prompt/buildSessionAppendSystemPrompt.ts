import { systemPrompt as baseSystemPrompt } from '@/agents/prompt/systemPrompt';
import {
    buildExecutionRunsGuidanceBlock,
    coerceExecutionRunsGuidanceEntries,
} from '@/sync/domains/settings/executionRunsGuidance';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';

function buildExecutionRunsGuidanceBlockFromSettings(settings: Record<string, unknown>): string {
    // Guidance is only meaningful when execution runs are enabled.
    if (!resolveLocalFeaturePolicyEnabled('execution.runs', settings as any)) return '';
    if ((settings as any).executionRunsGuidanceEnabled !== true) return '';
    const maxCharsRaw = (settings as any).executionRunsGuidanceMaxChars;
    const maxChars = typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) && maxCharsRaw >= 200
        ? Math.floor(maxCharsRaw)
        : 4_000;

    const entries = coerceExecutionRunsGuidanceEntries((settings as any).executionRunsGuidanceEntries);
    const { text } = buildExecutionRunsGuidanceBlock({ entries, maxChars });
    return text;
}

export function buildSessionAppendSystemPrompt(params: Readonly<{
    settings: Record<string, unknown>;
    // Optional override (tests / experiments).
    base?: string;
}>): string {
    const base = typeof params.base === 'string' ? params.base : baseSystemPrompt;
    const guidance = buildExecutionRunsGuidanceBlockFromSettings(params.settings);
    if (!guidance) return base;
    return `${base}\n\n${guidance}`.trim();
}
