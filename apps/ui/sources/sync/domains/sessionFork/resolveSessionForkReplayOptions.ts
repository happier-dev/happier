import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

import type { Settings } from '@/sync/domains/settings/settings';
import {
    resolveHappierReplayConfig,
    type HappierReplayConfigSource,
} from '@/sync/domains/session/resume/happierReplayPrompt';

export type SessionForkReplayOptions = Readonly<{
    replayMaxSeedChars?: number;
    replaySummaryRunner?: LlmTaskRunnerConfigV1;
}>;

/**
 * Only the Replay settings a fork request needs. Transcript rows already
 * subscribe to exactly these, so they can call this without widening to the
 * whole settings object.
 */
export type SessionForkReplaySettingsSource = HappierReplayConfigSource
    & Partial<Pick<Settings, 'sessionReplaySummaryRunnerV1'>>;

/**
 * The one place the UI turns account Replay settings into fork-request options.
 *
 * The canonical Replay-config owner tolerates retained preferences below the
 * usable seed minimum by reading the default. Every fork entry point consumes
 * that same value rather than forwarding an undersized stored preference.
 */
export function resolveSessionForkReplayOptions(params: Readonly<{
    settings: SessionForkReplaySettingsSource | null | undefined;
    /** The summary runner is an LLM task, so it follows the execution-runs feature. */
    executionRunsEnabled: boolean;
}>): SessionForkReplayOptions {
    const settings = params.settings ?? null;
    if (!settings) return {};

    const replayMaxSeedChars = typeof settings.sessionReplayMaxSeedChars === 'number'
        ? resolveHappierReplayConfig(settings).maxSeedChars
        : undefined;
    const replaySummaryRunner = params.executionRunsEnabled
        && settings.sessionReplayStrategy === 'summary_plus_recent'
        && settings.sessionReplaySummaryRunnerV1
        ? settings.sessionReplaySummaryRunnerV1
        : undefined;

    return {
        ...(typeof replayMaxSeedChars === 'number' ? { replayMaxSeedChars } : {}),
        ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
    };
}
