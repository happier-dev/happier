import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { listCodexDirectSessionCandidatesViaAppServer } from './listCodexDirectSessionCandidatesViaAppServer';
import {
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

describe('listCodexDirectSessionCandidatesViaAppServer', () => {
    it('reads the thread list page size from params.env instead of global process.env', async () => {
        await withTempDir('happier-codex-direct-app-server-page-size-', async (root) => {
            const limitsFile = join(root, 'thread-list-limits.log');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                importLines: ['import { appendFile } from "node:fs/promises";'],
                setupLines: [`const limitsFile = ${JSON.stringify(limitsFile)};`],
                bodyLines: [
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
                ],
            });

            const envScope = createCodexAppServerTestEnvScope();
            envScope.patch({ HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE: '11' });

            try {
                await listCodexDirectSessionCandidatesViaAppServer({
                    codexHome: join(root, 'codex-home'),
                    env: {
                        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
                        HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE: '7',
                    },
                });
            } finally {
                envScope.restore();
            }

            const loggedLimits = await readFile(limitsFile, 'utf8');
            expect(loggedLimits.trim().split('\n').sort()).toEqual(['7:false', '7:true']);
        });
    });

    it('emits canonical agentRuntimeDescriptorV1 for app-server thread candidates', async () => {
        await withTempDir('happier-codex-direct-app-server-runtime-descriptor-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                fileName: 'fake-codex-app-server-runtime.mjs',
                setupLines: [
                    'const threads = [{ id: "thread-1", name: "Thread One", cwd: "/repo/thread-one", updatedAt: 1736000100 }];',
                ],
                bodyLines: [
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
                ],
            });

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
});
