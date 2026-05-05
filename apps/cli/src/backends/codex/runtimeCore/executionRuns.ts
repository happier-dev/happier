import { resolveCodexSpawnExtrasForRuntime } from '@happier-dev/agents';

import { permissionMode as normalizePermissionMode } from '@/agent/executionRuns/policy/permissionMode';
import type {
    ExecutionRunBackendFactory,
    ExecutionRunBackendFactoryOptions,
} from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import { buildCodexAcpEnvOverrides } from '../acp/env';
import { createCodexAcpBackend } from '../acp/backend';
import { resolveCodexAcpSpawn } from '../acp/resolveCommand';
import { validateCodexAcpSpawnAvailability } from '../acp/spawnAvailability';
import { appServerBackend } from '../executionRuns/appServerBackend';
import { appServerAvailability } from '../executionRuns/appServerAvailability';
import { mcpBackend } from '../executionRuns/mcpBackend';
import { transport as pickTransport } from '../executionRuns/transport';

export const createCodexExecutionRunBackend: ExecutionRunBackendFactory = (opts) => {
    const baseEnv = opts.isolation?.env;
    const env = buildCodexAcpEnvOverrides({ baseEnv, projectDir: opts.cwd });
    const permissionMode = normalizePermissionMode(opts.permissionMode);
    const runtimeExtras = opts.accountSettings
        ? resolveCodexSpawnExtrasForRuntime({
            settings: opts.accountSettings,
            processEnv: env,
        })
        : {};
    const preferredTransport = typeof env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT === 'string'
        ? env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT
        : typeof runtimeExtras.codexBackendMode === 'string'
            ? runtimeExtras.codexBackendMode
            : undefined;
    const transport = pickTransport({
        hasInteractiveTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        preferredTransport,
        start: opts.start ?? null,
    });

    if (transport === 'appServer' && appServerAvailability({ env })) {
        return appServerBackend({
            cwd: opts.cwd,
            env,
            permissionHandler: opts.permissionHandler,
            permissionMode,
        });
    }

    const shouldUseMcp = transport === 'mcp' || shouldUseCodexMcpExecutionRunBackend({
        env,
        permissionMode,
    });

    if (shouldUseMcp) {
        return mcpBackend({
            cwd: opts.cwd,
            env,
            modelId: opts.modelId,
            permissionMode,
        });
    }

    return createCodexAcpExecutionRunBackend({
        cwd: opts.cwd,
        env,
        permissionHandler: opts.permissionHandler,
        permissionMode,
    });
};

function shouldUseCodexMcpExecutionRunBackend(params: Readonly<{
    env: NodeJS.ProcessEnv;
    permissionMode: ReturnType<typeof normalizePermissionMode>;
}>): boolean {
    try {
        const spawnSpec = resolveCodexAcpSpawn({
            permissionMode: params.permissionMode,
            env: params.env,
        });
        return !validateCodexAcpSpawnAvailability(spawnSpec, { env: params.env }).ok;
    } catch {
        return true;
    }
}

function createCodexAcpExecutionRunBackend(opts: Readonly<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    permissionMode: ReturnType<typeof normalizePermissionMode>;
    permissionHandler: ExecutionRunBackendFactoryOptions['permissionHandler'];
}>): ExecutionRunHostRuntime {
    const { backend } = createCodexAcpBackend({
        cwd: opts.cwd,
        env: opts.env,
        permissionHandler: opts.permissionHandler,
        permissionMode: opts.permissionMode,
    });
    return backend;
}
