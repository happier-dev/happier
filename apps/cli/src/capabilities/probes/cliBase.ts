import type { CapabilityDetectRequest } from '../types';
import type { DetectCliEntry } from '../snapshots/cliSnapshot';
import { CapabilityError } from '../errors';

export function buildCliCapabilityData(opts: {
    request: CapabilityDetectRequest;
    entry: DetectCliEntry | undefined;
}): DetectCliEntry {
    const includeLoginStatus = Boolean((opts.request.params ?? {}).includeLoginStatus);
    const entry = opts.entry ?? { available: false };
    if (entry.detectionError) {
        throw new CapabilityError(entry.detectionError.message, entry.detectionError.code);
    }

    const out: DetectCliEntry = {
        available: entry.available,
        ...(entry.installed !== undefined ? { installed: entry.installed } : {}),
        ...(entry.update ? { update: entry.update } : {}),
        ...(entry.platform ? { platform: entry.platform } : {}),
        ...(entry.install ? { install: entry.install } : {}),
        ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
        ...(entry.signIn ? { signIn: entry.signIn } : {}),
        ...(entry.resolvedPath ? { resolvedPath: entry.resolvedPath } : {}),
        ...(entry.resolvedCommand ? { resolvedCommand: entry.resolvedCommand } : {}),
        ...(entry.resolutionSource ? { resolutionSource: entry.resolutionSource } : {}),
        ...(entry.version ? { version: entry.version } : {}),
        ...(includeLoginStatus ? { isLoggedIn: entry.isLoggedIn ?? null } : {}),
        ...(includeLoginStatus ? { authStatus: entry.authStatus ?? null } : {}),
    };

    return out;
}
