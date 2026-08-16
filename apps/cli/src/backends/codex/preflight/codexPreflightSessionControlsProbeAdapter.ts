import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { withCodexAppServerControlClient } from '@/backends/codex/appServer/control/withCodexAppServerControlClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';

async function readControls(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<Awaited<ReturnType<typeof readCodexAppServerSessionControls>> | null> {
    const processEnv = {
        ...(params.processEnv ?? process.env),
        // Ensure slow `model/list` does not silently downgrade the UI to static models (which have no model options).
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs)))),
    };
    const authMethod = readCodexEnvironmentAuthState(processEnv).method;
    const result = await withCodexAppServerControlClient({
        processEnv,
        cwd: params.cwd,
        accountSettings: params.accountSettings ?? null,
        timeoutMs: params.timeoutMs,
        run: async (client) =>
            readCodexAppServerSessionControls({
                client,
                authMethod,
            }),
    });
    return result.ok ? result.value : null;
}

export const codexPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
    connectedServiceAuth: 'materialized-env',
    failureCacheStrategy: 'retry',
    probeModelsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.availableModels : null;
    },
    probeModesRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.availableModes : null;
    },
    probeConfigOptionsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.configOptions : null;
    },
};
