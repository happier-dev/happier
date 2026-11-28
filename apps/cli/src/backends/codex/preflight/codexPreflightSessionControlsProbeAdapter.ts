import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { withCodexAppServerControlClient } from '@/backends/codex/appServer/control/withCodexAppServerControlClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';
import { listCodexAppServerSkills } from '@/backends/codex/appServer/pluginAndSkillCatalog';
import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import { probeAcpCatalogs } from '@/capabilities/probes/probeAcpCatalogs';

async function readControls(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    processEnv?: NodeJS.ProcessEnv;
    includeConfiguredModel?: boolean;
    signal?: AbortSignal;
    onNativeCleanup?: (cleanup: () => Promise<void>) => void;
}>): Promise<Awaited<ReturnType<typeof readCodexAppServerSessionControls>> | null> {
    const processEnv = {
        ...(params.processEnv ?? process.env),
        // config/read includes unrelated local settings. Keep its payload out of optional RPC traces.
        ...(params.includeConfiguredModel ? { HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: undefined } : {}),
        // Ensure slow `model/list` does not silently downgrade the UI to static models (which have no model options).
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs)))),
    };
    const authMethod = readCodexEnvironmentAuthState(processEnv).method;
    const result = await withCodexAppServerControlClient({
        processEnv,
        cwd: params.cwd,
        accountSettings: params.accountSettings ?? null,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onCleanup: params.onNativeCleanup,
        run: async (client) =>
            readCodexAppServerSessionControls({
                client,
                authMethod,
                ...(params.includeConfiguredModel ? { configuredModelCwd: params.cwd } : {}),
            }),
    });
    return result.ok ? result.value : null;
}

export const codexPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
    connectedServiceAuth: 'materialized-env',
    failureCacheStrategy: 'retry',
    probeCatalogsRaw: async (params) => {
        const backendMode = resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null });
        if (backendMode === 'acp') return await probeAcpCatalogs({ ...params, agentId: 'codex' });
        const result = await withCodexAppServerControlClient({
            cwd: params.cwd,
            accountSettings: params.accountSettings ?? null,
            processEnv: params.processEnv,
            timeoutMs: params.timeoutMs,
            signal: params.signal,
            onCleanup: params.onNativeCleanup,
            run: (client) => listCodexAppServerSkills({ client, cwd: params.cwd }),
        });
        if (!result.ok) {
            if (result.errorCode === 'unsupported_codex_app_server_control') {
                return { commands: null, skills: null, diagnostic: result.error };
            }
            throw new Error(result.error);
        }
        return {
            commands: null,
            skills: result.value.supported ? result.value.skills : null,
            ...(result.value.diagnostic ? { diagnostic: result.value.diagnostic } : {}),
        };
    },
    probeModelsRaw: async (params) => {
        const controls = await readControls(params);
        if (!controls?.modelsObserved) return null;
        return {
            availableModels: controls.availableModels,
            ...(controls.configuredModelId ? { configuredModelId: controls.configuredModelId } : {}),
        };
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
