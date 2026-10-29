import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServerSession } from './serverSession';
import { createProcessActionOwnerAdapters } from '@/daemon/processes/actions/processActionOwnerAdapters';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
const definition: LanguageServerDefinition = {
    id: 'fixture/languageServers/typescript', pluginId: 'fixture', manifestPath: '/fixture/plugin.json', title: 'Fixture',
    executable: { kind: 'systemTool', id: 'server' }, args: [], languageIds: { typescript: 'typescript', tsx: 'typescriptreact' },
    initializationOptions: { userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } }, disablePushDiagnostics: true },
};
async function fixture(rootPath: string, options: Record<string, unknown> = {}) {
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const protocols: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const session = createServerSession({ definition, rootPath, workspaceRoot: rootPath, onChange: () => undefined,
        async openProtocol(input) {
            const service = createStablePluginExecService({ allowedExecutables: [definition.executable], signal: input.signal,
                processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify(options)] }),
                resolvePath: async () => rootPath,
            });
            const protocol = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest', maxFrameBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES, launch: { executable: definition.executable, cwd: rootPath } });
            protocols.push(protocol);
            return protocol;
        } });
    const messages = async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    return { session, protocols, messages };
}
describe('language server session', () => {
    it('bootstraps a delta-only server once, applies deltas across edits and returns only the visible range', async () => {
        await withTempDir('happier-lsp-semantic-delta-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true, semanticRange: false });
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'abc\ndef', version: 1, unsaved: false });
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens', range }))
                    .resolves.toMatchObject({ value: { data: [0, 0, 1, 0, 0] } });
                await session.change({ path: 'a.ts', baseVersion: 1, version: 2, unsaved: true,
                    edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, text: 'A' } });
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens', range }))
                    .resolves.toMatchObject({ value: { data: [0, 0, 2, 0, 0] } });
                const nextRange = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens', range: nextRange }))
                    .resolves.toMatchObject({ value: { data: [1, 0, 1, 0, 0] } });
                const semantic = (await messages()).filter(message => String(message.method).startsWith('textDocument/semanticTokens/'));
                expect(semantic.map(message => message.method)).toEqual([
                    'textDocument/semanticTokens/full', 'textDocument/semanticTokens/full/delta', 'textDocument/semanticTokens/full/delta',
                ]);
                expect(semantic[1]).toMatchObject({ params: { previousResultId: 'tokens-1' } });
                expect(semantic[2]).toMatchObject({ params: { previousResultId: 'tokens-2' } });
                await session.restart();
                await session.query({ path: 'a.ts', kind: 'semanticTokens', range });
                expect((await messages()).filter(message => message.method === 'textDocument/semanticTokens/full')).toHaveLength(2);
            } finally { await session.dispose(); }
        });
    });

    it('retains native completion and hierarchy items only for their captured buffer', async () => {
        await withTempDir('happier-lsp-items-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                const completion = await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 } });
                const item = (completion.value as { items: Array<{ itemId: string }> }).items[0]!;
                expect(item.itemId).toEqual(expect.any(String));
                await expect(session.query({ path: 'a.ts', kind: 'completionResolve', itemId: item.itemId }))
                    .resolves.toMatchObject({ value: { itemId: item.itemId, additionalTextEdits: [{ newText: 'import x;\n' }] } });
                expect((await messages()).find(message => message.method === 'completionItem/resolve'))
                    .toMatchObject({ params: { data: { native: true } } });
                const prepare = await session.query({ path: 'a.ts', kind: 'callHierarchy', position: { line: 0, character: 1 }, hierarchy: { direction: 'prepare' } });
                const hierarchyItem = (prepare.value as Array<{ itemId: string }>)[0]!;
                await expect(session.query({ path: 'a.ts', kind: 'callHierarchy', hierarchy: { direction: 'incoming', itemId: hierarchyItem.itemId } }))
                    .resolves.toMatchObject({ value: [{ from: { itemId: expect.any(String) } }] });
                expect((await messages()).find(message => message.method === 'callHierarchy/incomingCalls'))
                    .toMatchObject({ params: { item: { data: { native: true } } } });
                await session.snapshot({ path: 'a.ts', languageId: 'typescript', text: 'changed', version: 2, unsaved: true });
                await expect(session.query({ path: 'a.ts', kind: 'completionResolve', itemId: item.itemId })).rejects.toMatchObject({ code: 'stale_query' });
                await expect(session.query({ path: 'a.ts', kind: 'callHierarchy', hierarchy: { direction: 'outgoing', itemId: hierarchyItem.itemId } })).rejects.toMatchObject({ code: 'stale_query' });
                const next = await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 } });
                const nextItem = (next.value as { items: Array<{ itemId: string }> }).items[0]!;
                await session.restart();
                await expect(session.query({ path: 'a.ts', kind: 'completionResolve', itemId: nextItem.itemId })).rejects.toMatchObject({ code: 'stale_query' });
            } finally { await session.dispose(); }
        });
    });

    it('projects per-server capabilities and closes held documents before graceful shutdown', async () => {
        await withTempDir('happier-lsp-editing-capabilities-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true });
            await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
            try {
                await session.start();
                expect(session.status()).toMatchObject({ capabilities: { completion: true, completionResolve: true,
                    completionTriggerCharacters: ['.'], signatureHelp: true, signatureTriggerCharacters: ['('],
                    signatureRetriggerCharacters: [','], organizeImports: true, semanticTokensRange: true,
                    semanticTokensDelta: true, workspaceDiagnostics: true } });
            } finally { await session.dispose(); }
            const methods = (await messages()).map(message => message.method);
            expect(methods.indexOf('textDocument/didClose')).toBeGreaterThan(methods.indexOf('textDocument/didOpen'));
            expect(methods.indexOf('textDocument/didClose')).toBeLessThan(methods.indexOf('shutdown'));
        });
    });

    it('prepares and traverses calls in one position-addressed query for transient Action documents', async () => {
        await withTempDir('happier-lsp-transient-calls-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                await expect(session.query({ path: 'a.ts', kind: 'callHierarchy', position: { line: 0, character: 1 }, hierarchy: { direction: 'outgoing' } }))
                    .resolves.toMatchObject({ value: [{ to: { name: 'fixture', itemId: expect.any(String) } }] });
                const methods = (await messages()).map(message => message.method);
                expect(methods.indexOf('textDocument/prepareCallHierarchy')).toBeLessThan(methods.indexOf('callHierarchy/outgoingCalls'));
            } finally { await session.dispose(); }
        });
    });

    it('expands completion defaults before native resolution and retires the previous completion list', async () => {
        await withTempDir('happier-lsp-completion-defaults-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true, completionDefaults: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                const result = await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 } });
                const item = (result.value as { items: Array<{ itemId: string }> }).items[0]!;
                expect(item).toMatchObject({ insertTextFormat: 2, textEdit: { newText: expect.any(String), range: { start: { line: 0, character: 0 } } } });
                await session.query({ path: 'a.ts', kind: 'completionResolve', itemId: item.itemId });
                const resolve = (await messages()).find(message => message.method === 'completionItem/resolve');
                expect(resolve).toMatchObject({ params: { data: { native: true }, insertTextFormat: 2, textEdit: { range: { start: { line: 0, character: 0 } } } } });
                expect(resolve?.params).not.toHaveProperty('itemId');
                await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 2 } });
                await expect(session.query({ path: 'a.ts', kind: 'completionResolve', itemId: item.itemId })).rejects.toMatchObject({ code: 'stale_query' });
            } finally { await session.dispose(); }
        });
    });

    it('never requests whole-file semantic tokens or an unadvertised delta and refuses command-only import previews', async () => {
        await withTempDir('happier-lsp-read-only-features-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true, semanticDelta: false, organizerCommandOnly: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens', range }))
                    .resolves.toMatchObject({ value: { data: [0, 0, 1, 0, 0], legend: { tokenTypes: ['variable'] } } });
                expect((await messages()).find(message => message.method === 'initialize')).toMatchObject({ params: { capabilities: {
                    textDocument: { semanticTokens: { tokenTypes: expect.arrayContaining(['variable', 'function']), augmentsSyntaxTokens: true } },
                } } });
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens' })).rejects.toMatchObject({ code: 'unsupported' });
                await expect(session.query({ path: 'a.ts', kind: 'semanticTokens', previousResultId: 'tokens-1' })).rejects.toMatchObject({ code: 'unsupported' });
                await expect(session.query({ path: 'a.ts', kind: 'organizeImports' })).rejects.toMatchObject({ code: 'unsupported' });
                const methods = (await messages()).map(message => message.method);
                expect(methods.filter(method => typeof method === 'string' && method.startsWith('textDocument/semanticTokens/'))).toEqual(['textDocument/semanticTokens/range']);
                expect(methods).not.toContain('workspace/executeCommand');
                expect(methods).not.toContain('textDocument/diagnostic');
            } finally { await session.dispose(); }
        });
    });

    it.each(['cancel', 'edit'] as const)('keeps typing independent from completion and fences a late answer after %s', async action => {
        await withTempDir('happier-lsp-pending-completion-', async root => {
            const { session, protocols, messages } = await fixture(root, { editingFeatures: true, delayMethod: 'textDocument/completion' });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                const abort = new AbortController();
                const pending = session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 }, signal: abort.signal });
                const rejected = expect(pending).rejects.toMatchObject({ code: action === 'cancel' ? 'cancelled' : 'stale_query' });
                await vi.waitFor(async () => expect((await messages()).some(message => message.method === 'textDocument/completion')).toBe(true));
                if (action === 'cancel') abort.abort();
                else {
                    await session.change({ path: 'a.ts', version: 2, baseVersion: 1,
                        edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, text: 'V' }, unsaved: true });
                    expect(session.document('a.ts')).toMatchObject({ text: 'Value', version: 2 });
                    await protocols[0]!.client.notify('fixture/release', { method: 'textDocument/completion' });
                }
                await rejected;
            } finally { await session.dispose(); }
        });
    });

    it('rejects an in-flight resolve when a newer completion list replaces its native item', async () => {
        await withTempDir('happier-lsp-replaced-completion-', async root => {
            const { session, protocols, messages } = await fixture(root, { editingFeatures: true, delayMethod: 'completionItem/resolve' });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                const result = await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 } });
                const item = (result.value as { items: Array<{ itemId: string }> }).items[0]!;
                const pending = session.query({ path: 'a.ts', kind: 'completionResolve', itemId: item.itemId });
                const rejected = expect(pending).rejects.toMatchObject({ code: 'stale_query' });
                await vi.waitFor(async () => expect((await messages()).some(message => message.method === 'completionItem/resolve')).toBe(true));
                await session.query({ path: 'a.ts', kind: 'completion', position: { line: 0, character: 2 } });
                await protocols[0]!.client.notify('fixture/release', { method: 'completionItem/resolve' });
                await rejected;
            } finally { await session.dispose(); }
        });
    });

    it.each([false, true])('resolves an import preview with no opaque data, generic kind advertised: %s', async organizerGenericKind => {
        await withTempDir('happier-lsp-resolve-imports-', async root => {
            const { session, messages } = await fixture(root, { editingFeatures: true, organizerNeedsResolve: true, organizerGenericKind });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'value', version: 1, unsaved: false });
                await expect(session.query({ path: 'a.ts', kind: 'organizeImports' }))
                    .resolves.toMatchObject({ value: [{ kind: 'source.organizeImports.fixture', edit: { changes: expect.any(Object) } }] });
                const recorded = await messages();
                expect(recorded.find(message => message.method === 'codeAction/resolve')).toMatchObject({ params: { kind: 'source.organizeImports.fixture' } });
                expect(recorded.some(message => message.method === 'workspace/executeCommand')).toBe(false);
            } finally { await session.dispose(); }
        });
    });

    it('starts a stopped language server again through its retained Processes owner and replays open buffers', async () => {
        await withTempDir('happier-lsp-process-restart-', async root => {
            const { session, protocols } = await fixture(root);
            const owners = createProcessActionOwnerAdapters({});
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'editor buffer', version: 7, unsaved: true });
                await session.open({ path: 'b.ts', languageId: 'typescript', text: 'second buffer', version: 2, unsaved: false });
                await session.start();
                const generation = session.status().generation;
                const source = session.readProcessRoots()[0]!;
                const retained = { ...source, live: true, start: { startTimeMs: 1 }, ownerCreatedAtMs: source.ownerCreatedAtMs! };
                await owners.stopOwner(retained, {});
                await protocols[0].wait();
                expect(session.status().state).toBe('stopped');
                await expect(session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } }))
                    .rejects.toMatchObject({ code: 'session_unavailable' });
                expect(await owners.startOwner(retained, { verifyCurrent: async () => false }))
                    .toMatchObject({ status: 'refused', reasonCode: 'access_denied' });
                expect(await owners.startOwner(retained, {})).toEqual({ status: 'started' });
                expect(session.status()).toMatchObject({ state: 'ready' });
                expect(session.status().generation).not.toBe(generation);
                for (const [path, text, version] of [['a.ts', 'editor buffer', 7], ['b.ts', 'second buffer', 2]] as const) {
                    expect(await session.query({ path, kind: 'hover', position: { line: 0, character: 0 } }))
                        .toMatchObject({ version, value: { contents: { value: text } } });
                }
                expect(session.document('a.ts')).toMatchObject({ unsaved: true });
                // A stale Start again must not stop a replacement generation.
                expect(await owners.startOwner(retained, {})).toMatchObject({ status: 'refused' });
                expect(protocols).toHaveLength(2);
                const current = { ...session.readProcessRoots()[0]!, live: true, start: { startTimeMs: 2 }, ownerCreatedAtMs: 0 };
                await owners.stopOwner(current, {});
                await session.close('a.ts');
                await session.close('b.ts');
                expect(await owners.startOwner(current, {})).toMatchObject({ status: 'refused' });
                expect(protocols).toHaveLength(2);
            } finally { await session.dispose(); }
        });
    });

    it('reports a failed Processes start without claiming the server started', async () => {
        await withTempDir('happier-lsp-process-restart-failure-', async root => {
            const behavior = { failInitialize: false };
            const { session } = await fixture(root, behavior);
            const owners = createProcessActionOwnerAdapters({});
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'buffer', version: 1, unsaved: false });
                await session.start();
                const root = { ...session.readProcessRoots()[0]!, live: true, start: { startTimeMs: 1 }, ownerCreatedAtMs: 0 };
                await owners.stopOwner(root, {});
                behavior.failInitialize = true;
                expect(await owners.startOwner(root, {})).toMatchObject({ status: 'refused', reasonCode: 'start_failed' });
                expect(session.status()).toMatchObject({ state: 'unavailable', reason: 'start_failed' });
            } finally { await session.dispose(); }
        });
    });

    it('starts on query, answers registration before serving, and opts diagnostics in only on Check problems', async () => {
        await withTempDir('happier-lsp-session-', async (root) => {
            const { session, protocols, messages } = await fixture(root);
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'broken', version: 1, unsaved: false });
                expect(protocols).toHaveLength(0);
                const result = await session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                expect(result.value).toMatchObject({ contents: { value: 'broken' } });
                expect((await messages()).some(m => m.id === 'registration' && !m.method)).toBe(true);
                expect((await messages()).filter(m => m.method === 'textDocument/diagnostic')).toHaveLength(0);
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                expect(session.diagnostics.get('a.ts')).toMatchObject({ state: 'ready', version: 1, items: [{ message: 'broken' }] });
                expect(protocols).toHaveLength(1);
            }
            finally {
                await session.dispose();
            }
            expect((await messages()).find(m => m.method === 'shutdown')).not.toHaveProperty('params');
        });
    });
    it('keeps failed initialization sticky until explicit restart and releases the child on last close', async () => {
        await withTempDir('happier-lsp-sticky-', async (root) => {
            const { session, protocols } = await fixture(root, { failInitialize: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'a', version: 1, unsaved: false });
                await expect(session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } })).rejects.toMatchObject({ code: 'session_unavailable' });
                await expect(session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } })).rejects.toMatchObject({ code: 'session_unavailable' });
                expect(protocols).toHaveLength(1);
                expect(session.status()).toMatchObject({ state: 'unavailable', reason: 'start_failed' });
                await session.restart();
                expect(protocols).toHaveLength(2);
                await session.close('a.ts');
                await expect(protocols[1].wait()).resolves.toBeDefined();
                expect(session.status().state).toBe('stopped');
            }
            finally {
                await session.dispose();
            }
        });
    });
    it.each([0, 1, 2])('honors sync kind %s while keeping the document version', async (syncKind) => {
        await withTempDir('happier-lsp-sync-', async (root) => {
            const { session, protocols, messages } = await fixture(root, { syncKind });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'one', version: 1, unsaved: false });
                await session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                await session.change({ path: 'a.ts', version: 2, baseVersion: 1, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3, text: 'two' }, unsaved: true });
                // notify() confirms the pipe write; the barrier confirms the child consumed it.
                await protocols[0]!.client.request('fixture/barrier', {});
                const changes = (await messages()).filter(m => m.method === 'textDocument/didChange');
                if (syncKind === 0)
                    expect(changes).toHaveLength(0);
                else
                    expect(changes.at(-1)).toMatchObject({ params: { textDocument: { version: 2 }, contentChanges: [syncKind === 1 ? { text: 'two' } : { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'two' }] } });
            }
            finally {
                await session.dispose();
            }
        });
    });
});
