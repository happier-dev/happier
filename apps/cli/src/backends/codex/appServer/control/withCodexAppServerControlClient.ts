import { resolveCodexSessionBackendMode } from '@happier-dev/agents';

import { withCodexAppServerClient } from '../client/withCodexAppServerClient';
import type { CodexAppServerClient } from '../client/createCodexAppServerClient';
import { resolveCodexAppServerProcessEnvFromMetadata } from '../resolveCodexAppServerProcessEnv';

export type CodexAppServerControlClientResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{
        ok: false;
        errorCode: 'unsupported_codex_app_server_control' | 'codex_app_server_control_unavailable';
        error: string;
    }>;

const MIN_CONTROL_RPC_TIMEOUT_MS = 250;
const MAX_CONTROL_RPC_TIMEOUT_MS = 60_000;

function resolveControlRpcTimeoutMs(timeoutMs: number | null | undefined): number | null {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return null;
    return Math.max(
        MIN_CONTROL_RPC_TIMEOUT_MS,
        Math.min(MAX_CONTROL_RPC_TIMEOUT_MS, Math.trunc(timeoutMs)),
    );
}

async function buildControlProcessEnv(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    metadata?: unknown;
    timeoutMs?: number | null;
}>): Promise<NodeJS.ProcessEnv> {
    const timeoutMs = resolveControlRpcTimeoutMs(params.timeoutMs);
    return {
        ...await resolveCodexAppServerProcessEnvFromMetadata({
            processEnv: params.processEnv,
            metadata: params.metadata,
        }),
        ...(timeoutMs !== null ? { HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(timeoutMs) } : {}),
    };
}

export async function withCodexAppServerControlClient<T>(params: Readonly<{
    cwd: string;
    metadata?: unknown;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    processEnv?: NodeJS.ProcessEnv;
    timeoutMs?: number | null;
    run: (client: CodexAppServerClient) => Promise<T>;
}>): Promise<CodexAppServerControlClientResult<T>> {
    const backendMode = resolveCodexSessionBackendMode({
        metadata: params.metadata ?? null,
        accountSettings: params.accountSettings ?? null,
    });
    if (backendMode !== 'appServer') {
        return {
            ok: false,
            errorCode: 'unsupported_codex_app_server_control',
            error: 'unsupported_codex_app_server_control',
        };
    }

    let clientStarted = false;
    try {
        const value = await withCodexAppServerClient({
            cwd: params.cwd,
            processEnv: await buildControlProcessEnv({
                processEnv: params.processEnv,
                metadata: params.metadata,
                timeoutMs: params.timeoutMs,
            }),
            run: async (client) => {
                clientStarted = true;
                return await params.run(client);
            },
        });
        return { ok: true, value };
    } catch (error) {
        if (clientStarted) {
            throw error;
        }
        return {
            ok: false,
            errorCode: 'codex_app_server_control_unavailable',
            error: 'codex_app_server_control_unavailable',
        };
    }
}
