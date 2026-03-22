import { createCodexAppServerClient, type CodexAppServerClient } from './createCodexAppServerClient';

export async function withCodexAppServerClient<T>(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    run: (client: CodexAppServerClient) => Promise<T>;
}>): Promise<T> {
    const client = await createCodexAppServerClient({
        processEnv: params.processEnv,
        cwd: params.cwd,
    });

    try {
        return await params.run(client);
    } finally {
        await client.dispose();
    }
}
