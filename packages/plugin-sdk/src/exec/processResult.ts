/** @moduleRealm any */
import type { PluginProcessResult } from '../services/io.js';

export function isSuccessfulProcessResult(result: PluginProcessResult): boolean {
    const { observed, requestedBy } = result.termination;
    return requestedBy.kind === 'none' && observed.kind === 'exit' && observed.exitCode === 0;
}
