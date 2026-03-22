import type { CapabilityDetectRequest } from '../types';
import type { DetectCliEntry } from '../snapshots/cliSnapshot';

export function buildCliCapabilityData(opts: {
    request: CapabilityDetectRequest;
    entry: DetectCliEntry | undefined;
}): DetectCliEntry {
    const includeLoginStatus = Boolean((opts.request.params ?? {}).includeLoginStatus);
    const entry = opts.entry ?? { available: false };

    const out: DetectCliEntry = {
        available: entry.available,
        ...(entry.resolvedPath ? { resolvedPath: entry.resolvedPath } : {}),
        ...(entry.resolvedCommand ? { resolvedCommand: entry.resolvedCommand } : {}),
        ...(entry.resolutionSource ? { resolutionSource: entry.resolutionSource } : {}),
        ...(entry.version ? { version: entry.version } : {}),
        ...(includeLoginStatus ? { isLoggedIn: entry.isLoggedIn ?? null } : {}),
        ...(includeLoginStatus ? { authStatus: entry.authStatus ?? null } : {}),
    };

    return out;
}
