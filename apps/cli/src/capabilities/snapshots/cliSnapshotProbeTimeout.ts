import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

const DEFAULT_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = 3_000;

/** Shared inventory/native-auth budget; command execution must inherit it. */
export function resolveCliSnapshotProbeTimeoutMs(
    slowProbes: boolean,
    processEnv: Readonly<NodeJS.ProcessEnv> = sessionProcessEnvironment(),
): number {
    if (slowProbes) {
        const rawLoginStatus = processEnv.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS;
        const parsedLoginStatus = typeof rawLoginStatus === 'string' ? Number(rawLoginStatus) : Number.NaN;
        if (Number.isFinite(parsedLoginStatus) && parsedLoginStatus > 0) {
            return parsedLoginStatus;
        }
    }

    const raw = processEnv.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
    const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return slowProbes
        ? (processEnv.CI ? 7_000 : 6_500)
        : DEFAULT_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
}
