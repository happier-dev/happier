import { isDeepStrictEqual } from 'node:util';
import { projectPluginFailureText } from '../lifecycle/utils';
import type { PluginReloadResult } from './controller';

/** A failed acquisition publishes changed availability, not another read of it. */
export function createInitializationFailureResult(
    previous: PluginReloadResult | null,
    generation: number,
    attemptedGeneration: number,
    error: unknown,
    diagnosticsByPluginId: PluginReloadResult['diagnosticsByPluginId'] = Object.freeze({}),
): Extract<PluginReloadResult, { ok: false }> {
    const result: Extract<PluginReloadResult, { ok: false }> = {
        ok: false,
        generation,
        attemptedGeneration,
        requestedPluginIds: Object.freeze([]),
        changedPluginIds: Object.freeze([]),
        affectedPluginIds: Object.freeze([]),
        runningSessionDisposition: null,
        activeGenerationId: null,
        registryStatus: 'unavailable',
        diagnostics: Object.freeze([Object.freeze({
            code: 'plugin_reload_failed' as const,
            message: projectPluginFailureText(error),
        })]),
        diagnosticsByPluginId,
        registry: null,
    };
    return previous?.ok === false && isDeepStrictEqual(previous, result) ? previous : result;
}
