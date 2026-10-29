import { describe, expect, it } from 'vitest';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToProcess } from 'node:timers/promises';

import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import { createServerSession } from './serverSession';
import { workspacePathToUri } from './workspaceUris';

const definition: LanguageServerDefinition = {
    id: 'fixture/languageServers/behavior', pluginId: 'fixture', manifestPath: '/fixture/plugin.json', title: 'Fixture',
    executable: { kind: 'systemTool', id: 'server' }, args: [], languageIds: { typescript: 'typescript' },
};

async function fixture(rootPath: string, options: Readonly<Record<string, unknown>> = {}, definitionOverrides: Partial<LanguageServerDefinition> = {}) {
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const protocols: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const observedDiagnostics: string[] = [];
    const listeners = new Set<() => void>();
    const session = createServerSession({
        definition: { ...definition, ...definitionOverrides }, rootPath, workspaceRoot: rootPath, platform: 'linux', onChange: () => {
            for (const entry of session.diagnostics.values()) observedDiagnostics.push(...entry.items.map(item => item.message));
            for (const listener of listeners) listener();
        },
        async openProtocol(input) {
            const service = createStablePluginExecService({
                allowedExecutables: [definition.executable], signal: input.signal, processOwner: input.processOwner,
                isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({
                    command: process.execPath,
                    args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify(options)],
                }),
                resolvePath: async () => rootPath,
            });
            const protocol = await service.clients.spawn({
                kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest',
                maxFrameBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES,
                launch: { executable: definition.executable, cwd: rootPath },
            });
            protocols.push(protocol);
            return protocol;
        },
    });
    const messages = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { method?: string; id?: string | number; params?: unknown });
    async function received(method: string, occurrence = 1) {
        let wake: (() => void) | undefined;
        const watcher = watch(log, () => wake?.());
        try {
            for (;;) {
                const changed = new Promise<void>(resolve => { wake = resolve; });
                const message = (await messages()).filter(value => value.method === method)[occurrence - 1];
                if (message) return message;
                await changed;
            }
        } finally {
            watcher.close();
        }
    }
    const barrier = () => protocols.at(-1)!.client.request('fixture/barrier');
    async function stateWhen(predicate: () => boolean) {
        if (predicate()) return;
        await new Promise<void>(resolve => {
            const listener = () => {
                if (!predicate()) return;
                listeners.delete(listener);
                resolve();
            };
            listeners.add(listener);
            listener();
        });
    }
    return { session, protocols, messages, received, barrier, observedDiagnostics, stateWhen };
}

