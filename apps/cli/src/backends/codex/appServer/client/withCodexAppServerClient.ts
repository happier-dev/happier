import { createCodexAppServerClient, type CodexAppServerClient } from './createCodexAppServerClient';
import { logger } from '@/ui/logger';
import type { CodexSqliteLaunch } from '../../connectedServices/codexStateFileNames';

export async function withCodexAppServerClient<T>(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    runtimeStore?: CodexSqliteLaunch;
    signal?: AbortSignal;
    onCleanup?: (cleanup: () => Promise<void>) => void;
    run: (client: CodexAppServerClient) => Promise<T>;
}>): Promise<T> {
    const client = await createCodexAppServerClient({
        processEnv: params.processEnv,
        cwd: params.cwd,
        runtimeStore: params.runtimeStore,
        ...(params.signal ? { initializeRequestOptions: { signal: params.signal } } : {}),
        onCleanup: params.onCleanup,
    });
    const onAbort = () => {
        void client.dispose().catch(() => logger.infoFile('[codex] Catalog cancellation cleanup failed'));
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        params.signal?.throwIfAborted();
        return await params.run(client);
    } finally {
        params.signal?.removeEventListener('abort', onAbort);
        await client.dispose();
    }
}
