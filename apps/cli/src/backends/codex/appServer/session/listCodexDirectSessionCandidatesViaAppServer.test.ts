import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listCodexDirectSessionCandidatesViaAppServer } from './listCodexDirectSessionCandidatesViaAppServer';

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    limitsFile: string;
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import { appendFile } from "node:fs/promises";',
        'import readline from "node:readline";',
        `const limitsFile = ${JSON.stringify(params.limitsFile)};`,
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/list") {',
        '    await appendFile(limitsFile, `${String(msg.params?.limit ?? "")}:${String(msg.params?.archived === true)}\\n`, "utf8");',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

describe('listCodexDirectSessionCandidatesViaAppServer', () => {
    it('reads the thread list page size from params.env instead of global process.env', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-app-server-page-size-'));
        const limitsFile = join(root, 'thread-list-limits.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, limitsFile });

        const originalGlobalPageSize = process.env.HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE;
        process.env.HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE = '11';

        try {
            await listCodexDirectSessionCandidatesViaAppServer({
                codexHome: join(root, 'codex-home'),
                env: {
                    HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
                    HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE: '7',
                },
            });
        } finally {
            if (originalGlobalPageSize === undefined) {
                delete process.env.HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE;
            } else {
                process.env.HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE = originalGlobalPageSize;
            }
        }

        const loggedLimits = await readFile(limitsFile, 'utf8');
        expect(loggedLimits.trim().split('\n').sort()).toEqual(['7:false', '7:true']);
    });

    it('emits canonical agentRuntimeDescriptorV1 for app-server thread candidates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-app-server-runtime-descriptor-'));
        const fakeAppServer = join(root, 'fake-codex-app-server-runtime.mjs');
        const script = [
            '#!/usr/bin/env node',
            'import readline from "node:readline";',
            'const threads = [{ id: "thread-1", name: "Thread One", cwd: "/repo/thread-one", updatedAt: 1736000100 }];',
            'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
            'for await (const line of rl) {',
            '  if (!line.trim()) continue;',
            '  const msg = JSON.parse(line);',
            '  if (msg.method === "initialize") {',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
            '    continue;',
            '  }',
            '  if (msg.method === "initialized") continue;',
            '  if (msg.method === "thread/list") {',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: threads, nextCursor: null } }) + "\\n");',
            '    continue;',
            '  }',
            '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
            '}',
        ].join('\n');
        await writeFile(fakeAppServer, script, { encoding: 'utf8', mode: 0o755 });

        const result = await listCodexDirectSessionCandidatesViaAppServer({
            codexHome: join(root, 'codex-home'),
            env: {
                HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
            },
        });

        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({
                remoteSessionId: 'thread-1',
                details: expect.objectContaining({
                    agentRuntimeDescriptorV1: expect.objectContaining({
                        v: 1,
                        providerId: 'codex',
                        provider: expect.objectContaining({
                            backendMode: 'appServer',
                            vendorSessionId: 'thread-1',
                            providerExtra: expect.objectContaining({
                                v: 1,
                                runtimeAffinity: {
                                    backendMode: 'appServer',
                                    vendorSessionId: 'thread-1',
                                },
                            }),
                        }),
                    }),
                    runtimeDescriptor: expect.objectContaining({
                        v: 1,
                        providerId: 'codex',
                        provider: expect.objectContaining({
                            backendMode: 'appServer',
                            vendorSessionId: 'thread-1',
                            providerExtra: expect.objectContaining({
                                v: 1,
                                runtimeAffinity: {
                                    backendMode: 'appServer',
                                    vendorSessionId: 'thread-1',
                                },
                            }),
                        }),
                    }),
                    codexBackendMode: 'appServer',
                }),
            }),
        ]));
    });
});
