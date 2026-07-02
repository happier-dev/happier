import {
    createCodexAppServerClient,
    type CodexAppServerClient,
} from '@happier-dev/plugins-codex/agent/runtime/appServer/client';
import { configuration } from '@/configuration';
import { createPluginExecService } from '@/plugins/runtime/context/exec';

export async function withCodexAppServerClient<T>(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    run: (client: CodexAppServerClient) => Promise<T>;
}>): Promise<T> {
    const client = await createCodexAppServerClient({
        exec: createPluginExecService({
            rpcLogAllowedDirectories: [configuration.logsDir],
        }),
        processEnv: params.processEnv,
        cwd: params.cwd,
    });

    try {
        return await params.run(client);
    } finally {
        await client.dispose();
    }
}
