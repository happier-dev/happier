import { resolveCodexSessionBackendMode } from '@happier-dev/agents';

import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { withCodexAppServerClient } from '@/backends/codex/appServer/client/withCodexAppServerClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';

async function readControls(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    accountSettings?: Readonly<Record<string, unknown>> | null;
}>): Promise<Awaited<ReturnType<typeof readCodexAppServerSessionControls>> | null> {
    const backendMode =
        resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null }) ?? 'appServer';
    if (backendMode !== 'appServer') {
        return null;
    }

    const authMethod = readCodexEnvironmentAuthState().method;
    return await withCodexAppServerClient({
        processEnv: {
            ...process.env,
            // Ensure slow `model/list` does not silently downgrade the UI to static models (which have no model options).
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs)))),
        },
        cwd: params.cwd,
        run: async (client) =>
            readCodexAppServerSessionControls({
                client,
                authMethod,
            }),
    });
}

export const codexPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
    failureCacheStrategy: 'retry',
    probeModelsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
        });
        return controls ? controls.availableModels : null;
    },
    probeModesRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
        });
        return controls ? controls.availableModes : null;
    },
    probeConfigOptionsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
        });
        return controls ? controls.configOptions : null;
    },
};
