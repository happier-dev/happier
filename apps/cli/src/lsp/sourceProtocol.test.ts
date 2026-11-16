import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import type { WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import { createServerSession } from './serverSession';
import { createSourceLanguageServerProtocolOpener } from './sourceProtocol';

const definition: LanguageServerDefinition = {
    id: 'fixture/languageServers/typescript', pluginId: 'fixture', manifestPath: '/fixture/plugin.json', title: 'Fixture',
    executable: { kind: 'managedDependency', id: 'fixture/typescript-native' }, args: ['--stdio'], languageIds: { typescript: 'typescript' },
    initializationOptions: { disablePushDiagnostics: true },
};

describe('language servers in a workspace target', () => {
    it('starts the server through the source with long-lived streams, answers queries and stops it on dispose', async () => {
        await withTempDir('happier-lsp-target-', async root => {
            const log = join(root, 'messages.jsonl');
            await writeFile(log, '');
            const spawned: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
            const resolved: string[] = [];
            let exitedCode: unknown;
            // A target stand-in: it resolves the server on its own PATH and spawns it there.
            const target: WorkspaceSource = { ...localWorkspaceSource, kind: 'target', id: 'target:lsp',
                resolveExecutable: async name => { resolved.push(name); return '/target/bin/typescript-native'; },
                spawn: request => {
                    spawned.push(request);
                    const child = localWorkspaceSource.spawn({ command: process.execPath, cwd: request.cwd,
                        args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify({ editingFeatures: true, semanticRange: false })] });
                    child.once('close', code => { exitedCode = code; });
                    return child;
                } };
            const session = createServerSession({ definition, rootPath: root, workspaceRoot: root, onChange: () => undefined,
                openProtocol: createSourceLanguageServerProtocolOpener(target) });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'abc\ndef', version: 1, unsaved: false });
                const tokens = await session.query({ path: 'a.ts', kind: 'semanticTokens', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } });
                expect(tokens).toMatchObject({ value: { data: expect.any(Array) } });
                expect(resolved).toEqual(['typescript-native']);
                expect(spawned).toEqual([{ command: '/target/bin/typescript-native', args: ['--stdio'], cwd: root }]);
                const methods = String(await readFile(log, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method?: string }).method);
                expect(methods).toEqual(expect.arrayContaining(['initialize', 'initialized', 'textDocument/didOpen']));
            } finally {
                await session.dispose();
            }
            await vi.waitFor(() => expect(exitedCode).not.toBeUndefined());
        });
    });

    it('reports a server that is not installed in the target as unavailable without spawning', async () => {
        const spawned: unknown[] = [];
        const target: WorkspaceSource = { ...localWorkspaceSource, kind: 'target', id: 'target:empty',
            resolveExecutable: async () => null, spawn: request => { spawned.push(request); return localWorkspaceSource.spawn(request); } };
        const open = createSourceLanguageServerProtocolOpener(target);
        await expect(open({ definition, rootPath: '/workspace', processOwner: { kind: 'service', serviceId: 'lsp:test', pluginId: 'fixture' },
            signal: new AbortController().signal })).rejects.toMatchObject({ code: 'server_missing' });
        expect(spawned).toEqual([]);
    });
});
