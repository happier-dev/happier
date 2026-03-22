import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const CODEX_APP_SERVER_TEST_ENV_KEYS = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
    'HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE',
    'HAPPIER_TRANSCRIPT_STORAGE',
    'CODEX_HOME',
    'OPENAI_API_KEY',
] as const;

export function createCodexAppServerTestEnvScope() {
    return createEnvKeyScope(CODEX_APP_SERVER_TEST_ENV_KEYS);
}

export function createCodexAppServerProcessEnv(
    fakeAppServer: string,
    overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
        ...overrides,
    };
}

export async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    bodyLines: readonly string[];
    importLines?: readonly string[];
    setupLines?: readonly string[];
    fileName?: string;
}>): Promise<string> {
    const scriptPath = join(params.dir, params.fileName ?? 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        ...(params.importLines ?? []),
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        ...(params.setupLines ?? []),
        ...params.bodyLines,
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

export async function writeFakeCodexAppServerThreadListScript(params: Readonly<{
    dir: string;
    nonArchivedThreads?: readonly Record<string, unknown>[];
    archivedThreads?: readonly Record<string, unknown>[];
    allowedCodexHomes?: readonly string[];
    fileName?: string;
    initializeName?: string;
}>): Promise<string> {
    return await writeFakeCodexAppServerScript({
        dir: params.dir,
        fileName: params.fileName,
        setupLines: [
            `const nonArchivedThreads = ${JSON.stringify(params.nonArchivedThreads ?? [])};`,
            `const archivedThreads = ${JSON.stringify(params.archivedThreads ?? [])};`,
            `const allowedCodexHomes = ${JSON.stringify(params.allowedCodexHomes ?? null)};`,
            'if (Array.isArray(allowedCodexHomes) && !allowedCodexHomes.includes(process.env.CODEX_HOME ?? "")) {',
            '  process.stderr.write("unexpected CODEX_HOME\\n");',
            '  process.exit(1);',
            '}',
        ],
        bodyLines: [
            'for await (const line of rl) {',
            '  if (!line.trim()) continue;',
            '  const msg = JSON.parse(line);',
            '  if (msg.method === "initialize") {',
            `    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: ${JSON.stringify(params.initializeName ?? 'fake-codex-app-server')}, version: "0.0.0" } } }) + "\\n");`,
            '    continue;',
            '  }',
            '  if (msg.method === "initialized") continue;',
            '  if (msg.method === "thread/list") {',
            '    const archived = msg.params?.archived === true;',
            '    const data = archived ? archivedThreads : nonArchivedThreads;',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data, nextCursor: null } }) + "\\n");',
            '    continue;',
            '  }',
            '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
            '}',
        ],
    });
}