const document = { path: 'a.ts', languageId: 'typescript', text: 'broken', version: 1, unsaved: false };
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe('language server session process behavior', () => {
    it('configures notification-based servers before opening documents, once per server start', async () => {
        await withTempDir('happier-lsp-settings-', async root => {
            const settings = { fixture: { validate: true, schemas: [{ fileMatch: ['*.fixture'], schema: { type: 'object' } }] } };
            const f = await fixture(root, {}, { settings });
            try {
                await f.session.open(document);
                await f.session.start();
                await f.barrier();
                await f.session.query({ path: document.path, kind: 'hover', position: { line: 0, character: 0 } });
                const messages = await f.messages();
                const configurations = messages.filter(message => message.method === 'workspace/didChangeConfiguration');
                expect(configurations).toEqual([expect.objectContaining({ params: { settings } })]);
                expect(messages.indexOf(configurations[0])).toBeLessThan(messages.findIndex(message => message.method === 'textDocument/didOpen'));
            } finally { await f.session.dispose(); }
        });
    });
    it('cancels a delayed hover through the managed codec and sends its wire request id once', async () => {
        await withTempDir('happier-lsp-cancel-', async root => {
            const { session, protocols, messages, received, barrier } = await fixture(root, { delayHover: true });
            try {
                await session.open(document);
                const signal = new AbortController();
                const pending = session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 }, signal: signal.signal });
                const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
                const request = await received('textDocument/hover');
                signal.abort();
                signal.abort();
                await rejection;
                await barrier();
                expect((await messages()).filter(message => message.method === '$/cancelRequest'))
                    .toEqual([expect.objectContaining({ params: { id: request.id } })]);
                expect(protocols).toHaveLength(1);
            } finally { await session.dispose(); }
        });
    });

    it.each([1, 2])('rejects a delayed answer after a snapshot changes text at version %s', async version => {
        await withTempDir('happier-lsp-stale-', async root => {
            const { session, protocols, received } = await fixture(root, { delayHover: true });
            try {
                await session.open(document);
                const pending = session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                const rejection = expect(pending).rejects.toMatchObject({ code: 'stale_query' });
                await received('textDocument/hover');
                await session.snapshot({ ...document, text: 'fixed', version });
                await protocols[0].client.notify('fixture/release');
                await rejection;
            } finally { await session.dispose(); }
        });
    });

    it('invalidates a pending old-process query on restart and replays the current document', async () => {
        await withTempDir('happier-lsp-restart-', async root => {
            const { session, protocols, received } = await fixture(root, { delayHover: true });
            try {
                await session.open(document);
                const pending = session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                const outcome = pending.then(value => value, error => error as unknown);
                await received('textDocument/hover');
                const generation = session.status().generation;
                await session.snapshot({ ...document, text: 'latest', version: 2 });
                await session.restart();
                expect(await outcome).toMatchObject({ code: expect.stringMatching(/^(stale_query|session_unavailable|cancelled)$/) });
                expect(session.status().generation).not.toBe(generation);
                const replay = session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                await received('textDocument/hover', 2);
                await protocols[1].client.notify('fixture/release');
                await expect(replay).resolves.toMatchObject({ version: 2, value: { contents: { value: 'latest' } } });
            } finally { await session.dispose(); }
        });
    });

    it('fences pushed diagnostics by the held version and replaces an entry with authoritative empty', async () => {
        await withTempDir('happier-lsp-push-', async root => {
            const { session, protocols, barrier } = await fixture(root, { diagnosticsMode: 'push' });
            try {
                await session.open(document);
                await session.start();
                await expect(session.query({ path: 'a.ts', kind: 'diagnostics' })).resolves.toMatchObject({ loading: true, value: [] });
                const client = protocols[0].client;
                const uri = workspacePathToUri({ rootPath: root, platform: 'linux' }, 'a.ts');
                const push = async (version: number, message: string | null) => {
                    await client.notify('fixture/publishDiagnostics', { uri, version, diagnostics: message ? [{ range, severity: 1, message }] : [] });
                    await barrier();
                };
                await push(1, 'old');
                expect(session.diagnostics.get('a.ts')).toMatchObject({ version: 1, items: [{ message: 'old' }] });
                await session.snapshot({ ...document, text: 'fixed', version: 2 });
                await push(1, 'stale');
                expect(session.diagnostics.get('a.ts')?.items.map(item => item.message)).toEqual(['old']);
                await push(2, 'current');
                expect(session.diagnostics.get('a.ts')).toMatchObject({ version: 2, items: [{ message: 'current' }] });
                await push(2, null);
                expect(session.diagnostics.get('a.ts')).toMatchObject({ state: 'ready', version: 2, items: [] });
            } finally { await session.dispose(); }
        });
    });

    it('re-pulls an opted-in open document when an external change causes server refresh', async () => {
        await withTempDir('happier-lsp-refresh-', async root => {
            const { session, received } = await fixture(root, { externalDiagnosticMessage: 'imported file changed' });
            try {
                await session.open({ ...document, text: 'clean' });
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                expect(session.diagnostics.get('a.ts')?.items).toEqual([]);
                await session.external(['b.ts']);
                await received('workspace/didChangeWatchedFiles');
                await expect.poll(() => session.diagnostics.get('a.ts')?.items.map(item => item.message)).toEqual(['imported file changed']);
            } finally { await session.dispose(); }
        });
    });

    it('ignores an old process diagnostic push emitted during restart shutdown', async () => {
        await withTempDir('happier-lsp-old-generation-push-', async root => {
            const { session, observedDiagnostics } = await fixture(root, { pushOnShutdown: 'old process push' });
            try {
                await session.open(document);
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                expect(observedDiagnostics).toContain('broken');
                await session.restart();
                expect(observedDiagnostics).not.toContain('old process push');
            } finally { await session.dispose(); }
        });
    });

    it('retains a push received before opt-in and exposes it only after Check problems', async () => {
        await withTempDir('happier-lsp-preoptin-push-', async root => {
            const { session, protocols, barrier, messages } = await fixture(root, { diagnosticsMode: 'push' });
            try {
                await session.open(document);
                await session.start();
                await protocols[0].client.notify('fixture/publishDiagnostics', {
                    uri: workspacePathToUri({ rootPath: root, platform: 'linux' }, 'a.ts'), version: 1,
                    diagnostics: [{ range, severity: 1, message: 'initial push' }],
                });
                await barrier();
                expect(session.diagnostics.size).toBe(0);
                await expect(session.query({ path: 'a.ts', kind: 'diagnostics' })).resolves.toMatchObject({
                    loading: false, value: [{ message: 'initial push' }], version: 1,
                });
                expect(session.diagnostics.get('a.ts')).toMatchObject({ state: 'ready', items: [{ message: 'initial push' }] });
                expect((await messages()).some(message => message.method === 'textDocument/diagnostic')).toBe(false);
            } finally { await session.dispose(); }
        });
    });

    it('continues refreshing other open documents after one document pull fails', async () => {
        await withTempDir('happier-lsp-refresh-failure-', async root => {
            const { session, stateWhen, barrier } = await fixture(root, {
                externalDiagnosticMessage: 'dependency changed', failRefreshDiagnosticPath: 'a.ts',
            });
            try {
                await session.open({ ...document, text: 'clean' });
                await session.open({ ...document, path: 'b.ts', text: 'clean' });
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                await session.external(['dependency.ts']);
                await stateWhen(() => session.diagnostics.get('a.ts')?.state === 'unavailable');
                // Let the refresh continuation issue its next request, then drain the real child transport.
                await yieldToProcess();
                await barrier();
                expect(session.diagnostics.get('b.ts')).toMatchObject({ state: 'ready', items: [{ message: 'dependency changed' }] });
            } finally { await session.dispose(); }
        });
    });

    it('checks every already-open document on the first diagnostics opt-in', async () => {
        await withTempDir('happier-lsp-first-check-', async root => {
            const { session } = await fixture(root);
            try {
                await session.open({ ...document, text: 'clean' });
                await session.open({ ...document, path: 'b.ts', text: 'clean' });
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                expect(session.diagnostics.get('b.ts')).toMatchObject({ state: 'ready', version: 1, items: [] });
            } finally { await session.dispose(); }
        });
    });

    it('cancels a delayed diagnostics Check through its caller signal and the managed wire codec', async () => {
        await withTempDir('happier-lsp-check-cancel-', async root => {
            const { session, protocols, received, messages, barrier } = await fixture(root, { delayDiagnostic: true, delayDiagnosticPath: 'a.ts' });
            try {
                await session.open(document);
                await session.open({ ...document, path: 'b.ts', text: 'clean' });
                const controller = new AbortController();
                const pending = session.query({ path: 'a.ts', kind: 'diagnostics', signal: controller.signal });
                const outcome = pending.then(value => value, error => error as unknown);
                const request = await received('textDocument/diagnostic');
                controller.abort();
                await protocols[0].client.notify('fixture/release');
                const result = await outcome;
                await barrier();
                expect((await messages()).filter(message => message.method === '$/cancelRequest'))
                    .toEqual([expect.objectContaining({ params: { id: request.id } })]);
                expect(result).toMatchObject({ code: 'cancelled' });
                expect((await messages()).filter(message => message.method === 'textDocument/diagnostic'))
                    .toEqual([expect.objectContaining({ id: request.id })]);
            } finally { await session.dispose(); }
        });
    });

    it('makes current push diagnostics authoritative when announced project loading ends', async () => {
        await withTempDir('happier-lsp-push-loading-', async root => {
            const { session, protocols, barrier, messages } = await fixture(root, { diagnosticsMode: 'push' });
            try {
                await session.open(document);
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                const client = protocols[0].client;
                await client.request('fixture/progress', { kind: 'begin', token: 'project' });
                await client.request('fixture/progress', { kind: 'end', token: 'project' });
                await expect(session.query({ path: 'a.ts', kind: 'diagnostics' })).resolves.toMatchObject({ loading: true, value: [] });
                for (const message of [null, 'loading diagnostic']) {
                    await client.request('fixture/progress', { kind: 'begin', token: 'project' });
                    expect(session.status().loading).toBe(true);
                    await client.notify('fixture/publishDiagnostics', {
                        uri: workspacePathToUri({ rootPath: root, platform: 'linux' }, 'a.ts'), version: 1,
                        diagnostics: message ? [{ range, severity: 1, message }] : [],
                    });
                    await barrier();
                    expect(session.diagnostics.get('a.ts')?.state).toBe('checking');
                    await client.request('fixture/progress', { kind: 'end', token: 'project' });
                    expect(session.status().loading).toBe(false);
                    expect(session.diagnostics.get('a.ts')).toMatchObject({ state: 'ready', items: message ? [{ message }] : [] });
                    await expect(session.query({ path: 'a.ts', kind: 'diagnostics' })).resolves.toMatchObject({ loading: false });
                }
                expect((await messages()).some(message => message.method === 'textDocument/diagnostic')).toBe(false);
            } finally { await session.dispose(); }
        });
    });
});
