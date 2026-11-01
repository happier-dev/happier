import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { MachineResourcesPolicyGetResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createLanguageServerHost, type LanguageServerHostOptions } from './languageServerHost';
import { createLanguageServerProjectChecker } from './projectCheck';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { isPidAlive } from '@/testkit/process/spawn';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { DaemonLspApplyResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { pathToFileURL } from 'node:url';
import { applyWorkspaceFileTextEdits, buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { applyWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import type { ResolvedLanguageServerContribution } from '@/plugins/projection/registry/types';
import { readLspObject } from './languageServerResults';
import { createCodeIntelligenceController } from '../../../ui/sources/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
// Filesystem scheduling is the external boundary in the acquire/close regressions.
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, readFile: vi.fn(actual.readFile) };
});
function fixtureProjectChecker(rootPath: string, scenario: string, count?: number) {
    return createLanguageServerProjectChecker({ async acquireExec(input) {
        // Executable resolution is the OS boundary; the actual process owner,
        // compiler-output decoder and host projection remain real.
        const service = createStablePluginExecService({ allowedExecutables: [input.definition.executable], signal: input.signal,
            processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
            resolveExecutable: async () => ({ command: process.execPath,
                args: [resolve('src/lsp/__fixtures__/projectCheck.cjs'), scenario, join(rootPath, 'started'), ...(count === undefined ? [] : [String(count)])] }),
            resolvePath: async () => rootPath });
        return { service, signal: input.signal, release: async () => {} };
    } });
}
async function waitForProjectChecker(rootPath: string) {
    let wake: (() => void) | undefined;
    const watcher = watch(rootPath, () => wake?.());
    try {
        for (;;) {
            const changed = new Promise<void>(resolve => { wake = resolve; });
            try { if (await readFile(join(rootPath, 'started'), 'utf8') === 'ready') return; }
            catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
            await changed;
        }
    } finally { watcher.close(); }
}
async function fixture(rootPath: string, count = 1, behavior: Record<string, unknown> = {}, rootMarkers?: readonly string[], readPolicy?: MachineResourcesPolicyReader,
    definitionOverrides?: readonly Partial<ResolvedLanguageServerContribution['definition']>[], platform?: NodeJS.Platform, projectChecker?: LanguageServerHostOptions['projectChecker']) {
    const protocolHandles: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const registryFor = (definitionCount: number) => createResolvedContributionRegistry({ languageServers: Array.from({ length: definitionCount }, (_, index) => ({
            provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'fixture', identity: { pluginId: 'fixture', localId: `server${index}` }, manifestPath: join(rootPath, 'plugin.json'),
            definition: { id: `server${index}`, title: `Fixture ${index}`, languageIds: { typescript: 'typescript', tsx: 'typescriptreact' }, filePatterns: ['**/*.ts', '**/*.tsx'], ...(rootMarkers ? { rootMarkers: [...rootMarkers] } : {}), executable: { kind: 'systemTool' as const, id: 'server' }, args: [], initializationOptions: { userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } }, disablePushDiagnostics: true }, ...definitionOverrides?.[index] },
        })) });
    let registry = registryFor(count);
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry, readPolicy, platform, projectChecker, async openProtocol(input) {
            // The OS executable/protocol child is the system boundary; host, catalog, codec and supervisor stay real.
            const service = createStablePluginExecService({ allowedExecutables: [input.definition.executable], signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => behavior.nativeTypeScript ? { command: resolve('../../node_modules/@typescript/typescript-linux-x64/lib/tsc'), args: ['--lsp', '--stdio'] }
                    : { command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify({ ...readLspObject(input.definition.initializationOptions), ...behavior })] }, resolvePath: async () => rootPath });
            const protocol = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest', launch: { executable: input.definition.executable, cwd: rootPath } });
            protocolHandles.push(protocol);
            return protocol;
        } });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const call = async (method: string, input: unknown, signal?: AbortSignal) => {
        const handler = handlers.get(method);
        if (!handler)
            throw new Error('Missing production LSP handler');
        return await handler(input, signal ? { signal } : undefined);
    };
    const open = (path: string, text: string, version = 1, unsaved = false) => call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'open', path, languageId: 'typescript', version, text, unsaved } });
    const query = (kind: string, path = 'a.ts', extra: Record<string, unknown> = {}) => call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path, kind, ...extra });
    const deps = { languageIntelligenceQuery: async ({ request }, context) => DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, context.signal)),
        languageIntelligenceApply: async ({ request }, context) => DaemonLspApplyResponseSchema.parse(await host.apply(request, { signal: context.signal })),
        workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) => applyWorkspaceFileReplace(request, rootPath, { kind: 'restrictedRoots', roots: [rootPath] }, context.signal ? { signal: context.signal } : undefined),
    } satisfies Pick<ActionExecutorDeps, 'languageIntelligenceQuery' | 'languageIntelligenceApply' | 'workspaceFilesReplace'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    registerLanguageIntelligenceHandlers(registrar, rootPath, { host, machineId: 'machine',
        resolveActionExecutor: () => executor, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const callApply = async (method: string, request: unknown) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error('Missing production language mutation handler');
        return handler(createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }), {
            signal: new AbortController().signal, localActionContext: { surface: 'ui', authority: 'present_user' },
        });
    };
    return { host, open, query, call, callApply, executor, protocolHandles, setDefinitionCount: (definitionCount: number) => { registry = registryFor(definitionCount); }, messages: async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
describe('language intelligence composed host', () => {
    it('serves visible semantic ranges from a delta-only server through the strict registered transport', async () => {
        await withTempDir('happier-lsp-host-semantic-delta-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'abc\ndef');
            const f = await fixture(rootPath, 1, { editingFeatures: true, semanticRange: false });
            try {
                const opened = DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'abc\ndef'));
                expect(opened).toMatchObject({ status: 'ok', capabilities: { semanticTokensRange: false, semanticTokensDelta: true } });
                const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
                expect(DaemonLspQueryResponseSchema.parse(await f.query('semanticTokens', 'a.ts', { range })))
                    .toMatchObject({ status: 'ok', kind: 'semanticTokens', tokens: [{ data: [0, 0, 1, 0, 0] }] });
                expect(DaemonLspQueryResponseSchema.parse(await f.query('semanticTokens', 'a.ts', { range })))
                    .toMatchObject({ status: 'ok', kind: 'semanticTokens', tokens: [{ data: [0, 0, 2, 0, 0] }] });
            } finally { await f.host.dispose(); }
        });
    });

    it.each(['pull', 'push'] as const)('publishes only changed diagnostic paths through the registered %s watch', async mode => {
        await withTempDir('happier-lsp-diagnostic-delta-', async rootPath => {
            const f = await fixture(rootPath, 1, { diagnosticsMode: mode });
            const watch = async (sinceRevision?: number) => {
                const response = DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath, sinceRevision }));
                if (response.status !== 'ok') throw new Error('Expected diagnostics watch');
                return response;
            };
            try {
                for (const path of ['a.ts', 'b.ts']) await f.open(path, 'broken');
                const client = f.protocolHandles[0].client;
                const push = async (path: string, message: string) => {
                    await client.notify('fixture/publishDiagnostics', { uri: pathToFileURL(join(rootPath, path)).href,
                        version: 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message }] });
                    await client.request('fixture/barrier');
                };
                await f.query('diagnostics');
                if (mode === 'push') { await push('a.ts', 'broken'); await push('b.ts', 'broken'); }
                const first = await watch();
                expect(Object.keys(first.diagnostics).sort()).toEqual(['a.ts', 'b.ts']);
                if (mode === 'push') {
                    for (let index = 0; index < 12; index++) await push('a.ts', 'broken');
                    expect((await watch()).revision).toBe(first.revision);
                    await push('a.ts', 'Changed problem');
                } else {
                    await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: {
                        op: 'snapshot', path: 'a.ts', languageId: 'typescript', version: 2, text: 'fixed', unsaved: false,
                    } });
                    await vi.waitFor(async () => expect((await watch()).diagnostics['a.ts']?.['fixture/server0'])
                        .toMatchObject({ state: 'ready', version: 2, items: [] }));
                }
                const delta = await watch(first.revision);
                expect(Object.keys(delta.diagnostics)).toEqual(['a.ts']);
                expect(delta.diagnostics['a.ts']['fixture/server0'].items).toMatchObject(mode === 'push' ? [{ message: 'Changed problem' }] : []);
                await client.request('fixture/progress', { kind: 'begin', token: 'loading' });
                const loading = await watch(delta.revision);
                expect(loading.servers[0].loading).toBe(true);
                expect(loading.diagnostics).toEqual({});
                await f.protocolHandles[0].dispose();
                await vi.waitFor(async () => expect((await watch()).servers[0].state).toBe('crashed'));
                const crashed = await watch(loading.revision);
                expect(Object.keys(crashed.diagnostics).sort()).toEqual(['a.ts', 'b.ts']);
                for (const entry of Object.values(crashed.diagnostics)) expect(entry['fixture/server0']).toMatchObject({ state: 'unavailable', items: [] });
            } finally { await f.host.dispose(); }
        });
    });

    it('retains filesystem currentness through asynchronous LSP apply preparation', async () => {
        await withTempDir('happier-lsp-currentness-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            let current = true;
            vi.mocked(fsPromises.readFile).mockImplementationOnce(async (...args: Parameters<typeof fsPromises.readFile>) => {
                const bytes = await actual.readFile(...args);
                current = false;
                return bytes;
            });
            const host = createLanguageServerHost();
            try {
                const response = await host.apply({ rootPath, path: 'a.ts', operation: { kind: 'format', files: [{
                    path: 'a.ts', expectedHash: createHash('sha256').update('old').digest('hex'), edits: [{
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'new',
                    }],
                }] } }, { assertCurrentAuthority: async () => {
                    if (!current) throw Object.assign(new Error('Requester admission expired'), { code: 'filesystem_identity_custody_unavailable' });
                } });
                expect(response).toMatchObject({ ok: true, results: [{ status: 'failed', reason: 'filesystem_identity_custody_unavailable' }] });
                expect((await actual.readFile(join(rootPath, 'a.ts'), 'utf8')) === 'old').toBe(true);
            } finally { vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile); await host.dispose(); }
        });
    });
    it.each(['workspace-pull', 'declared-checker'] as const)('retains complete %s project diagnostics beyond the unrelated tunnel budget', async source => {
        await withTempDir('happier-lsp-project-payload-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'saved');
            const projectChecker = fixtureProjectChecker(rootPath, 'large', 4096);
            const f = await fixture(rootPath, 1, { editingFeatures: source === 'workspace-pull', projectDiagnosticCount: 4096 }, undefined, undefined,
                source === 'declared-checker' ? [{ projectCheck: { executable: { kind: 'systemTool', id: 'checker' }, args: [],
                    projectFile: 'tsconfig.json', output: { kind: 'typescript' } } }] : undefined, undefined, projectChecker);
            try {
                const response = DaemonLspQueryResponseSchema.parse(await f.query('diagnostics', 'a.ts', { scope: 'project', text: 'disk' }));
                expect(response).toMatchObject({ status: 'ok', kind: 'diagnostics', hasMore: false });
                if (response.status !== 'ok' || response.kind !== 'diagnostics') throw new Error('Missing project diagnostics');
                expect(response.diagnostics).toHaveLength(4096);
                if (source === 'workspace-pull') expect(response.diagnostics.at(-1)?.message).toBe('project problem 4095');
                else expect(response.diagnostics.at(-1)?.range.start.line).toBe(4095);
                expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeGreaterThan(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
            } finally { await f.host.dispose(); }
        });
    });
    it.each([false, true])('fences a delayed declared project checker only after a real edit (edited=%s)', async edited => {
        await withTempDir('happier-lsp-declared-check-fence-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'stable');
            const checker = fixtureProjectChecker(rootPath, 'gated-diagnostics');
            const f = await fixture(rootPath, 1, {}, undefined, undefined, [{ projectCheck: { executable: { kind: 'systemTool', id: 'checker' }, args: [],
                projectFile: 'tsconfig.json', output: { kind: 'typescript' } } }], undefined, checker);
            let pending: Promise<unknown> | undefined;
            try {
                const opened = DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'stable', 7));
                if (opened.status !== 'ok') throw new Error('Initial editor acquisition failed');
                expect(opened.capabilities).toMatchObject({ workspaceDiagnostics: false });
                pending = f.query('diagnostics', 'a.ts', { scope: 'project', version: 7, generation: opened.generation });
                await waitForProjectChecker(rootPath);
                expect(await f.open('a.ts', 'stable', 1)).toMatchObject({ status: 'ok', version: 7, generation: opened.generation });
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'snapshot', path: 'a.ts', languageId: 'typescript', version: 21, text: 'stable', unsaved: false } }))
                    .toMatchObject({ status: 'ok', version: 7, servers: [{ generation: opened.servers[0].generation }] });
                if (edited) expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'change', path: 'a.ts', baseVersion: 7, version: 8, unsaved: true,
                        edit: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 6, text: 'd' } } }))
                    .toMatchObject({ status: 'ok', version: 8 });
                await writeFile(join(rootPath, 'started.release'), 'release');
                expect(await pending).toMatchObject(edited ? { status: 'error', errorCode: 'stale_query' }
                    : { status: 'ok', kind: 'diagnostics', version: 7, generation: opened.generation,
                        diagnostics: [{ path: 'src/a(b).ts', code: 'TS2322' }, { path: 'tsconfig.json', code: 'TS18003' }] });
                expect((await f.messages()).some(message => message.method === 'workspace/diagnostic')).toBe(false);
                expect(checker.readProcessRoots()).toEqual([]);
            } finally {
                await writeFile(join(rootPath, 'started.release'), 'release');
                await pending?.catch(() => undefined);
                await f.host.dispose();
            }
        });
    });
    it('refuses project disk diagnostics when another held file contains unsaved edits', async () => {
        await withTempDir('happier-lsp-project-text-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'saved');
            await writeFile(join(rootPath, 'b.ts'), 'saved-b');
            const f = await fixture(rootPath, 1, { editingFeatures: true });
            try {
                await f.open('a.ts', 'saved');
                await f.open('b.ts', 'draft-b', 1, true);
                expect(await f.query('diagnostics', 'a.ts', { text: 'disk', scope: 'project' }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes', diskHash: createHash('sha256').update('saved-b').digest('hex') });
                expect((await f.messages()).filter(message => message.method === 'workspace/diagnostic')).toHaveLength(0);
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['rename', 'codeAction'] as const)('saves exact %s bytes through the real query, admitted RPC and guarded writer, then restores them', async kind => {
        await withTempDir('happier-lsp-saved-journey-', async rootPath => {
            const original = 'old\r\n';
            for (const path of ['a.ts', 'b.ts']) await writeFile(join(rootPath, path), original);
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                const preview = DaemonLspQueryResponseSchema.parse(await f.query(kind === 'rename' ? 'rename' : 'codeActions', 'a.ts', {
                    text: 'disk', position: { line: 0, symbol: 'old' }, ...(kind === 'rename' ? { newName: 'renamed' } : {}),
                }));
                if (preview.status !== 'ok') throw new Error(`Preview unavailable: ${preview.status}`);
                const operation = preview.kind === 'rename' ? { kind: 'rename' as const, files: preview.files }
                    : preview.kind === 'codeActions' ? { kind: 'codeAction' as const, action: preview.actions[0], expectedHash: preview.fileHash! }
                    : undefined;
                if (!operation) throw new Error('Expected a reviewed semantic operation');
                const response = DaemonLspApplyResponseSchema.parse(await f.callApply(kind === 'rename' ? RPC_METHODS.DAEMON_LSP_RENAME_APPLY : RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY,
                    { rootPath, path: 'a.ts', operation }));
                expect(response).toMatchObject({ ok: true });
                if (!('ok' in response) || !response.ok) throw new Error('Expected guarded write receipts');
                expect(response.results.every(file => file.status === 'replaced' && !file.reason)).toBe(true);
                // Inspect the persisted outcome, not just the server edit or Action result.
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe(kind === 'rename' ? 'renamed\r\n' : original);
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe(kind === 'rename' ? 'renamed\r\n' : 'fixed\r\n');
                expect(await f.executor.execute('workspace.files.replace', { machineId: 'machine', rootPath,
                    operation: buildWorkspaceFileRestoreOperation(response.results) }, { surface: 'ui', authority: 'present_user' }))
                    .toMatchObject({ ok: true, result: { ok: true } });
                for (const path of ['a.ts', 'b.ts']) expect(await readFile(join(rootPath, path), 'utf8')).toBe(original);
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['disk', 'buffer'] as const)('refuses a reviewed rename as a whole when a later target changes in its %s', async changedAt => {
        await withTempDir('happier-lsp-stale-set-', async rootPath => {
            for (const path of ['a.ts', 'b.ts']) await writeFile(join(rootPath, path), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                await f.open('a.ts', 'old');
                await f.open('b.ts', 'old');
                const preview = DaemonLspQueryResponseSchema.parse(await f.query('rename', 'a.ts', {
                    text: 'disk', position: { line: 0, symbol: 'old' }, newName: 'renamed',
                }));
                if (preview.status !== 'ok' || preview.kind !== 'rename') throw new Error('Expected rename preview');
                if (changedAt === 'disk') await writeFile(join(rootPath, 'b.ts'), 'agent edit');
                else expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'snapshot', path: 'b.ts', languageId: 'typescript', text: 'draft', version: 2, unsaved: true } }))
                    .toMatchObject({ status: 'ok' });
                const outcome = await f.callApply(RPC_METHODS.DAEMON_LSP_RENAME_APPLY,
                    { rootPath, path: 'a.ts', operation: { kind: 'rename', files: preview.files } });
                expect(outcome).toMatchObject(changedAt === 'disk'
                    ? { ok: true, results: [{ path: 'a.ts', status: 'skipped', reason: 'edit_set_aborted' }, { path: 'b.ts', status: 'changed' }] }
                    : { status: 'error', errorCode: 'unsaved_editor_changes' });
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe(changedAt === 'disk' ? 'agent edit' : 'old');
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', sections: [{ markdown: 'old' }] });
                expect(await f.query('hover', 'b.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', sections: [{ markdown: changedAt === 'buffer' ? 'draft' : 'old' }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('serves editing intelligence through the registered strict wire and native supervisor', async () => {
        await withTempDir('happier-lsp-editing-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'abc');
            const f = await fixture(rootPath, 2, { editingFeatures: true });
            try {
                expect(DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'abc'))).toMatchObject({
                    status: 'ok', capabilities: { completion: true, formatting: true, workspaceDiagnostics: true },
                    servers: [{ capabilities: { completionResolve: true } }, { capabilities: { semanticTokensRange: true } }],
                });
                const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
                const query = async (kind: string, extra: Record<string, unknown> = {}) => DaemonLspQueryResponseSchema.parse(await f.query(kind, 'a.ts', extra));
                const completion = await query('completion', { position: range.start });
                expect(completion).toMatchObject({ status: 'ok', kind: 'completion', isIncomplete: false,
                    items: [{ label: 'fixture', insertTextFormat: 2 }, { label: 'fixture', insertTextFormat: 2 }] });
                if (completion.status !== 'ok' || completion.kind !== 'completion') throw new Error('Missing completion response');
                const item = completion.items[0];
                await query('hover', { position: range.start });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'snapshot', path: 'a.ts', languageId: 'typescript', text: 'abc', version: 1, unsaved: false } });
                expect(await query('completionResolve', { serverId: item.serverId, itemId: item.itemId }))
                    .toMatchObject({ status: 'ok', kind: 'completionResolve', item: { detail: 'resolved', additionalTextEdits: [{ newText: 'import x;\n' }] } });
                expect(await query('signatureHelp', { position: range.start })).toMatchObject({ status: 'ok', kind: 'signatureHelp', help: { activeParameter: 0 } });
                for (const kind of ['formatting', 'rangeFormatting', 'organizeImports']) {
                    expect(await query(kind, { range, formattingOptions: { tabSize: 4, insertSpaces: true } }))
                        .toMatchObject({ status: 'ok', kind, files: [{ path: 'a.ts', expectedHash: createHash('sha256').update('abc').digest('hex') }] });
                }
                for (const kind of ['typeDefinition', 'implementation']) expect(await query(kind, { position: range.start }))
                    .toMatchObject({ status: 'ok', kind, locations: [{ path: 'a.ts' }] });
                expect(await query('documentHighlight', { position: range.start })).toMatchObject({ status: 'ok', highlights: [{ kind: 2 }] });
                expect(await query('selectionRange', { position: range.start })).toMatchObject({ status: 'ok', ranges: [{ ranges: [range, { start: range.start, end: { line: 0, character: 3 } }] }] });
                expect(await query('inlayHint', { range })).toMatchObject({ status: 'ok', hints: [{ label: 'value:' }] });
                expect(await query('semanticTokens', { range })).toMatchObject({ status: 'ok', tokens: [
                    { serverId: 'fixture/server0', legend: { tokenTypes: ['variable'] }, data: [0, 0, 1, 0, 0] },
                    { serverId: 'fixture/server1', legend: { tokenTypes: ['variable'] }, data: [0, 0, 1, 0, 0] },
                ] });
                expect(await query('semanticTokens', { serverId: item.serverId, previousResultId: 'tokens-1' })).toMatchObject({ status: 'ok', tokens: [{ edits: [{ deleteCount: 5 }] }] });
                const calls = await query('callHierarchy', { position: range.start, hierarchy: { direction: 'prepare' } });
                expect(calls).toMatchObject({ status: 'ok', kind: 'callHierarchy', items: [{ name: 'fixture', path: 'a.ts' }] });
                if (calls.status !== 'ok' || calls.kind !== 'callHierarchy') throw new Error('Missing call hierarchy');
                for (const direction of ['incoming', 'outgoing']) expect(await query('callHierarchy', { serverId: calls.items[0].serverId, hierarchy: { direction, itemId: calls.items[0].itemId } }))
                    .toMatchObject({ status: 'ok', direction, calls: [{ item: { path: 'a.ts' }, ranges: [range] }] });
                expect(await query('workspaceSymbol', { query: 'fixture' })).toMatchObject({ status: 'ok', symbols: [{ name: 'fixture', path: 'a.ts' }] });
                expect(await query('diagnostics', { scope: 'project' })).toMatchObject({ status: 'ok', diagnostics: [{ message: 'project problem' }] });
                expect((await f.messages()).filter(message => message.method === 'textDocument/semanticTokens/full')).toHaveLength(0);
                expect(JSON.stringify(completion)).not.toContain('"native"');
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'snapshot', path: 'a.ts', languageId: 'typescript', text: 'edited', version: 2, unsaved: true } });
                expect(await query('completionResolve', { serverId: item.serverId, itemId: item.itemId }))
                    .toMatchObject({ status: 'error', errorCode: 'stale_query' });
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['\n', '\r\n'])('normalizes native completion EOF positions against the held document (%j)', async newline => {
        await withTempDir('happier-lsp-completion-eof-', async rootPath => {
            const text = `# Beta${newline}${newline}[[al`;
            await writeFile(join(rootPath, 'a.ts'), text);
            // Real Marksman 2026-02-08 emits this exclusive end position for [[al at EOF.
            const nativeRange = { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } };
            const expectedRange = { start: nativeRange.start, end: { line: 2, character: 4 } };
            const f = await fixture(rootPath, 1, { editingFeatures: true, completionItems: [
                { label: 'Alpha', kind: 18, filterText: '[[Alpha]]', textEdit: { range: nativeRange, newText: '[[alpha]]' } },
                { label: 'Alpha', kind: 18, textEdit: { insert: nativeRange, replace: nativeRange, newText: '[[alpha]]' } },
            ] });
            try {
                await f.open('a.ts', text, 1, true);
                const result = DaemonLspQueryResponseSchema.parse(await f.query('completion', 'a.ts', {
                    position: { line: 2, character: 4 }, completionContext: { triggerKind: 1 },
                }));
                expect(result).toMatchObject({ status: 'ok', kind: 'completion', items: [
                    { textEdit: { range: expectedRange } }, { textEdit: { insert: expectedRange, replace: expectedRange } },
                ] });
                if (result.status !== 'ok' || result.kind !== 'completion') throw new Error('Expected native completions');
                for (const item of result.items) {
                    if (!item.textEdit) throw new Error('Expected native completion edit');
                    const edit = item.textEdit;
                    const range = 'range' in edit ? edit.range : edit.replace;
                    // The guarded edit consumer accepts the exact projection; Monaco requires a single-line edit.
                    expect(range.start.line).toBe(range.end.line);
                    expect(applyWorkspaceFileTextEdits(text, [{ range, text: edit.newText }]).text)
                        .toBe(`# Beta${newline}${newline}[[alpha]]`);
                    expect(DaemonLspQueryResponseSchema.parse(await f.query('completionResolve', 'a.ts', {
                        serverId: item.serverId, itemId: item.itemId,
                    }))).toMatchObject({ status: 'ok', kind: 'completionResolve', item: { textEdit: edit } });
                }
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['identical-snapshot', 'identical-open', 'identical-change', 'unrelated-file', 'watch-and-reference', 'real-edit', 'edit-then-restore', 'reused-counter-edit-restore', 'restart'] as const)
        ('keeps a pending project answer current only across semantic no-op sync: %s', async scenario => {
        await withTempDir('happier-lsp-semantic-fence-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'stable');
            await writeFile(join(rootPath, 'b.ts'), 'other');
            const f = await fixture(rootPath, 1, { editingFeatures: true, delayMethod: 'workspace/diagnostic' });
            let pending: Promise<unknown> | undefined;
            try {
                const opened = DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'stable', 7));
                if (opened.status !== 'ok') throw new Error('Initial editor acquisition failed');
                await f.open('b.ts', 'other', 4);
                pending = f.query('diagnostics', 'a.ts', { scope: 'project', version: 7, generation: opened.generation });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'workspace/diagnostic')).toBe(true));
                const snapshot = (path: string, text: string, version: number, unsaved = false) => f.call(RPC_METHODS.DAEMON_LSP_SYNC,
                    { rootPath, op: { op: 'snapshot', path, languageId: 'typescript', text, version, unsaved } });
                let accepted: unknown;
                if (scenario === 'identical-snapshot') accepted = await snapshot('a.ts', 'stable', 21);
                else if (scenario === 'identical-open') accepted = await f.open('a.ts', 'stable', 1);
                else if (scenario === 'identical-change') accepted = await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
                    op: { op: 'change', path: 'a.ts', baseVersion: 7, version: 21, unsaved: false,
                        edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, text: 'stable' } } });
                else if (scenario === 'unrelated-file') await snapshot('b.ts', 'updated', 5, true);
                else if (scenario === 'watch-and-reference') {
                    expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok' });
                    expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 }, version: 7 }))
                        .toMatchObject({ status: 'ok', version: 7 });
                } else if (scenario === 'restart') expect(await f.call(RPC_METHODS.DAEMON_LSP_RESTART, { rootPath })).toMatchObject({ status: 'ok' });
                else if (scenario === 'reused-counter-edit-restore') {
                    const edited = DaemonLspSyncResponseSchema.parse(await snapshot('a.ts', 'edited', 1, true));
                    const restored = DaemonLspSyncResponseSchema.parse(await snapshot('a.ts', 'stable', 7));
                    if (edited.status !== 'ok' || restored.status !== 'ok' || edited.version === undefined || restored.version === undefined)
                        throw new Error('Missing canonical edit acknowledgements');
                    expect.soft(edited.version).toBeGreaterThan(7);
                    expect.soft(restored.version).toBeGreaterThan(edited.version);
                }
                else {
                    await snapshot('a.ts', 'edited', 21, true);
                    if (scenario === 'edit-then-restore') await snapshot('a.ts', 'stable', 22);
                }
                const changed = scenario === 'real-edit' || scenario === 'edit-then-restore' || scenario === 'reused-counter-edit-restore' || scenario === 'restart';
                const version = scenario === 'real-edit' ? 21 : scenario === 'edit-then-restore' ? 22 : 7;
                // ACK and the next ordinary query must agree on the canonical
                // accepted version, not echo a no-op caller's unrelated counter.
                if (accepted !== undefined) expect.soft(accepted).toMatchObject({ status: 'ok', version: 7, generation: opened.generation,
                    servers: [{ generation: opened.servers[0].generation }] });
                const current = DaemonLspQueryResponseSchema.parse(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }));
                expect.soft(current).toMatchObject({ status: 'ok', ...(scenario === 'reused-counter-edit-restore' ? {} : { version }), sections: [{ markdown: scenario === 'real-edit' ? 'edited' : 'stable' }] });
                if (current.status !== 'ok') throw new Error('Current held editor query failed');
                if (scenario === 'reused-counter-edit-restore') expect.soft(current.version).toBeGreaterThan(7);
                if (scenario === 'restart') expect(current.generation).not.toBe(opened.generation);
                else {
                    expect(current.generation).toBe(opened.generation);
                    expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ generation: opened.servers[0].generation }] });
                    await f.protocolHandles[0].client.notify('fixture/release', { method: 'workspace/diagnostic' });
                }
                expect.soft(await pending).toMatchObject(changed ? { status: 'error', errorCode: 'stale_query' }
                    : { status: 'ok', kind: 'diagnostics', version: 7, generation: opened.generation, diagnostics: [{ message: 'project problem' }] });
            } finally {
                await f.protocolHandles[0]?.client.notify('fixture/release', { method: 'workspace/diagnostic' }).catch(() => undefined);
                await pending?.catch(() => undefined);
                await f.host.dispose();
            }
        });
    });
    it('keeps the queued incremental base-version fence when a no-op races a real edit', async () => {
        await withTempDir('happier-lsp-noop-edit-race-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'stable');
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', 'stable', 7);
                const edited = f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'change', path: 'a.ts', baseVersion: 7, version: 8,
                    edit: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 6, text: 'd' }, unsaved: true } });
                const noOp = f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'change', path: 'a.ts', baseVersion: 7, version: 21,
                    edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, text: 'stable' }, unsaved: false } });
                expect(await edited).toMatchObject({ status: 'ok', version: 8 });
                expect(await noOp).toMatchObject({ status: 'error', errorCode: 'document_out_of_sync' });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 8, sections: [{ markdown: 'stabled' }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('cancels completion and drops a pending answer after incremental text changes', async () => {
        await withTempDir('happier-lsp-completion-fence-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'abc');
            const f = await fixture(rootPath, 1, { editingFeatures: true, delayMethod: 'textDocument/completion' });
            try {
                await f.open('a.ts', 'abc');
                const pending = f.query('completion', 'a.ts', { position: { line: 0, character: 1 }, version: 1 });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'textDocument/completion')).toBe(true));
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'change', path: 'a.ts', version: 2, baseVersion: 1,
                    edit: { startLine: 0, startCharacter: 3, endLine: 0, endCharacter: 3, text: 'd' }, unsaved: true } });
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/completion' });
                expect(await pending).toMatchObject({ status: 'error', errorCode: 'stale_query' });
                const controller = new AbortController();
                const cancelled = f.call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'a.ts', kind: 'completion', position: { line: 0, character: 1 } }, controller.signal);
                await vi.waitFor(async () => expect((await f.messages()).filter(message => message.method === 'textDocument/completion')).toHaveLength(2));
                controller.abort();
                expect(await cancelled).toMatchObject({ status: 'error', errorCode: 'cancelled' });
            } finally { await f.host.dispose(); }
        });
    });
    it.each([false, true])('reacquires a lost daemon document and diagnostic revision after reconnect (offline edit=%s)', async offlineEdit => {
        await withTempDir('happier-lsp-reconnect-', async rootPath => {
            let text = 'broken';
            let unsaved = false;
            await writeFile(join(rootPath, 'a.ts'), text);
            let active = await fixture(rootPath);
            const hosts = [active.host];
            let online = true;
            let transport = new AbortController();
            let holdOldHover = false;
            let releaseOldHover: (() => void) | undefined;
            let oldHover: Promise<void> | undefined;
            let markOldResponse!: () => void;
            const oldResponseReady = new Promise<void>(resolve => { markOldResponse = resolve; });
            // Only the Machine transport disappears/reconnects. Both daemon
            // instances use real registration, lifecycle, codec and native children.
            const call = async (method: string, request: unknown, signal?: AbortSignal) => {
                if (!online) throw new Error('Machine disconnected');
                const target = active;
                const response = await target.call(method, request, signal ? AbortSignal.any([signal, transport.signal]) : transport.signal);
                if (!online || target !== active) throw new Error('Machine disconnected');
                // A valid packet can already be buffered when cancellation or
                // reconnect overtakes its delivery. Keep that late packet real.
                if (holdOldHover && method === RPC_METHODS.DAEMON_LSP_QUERY && DaemonLspQueryRequestSchema.parse(request).kind === 'hover') {
                    holdOldHover = false;
                    await new Promise<void>(resolve => { releaseOldHover = resolve; markOldResponse(); });
                }
                return response;
            };
            const controller = createCodeIntelligenceController({
                scope: { serverId: 'home', machineId: 'machine', rootPath }, path: 'a.ts', languageId: 'typescript',
                accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
                    onRetire: () => ({ dispose() {} }) },
                getText: () => text, getUnsaved: () => unsaved,
                query: async () => { throw new Error('A capable server must not use name-search fallback'); }, openLocation() {},
                languageServer: {
                    sync: async (request, signal) => DaemonLspSyncResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_SYNC, request, signal)),
                    query: async (request, signal) => DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, signal)),
                    watch: async (request, signal) => DaemonLspWatchResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_WATCH, request, signal)),
                    restart: async () => { throw new Error('Recovery must not require a language-service restart'); },
                },
            });
            try {
                for (let index = 0; index < 8; index++) await controller.checkProblems();
                await vi.waitFor(() => expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'ready', count: 1, items: [{ message: text }] }));
                const oldRevision = controller.getDiagnosticsProjection().revision;
                const oldPids = active.protocolHandles.map(handle => readSupervisedPluginProcessIdForHost(handle.process)).filter((pid): pid is number => typeof pid === 'number');
                expect(oldPids).toHaveLength(1);
                holdOldHover = true;
                oldHover = controller.hover({ line: 0, character: 2 });
                await oldResponseReady;
                online = false;
                transport.abort();
                await active.host.dispose();
                await vi.waitFor(async () => expect(await Promise.all(oldPids.map(isPidAlive))).toEqual([false]));
                await controller.checkProblems();
                expect(controller.getSnapshot()).toMatchObject({ status: 'unavailable', reason: 'transport_failed' });
                if (offlineEdit) { text = 'brokenOfflineDraft'; unsaved = true; }

                active = await fixture(rootPath);
                hosts.push(active.host);
                transport = new AbortController();
                online = true;
                await controller.checkProblems();
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { status: 'ok', kind: 'diagnostics', diagnostics: [{ message: text }] } });
                releaseOldHover?.();
                await oldHover;
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'diagnostics', diagnostics: [{ message: text }] } });
                await vi.waitFor(() => expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'ready', count: 1, items: [{ message: text }] }));
                expect(controller.getDiagnosticsProjection().revision).toBeLessThan(oldRevision);
                await controller.hover({ line: 0, character: 2 });
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'hover', sections: [{ markdown: text }] } });
                await controller.checkProblems();
                expect((await active.messages()).filter(message => message.method === 'textDocument/didOpen')).toHaveLength(1);
                const pids = active.protocolHandles.map(handle => readSupervisedPluginProcessIdForHost(handle.process)).filter((pid): pid is number => typeof pid === 'number');
                expect(pids).toHaveLength(1);
                controller.dispose();
                await vi.waitFor(async () => expect(await Promise.all(pids.map(isPidAlive))).toEqual([false]));
                expect(active.host.readProcessRoots()).toEqual([]);
            } finally {
                releaseOldHover?.();
                await oldHover;
                controller.dispose();
                await Promise.all(hosts.map(host => host.dispose()));
            }
        });
    });
    it.skipIf(process.env.HAPPIER_NATIVE_LSP_SMOKE !== '1')('runs native TypeScript 7.0.2 semantic rename, importer move, quick fix and guarded Undo', async () => {
        expect(JSON.parse(await readFile(resolve('../../node_modules/@typescript/typescript-linux-x64/package.json'), 'utf8'))).toMatchObject({ version: '7.0.2' });
        await withTempDir('happier-native-lsp-semantic-', async rootPath => {
            const source = 'export const greet = () => "hello";\n';
            const importer = 'import { greet } from "./a";\nexport const value = greet();\n';
            const broken = 'greet();\n';
            await writeFile(join(rootPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'esnext', moduleResolution: 'bundler' }, include: ['*.ts'] }));
            await writeFile(join(rootPath, 'a.ts'), source);
            await writeFile(join(rootPath, 'b.ts'), importer);
            await writeFile(join(rootPath, 'fix.ts'), broken);
            const undo = async (f: Awaited<ReturnType<typeof fixture>>, result: unknown) => {
                const parsed = DaemonLspApplyResponseSchema.parse(result);
                if (!('ok' in parsed) || !parsed.ok) throw new Error('Native operation did not return writer receipts');
                expect(parsed.results.every(file => file.status === 'replaced' && !file.reason)).toBe(true);
                const restored = await f.executor.execute('workspace.files.replace', { machineId: 'machine', rootPath,
                    operation: buildWorkspaceFileRestoreOperation(parsed.results) }, { surface: 'ui', authority: 'present_user' });
                expect(restored).toMatchObject({ ok: true, result: { ok: true } });
            };
            for (const scenario of ['symbol', 'file', 'fix'] as const) {
                const f = await fixture(rootPath, 1, { nativeTypeScript: true });
                try {
                    const target = { machineId: 'machine', rootPath, path: scenario === 'fix' ? 'fix.ts' : 'a.ts' };
                    if (scenario === 'fix') {
                        await f.open('fix.ts', broken, 7, true);
                        expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'snapshot', path: 'fix.ts', languageId: 'typescript', version: 8, text: broken, unsaved: false } }))
                            .toMatchObject({ status: 'ok' });
                        expect(await f.query('diagnostics', 'fix.ts', { text: 'disk' }))
                            .toMatchObject({ status: 'ok', diagnostics: [{ code: 2304 }] });
                    }
                    const previewResult = await f.executor.execute(scenario === 'symbol' ? 'code.rename.preview' : scenario === 'file' ? 'code.file.rename.preview' : 'code.codeActions.list',
                        scenario === 'symbol' ? { ...target, line: 1, symbol: 'greet', newName: 'salute' }
                            : scenario === 'file' ? { ...target, newPath: 'moved.ts' } : { ...target, line: 1, symbol: 'greet' }, { surface: 'agent' });
                    if (!previewResult.ok) throw new Error(`Native ${scenario} preview failed`);
                    const preview = DaemonLspQueryResponseSchema.parse(previewResult.result);
                    if (preview.status !== 'ok') throw new Error(`Native ${scenario} preview was ${preview.status}`);
                    let applied;
                    if (scenario === 'fix') {
                        if (preview.kind !== 'codeActions') throw new Error('Expected native code actions');
                        const action = preview.actions.find(action => action.files.some(file => file.path === 'fix.ts' && file.edits.some(edit => edit.text.includes('import') && edit.text.includes('greet'))));
                        expect(action).toBeDefined();
                        if (!action) throw new Error('Native missing-import quick fix was not offered');
                        applied = await f.executor.execute('code.codeAction.apply', { ...target, operation: { kind: 'codeAction', action, expectedHash: preview.fileHash! } }, { surface: 'ui', authority: 'present_user' });
                    } else {
                        if (preview.kind !== 'rename' && preview.kind !== 'willRenameFiles') throw new Error('Expected native rename edits');
                        applied = await f.executor.execute(scenario === 'symbol' ? 'code.rename.apply' : 'code.file.rename.apply', { ...target, files: preview.files }, { surface: 'ui', authority: 'present_user' });
                    }
                    if (!applied.ok) throw new Error(`Native ${scenario} apply failed`);
                    if (scenario === 'symbol') expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toContain('salute');
                    if (scenario === 'file') expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toContain('./moved');
                    if (scenario === 'fix') {
                        expect(await readFile(join(rootPath, 'fix.ts'), 'utf8')).toContain('import');
                        expect(await f.query('diagnostics', 'fix.ts', { text: 'disk' })).toMatchObject({ status: 'ok', diagnostics: [] });
                    }
                    await undo(f, applied.result);
                    expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe(source);
                    expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe(importer);
                    expect(await readFile(join(rootPath, 'fix.ts'), 'utf8')).toBe(broken);
                } finally { await f.host.dispose(); }
            }
        });
    });
    it('asks for quick fixes with fresh diagnostic context from the canonical pull owner', async () => {
        await withTempDir('happier-lsp-codeaction-context-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'broken');
            const f = await fixture(rootPath, 1, { semanticEdits: true, requireDiagnosticContext: true });
            try {
                await f.open('a.ts', 'broken');
                expect(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', actions: [{ title: 'Fix fixture' }] });
                expect(DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
                    .toMatchObject({ diagnostics: { 'a.ts': { 'fixture/server0': { items: [{ code: 2322 }] } } } });
            } finally { await f.host.dispose(); }
        });
    });
    it('undoes direct edits then command edits on the same file and a source move through the restore Action', async () => {
        await withTempDir('happier-lsp-command-undo-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, commandDirectEdits: true });
            try {
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                const outcome = await f.executor.execute('code.codeAction.apply', { machineId: 'machine', rootPath, path: 'a.ts',
                    operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! },
                }, { surface: 'ui', authority: 'present_user' });
                if (!outcome.ok) throw new Error('Code action failed');
                const applied = DaemonLspApplyResponseSchema.parse(outcome.result);
                if (!('ok' in applied) || !applied.ok) throw new Error('Expected writer receipts');
                expect(applied.results.map(result => result.path)).toEqual(['b.ts', 'a.ts', 'b.ts']);
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('fixed');
                expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('old');
                expect(await f.executor.execute('workspace.files.replace', { machineId: 'machine', rootPath,
                    operation: buildWorkspaceFileRestoreOperation(applied.results),
                }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true, result: { ok: true, results: [{ status: 'restored' }, { status: 'restored' }, { status: 'restored' }] } });
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                await expect(readFile(join(rootPath, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await f.host.dispose(); }
        });
    });
    it('reports a command edit refusal even when the server acknowledges its command successfully', async () => {
        await withTempDir('happier-lsp-command-refusal-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, refuseCommandEdit: true });
            try {
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                expect(await f.host.apply({ rootPath, path: 'a.ts', operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! } }))
                    .toMatchObject({ status: 'error', errorCode: 'request_failed' });
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
            } finally { await f.host.dispose(); }
        });
    });
    it('applies reviewed file renames and fresh server commands through Actions and the one guarded writer', async () => {
        await withTempDir('happier-lsp-semantic-apply-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                const target = { machineId: 'machine', rootPath, path: 'a.ts' };
                const listed = await f.executor.execute('code.codeActions.list', { ...target, line: 1, symbol: 'old' }, { surface: 'agent' });
                expect(listed.ok).toBe(true);
                if (!listed.ok) throw new Error('Code actions unavailable');
                const preview = DaemonLspQueryResponseSchema.parse(listed.result);
                if (preview.status !== 'ok' || preview.kind !== 'codeActions') throw new Error('Expected code actions');
                expect(preview.actions[0]).toMatchObject({ hasCommand: true });
                expect(preview.actions[0]).not.toHaveProperty('command');
                const input = { ...target, operation: { kind: 'codeAction' as const, action: preview.actions[0], expectedHash: preview.fileHash! } };
                const applied = await f.executor.execute('code.codeAction.apply', input, { surface: 'ui', authority: 'present_user' });
                expect(applied).toMatchObject({ ok: true, result: { ok: true, results: [{ path: 'b.ts', status: 'replaced', edits: [{ originalText: 'old', insertText: 'fixed' }] }] } });
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('fixed');
                expect(f.protocolHandles).toHaveLength(2); // The apply reacquires a current server command after transient preview teardown.
                await writeFile(join(rootPath, 'b.ts'), 'old');
                const rename = await f.executor.execute('code.file.rename.preview', { ...target, newPath: 'moved.ts' }, { surface: 'agent' });
                if (!rename.ok) throw new Error('File rename unavailable');
                const edits = DaemonLspQueryResponseSchema.parse(rename.result);
                if (edits.status !== 'ok' || edits.kind !== 'willRenameFiles') throw new Error('Expected rename edits');
                expect(await f.executor.execute('code.file.rename.apply', { ...target, files: edits.files }, { surface: 'ui', authority: 'present_user' }))
                    .toMatchObject({ ok: true, result: { ok: true, results: [ { path: 'a.ts', renameTo: 'moved.ts', status: 'replaced' }, { path: 'b.ts', status: 'replaced' } ] } });
                expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('old');
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('updated');
                await expect(readFile(join(rootPath, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await f.host.dispose(); }
        });
    });
    it('refuses unsolicited server writes and cancels a command without granting later edit authority', async () => {
        await withTempDir('happier-lsp-command-cancel-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, delayCommand: true });
            try {
                await f.open('a.ts', 'old');
                expect(await f.protocolHandles[0].client.request('fixture/unsolicitedEdit', { uri: pathToFileURL(join(rootPath, 'b.ts')).href })).toEqual({ applied: false });
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                const abort = new AbortController();
                const applying = f.host.apply({ rootPath, path: 'a.ts', operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! } }, { signal: abort.signal });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'workspace/executeCommand')).toBe(true));
                abort.abort();
                expect(await applying).toMatchObject({ status: 'error', errorCode: 'cancelled' });
                expect(await f.protocolHandles[0].client.request('fixture/unsolicitedEdit', { uri: pathToFileURL(join(rootPath, 'b.ts')).href })).toEqual({ applied: false });
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'orderedInserts' }))
                    .toMatchObject({ status: 'ok', files: [{ path: 'a.ts', edits: [{ text: 'x' }, { text: 'x' }] }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('previews semantic edits from the real server without writing and rejects unsafe edit sets', async () => {
        await withTempDir('happier-lsp-rename-', async rootPath => {
            const source = Buffer.from('old\r\n');
            await writeFile(join(rootPath, 'a.ts'), source);
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                const result = DaemonLspQueryResponseSchema.parse(await f.query('rename', 'a.ts', {
                    text: 'disk', position: { line: 0, symbol: 'old' }, newName: 'renamed',
                }));
                expect(result).toMatchObject({ status: 'ok', kind: 'rename', files: [
                    { path: 'a.ts', expectedHash: createHash('sha256').update(source).digest('hex'), edits: [{ text: 'renamed' }] },
                    { path: 'b.ts', edits: [{ text: 'renamed' }] },
                ] });
                expect(await readFile(join(rootPath, 'a.ts'))).toEqual(source);
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'outside' }))
                    .toMatchObject({ status: 'error', errorCode: 'path_not_allowed' });
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'overlap' }))
                    .toMatchObject({ status: 'error', errorCode: 'invalid_request' });
                await f.open('b.ts', 'dirty', 1, true);
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'next' }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['closed', 'closing'] as const)('acquires an Action document after its selected sibling session is %s during the disk read', async phase => {
        await withTempDir('happier-lsp-acquire-close-', async rootPath => {
            const path = join(rootPath, 'a.ts');
            await writeFile(path, 'shared');
            const behavior = { delayHover: true, delayShutdown: phase === 'closing' };
            const f = await fixture(rootPath, 1, behavior);
            let releaseRead!: () => void;
            const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
            let enteredRead!: () => void;
            const reading = new Promise<void>(resolve => { enteredRead = resolve; });
            const nativeRead = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
            const readSpy = vi.mocked(fsPromises.readFile);
            try {
                const target = { machineId: 'machine', rootPath, path: 'a.ts' };
                const hover = f.executor.execute('code.hover.get', { ...target, line: 1, character: 0 }, { surface: 'agent' });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'textDocument/hover')).toBe(true));
                // Gate only the OS disk read. Session selection, document custody,
                // Action admission, managed JSON-RPC and the child remain real.
                let blocked = false;
                readSpy.mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
                    if (args[0] === path && !blocked) {
                        blocked = true;
                        enteredRead();
                        await readGate;
                    }
                    return await nativeRead(...args);
                }) as typeof nativeRead);
                const symbols = f.executor.execute('code.symbols.list', target, { surface: 'agent' });
                await reading;
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/hover' });
                if (phase === 'closed') await hover;
                else {
                    await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'shutdown')).toBe(true));
                    expect(f.host.readProcessRoots()).toMatchObject([{ state: 'stopping', pid: expect.any(Number) }]);
                    behavior.delayShutdown = false;
                }
                releaseRead();
                if (phase === 'closing') {
                    await new Promise<void>(resolve => setImmediate(resolve));
                    await f.protocolHandles[0].client.notify('fixture/release', { method: 'shutdown' });
                }
                expect(await hover).toMatchObject({ ok: true, result: { status: 'ok', sections: [{ markdown: 'shared' }] } });
                expect.soft(await symbols).toMatchObject({ ok: true, result: { status: 'ok', kind: 'documentSymbols', symbols: [{ name: 'fixture' }] } });
                // The next ordinary Action must not inherit a stopped session.
                expect(await f.executor.execute('code.symbols.list', target, { surface: 'agent' }))
                    .toMatchObject({ ok: true, result: { status: 'ok', symbols: [{ name: 'fixture' }] } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [] });
            } finally {
                releaseRead();
                readSpy.mockImplementation(nativeRead);
                await f.host.dispose();
            }
        });
    });
    it.each(['cancelled', 'completed'] as const)('retains an overlapping transient query after its sibling is %s', async settlement => {
        await withTempDir('happier-lsp-transient-overlap-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, { delayHover: true, delayDiagnostic: true });
            try {
                const abort = new AbortController();
                const first = f.call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'a.ts', kind: 'diagnostics', text: 'disk' }, abort.signal);
                await vi.waitFor(async () => expect((await f.messages()).some(m => m.method === 'textDocument/diagnostic')).toBe(true));
                const second = f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } });
                await vi.waitFor(async () => expect((await f.messages()).some(m => m.method === 'textDocument/hover')).toBe(true));
                if (settlement === 'cancelled') abort.abort();
                else await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/diagnostic' });
                expect(await first).toMatchObject(settlement === 'cancelled' ? { status: 'error', errorCode: 'cancelled' } : { status: 'ok' });
                const pid = readSupervisedPluginProcessIdForHost(f.protocolHandles[0].process);
                if (pid === null) throw new Error('Missing native language-server PID');
                expect(isPidAlive(pid)).toBe(true);
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/hover' });
                expect(await second).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
                expect(f.protocolHandles).toHaveLength(1);
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves a new editor holder acquired while its previous holder closes natively', async () => {
        await withTempDir('happier-lsp-editor-reacquire-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'disk');
            const behavior = { delayShutdown: true };
            const f = await fixture(rootPath, 1, behavior);
            try {
                await f.open('a.ts', 'first', 1);
                const closing = f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'shutdown')).toBe(true));
                expect(f.host.readProcessRoots()).toMatchObject([{ state: 'stopping' }]);
                behavior.delayShutdown = false;
                const opening = f.open('a.ts', 'editor', 9, true);
                await new Promise<void>(resolve => setImmediate(resolve));
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'shutdown' });
                expect(await closing).toMatchObject({ status: 'ok' });
                expect(await opening).toMatchObject({ status: 'ok' });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [] });
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves a current unsaved editor buffer opened during a default query disk read', async () => {
        await withTempDir('happier-lsp-editor-during-read-', async rootPath => {
            const path = join(rootPath, 'a.ts');
            await writeFile(path, 'disk');
            const f = await fixture(rootPath);
            let releaseRead!: () => void;
            const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
            let enteredRead!: () => void;
            const reading = new Promise<void>(resolve => { enteredRead = resolve; });
            const nativeRead = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
            const readSpy = vi.mocked(fsPromises.readFile);
            try {
                let blocked = false;
                readSpy.mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
                    if (args[0] === path && !blocked) {
                        blocked = true;
                        enteredRead();
                        await readGate;
                    }
                    return await nativeRead(...args);
                }) as typeof nativeRead);
                const hover = f.query('hover', 'a.ts', { position: { line: 0, character: 0 } });
                await reading;
                expect(await f.open('a.ts', 'editor', 9, true)).toMatchObject({ status: 'ok' });
                releaseRead();
                const result = await hover;
                expect.soft(result).toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect.soft(result).not.toHaveProperty('fileHash');
                expect.soft(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
            } finally {
                releaseRead();
                readSpy.mockImplementation(nativeRead);
                await f.host.dispose();
            }
        });
    });
    it.each([1, 2])('forgets idle-reaped holder memberships before reopening %i definitions', async definitionCount => {
        await withTempDir('happier-lsp-idle-reopen-', async rootPath => {
            const policy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: 1000 } }, revision: 0, source: 'stored' });
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, definitionCount, {}, undefined, () => policy);
            try {
                await f.open('a.ts', 'shared');
                await Promise.all(f.protocolHandles.map(async handle => {
                    // Root exit proves idle reaping initiated the stop. Disposal
                    // joins native subtree verification before membership retires.
                    await handle.wait();
                    await handle.dispose();
                }));
                await vi.waitFor(async () => expect(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })).toMatchObject({ status: 'ok', servers: [] }));
                await f.open('a.ts', 'shared');
                const closed = await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(closed).toMatchObject({ status: 'ok', servers: [] });
                await Promise.all(f.protocolHandles.map(handle => handle.wait()));
                expect(f.protocolHandles).toHaveLength(definitionCount * 2);
            } finally { await f.host.dispose(); }
        });
    });
    it('honors a valid idle policy beyond the native timer delay without overflowing or replacing the child', async () => {
        await withTempDir('happier-lsp-long-idle-policy-', async rootPath => {
            const disabledPolicy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: null } }, revision: 0, source: 'stored' });
            const longPolicy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: 30 * 24 * 60 * 60 * 1000 } }, revision: 1, source: 'stored' });
            let policy = disabledPolicy;
            const warnings: string[] = [];
            const onWarning = (warning: Error) => { if (warning.name === 'TimeoutOverflowWarning') warnings.push(warning.message); };
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, {}, undefined, () => policy);
            process.on('warning', onWarning);
            try {
                await f.open('a.ts', 'shared');
                expect(f.protocolHandles).toHaveLength(1);
                // Read the changed Machine policy after a real child is ready,
                // so timer behavior is observed across native protocol work.
                policy = longPolicy;
                for (let index = 0; index < 2; index++) {
                    expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                    await new Promise<void>(done => setImmediate(done));
                }
                expect(f.protocolHandles).toHaveLength(1);
            } finally {
                policy = disabledPolicy;
                await f.host.dispose();
                await Promise.all(f.protocolHandles.map(handle => handle.wait()));
                process.removeListener('warning', onWarning);
            }
            expect(warnings).toEqual([]);
        });
    });
    it('serves real registered RPCs through the handshake, opts diagnostics in, and delivers watch replacements', async () => {
        await withTempDir('happier-lsp-composed-', async (rootPath) => {
            await writeFile(join(rootPath, 'a.ts'), 'broken');
            const f = await fixture(rootPath);
            try {
                const opened = DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'broken'));
                expect(opened).toMatchObject({ status: 'ok', capabilities: { hover: true, definition: true, diagnostics: 'pull' } });
                const hover = DaemonLspQueryResponseSchema.parse(await f.query('hover', 'a.ts', { position: { line: 0, symbol: 'broken' } }));
                expect(hover).toMatchObject({ status: 'ok', kind: 'hover', sections: [{ markdown: 'broken' }] });
                expect((await f.messages()).some(m => m.id === 'registration' && !m.method)).toBe(true);
                expect((await f.messages()).some(m => m.method === 'textDocument/diagnostic')).toBe(false);
                expect(await f.query('definition', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', locations: [{ path: 'a.ts' }] });
                expect(await f.query('diagnostics')).toMatchObject({ status: 'ok', diagnostics: [{ path: 'a.ts', severity: 'error', message: 'broken' }] });
                const watch = DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }));
                expect(watch).toMatchObject({ status: 'ok', diagnostics: { 'a.ts': { 'fixture/server0': { state: 'ready', version: 1, items: [{ message: 'broken' }] } } } });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'change', path: 'a.ts', baseVersion: 1, version: 2, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, text: 'fixed' }, unsaved: true } });
                expect(await f.query('diagnostics')).toMatchObject({ status: 'ok', diagnostics: [] });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('answers about raw disk bytes, refuses unsaved buffers, and reopens transient Action documents', async () => {
        await withTempDir('happier-lsp-disk-', async (rootPath) => {
            const bytes = Buffer.from('saved\r\n');
            await writeFile(join(rootPath, 'a.ts'), bytes);
            const f = await fixture(rootPath);
            try {
                const extra = { text: 'disk', position: { line: 0, symbol: 'saved' } };
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'ok', fileHash: createHash('sha256').update(bytes).digest('hex'), sections: [{ markdown: 'saved\r\n' }] });
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'ok' });
                expect(f.protocolHandles).toHaveLength(2);
                await f.open('a.ts', 'unsaved', 3, true);
                const previous = (await f.messages()).filter(m => m.method === 'textDocument/hover').length;
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes', diskHash: createHash('sha256').update(bytes).digest('hex') });
                expect((await f.messages()).filter(m => m.method === 'textDocument/hover')).toHaveLength(previous);
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 3, sections: [{ markdown: 'unsaved' }] });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
                expect(f.protocolHandles).toHaveLength(3);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'snapshot', path: 'a.ts', languageId: 'typescript', version: 4, text: 'clean old', unsaved: false } });
                const changedBytes = Buffer.from('changed on disk\r\n');
                await writeFile(join(rootPath, 'a.ts'), changedBytes);
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } })).toMatchObject({
                    status: 'ok', version: 5, fileHash: createHash('sha256').update(changedBytes).digest('hex'), sections: [{ markdown: 'changed on disk\r\n' }],
                });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', version: 5, sections: [{ markdown: 'changed on disk\r\n' }] });
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('shares one process across packages and merges multiple definitions in canonical order', async () => {
        await withTempDir('happier-lsp-roots-', async (rootPath) => {
            await mkdir(join(rootPath, 'one'));
            await mkdir(join(rootPath, 'two'));
            await writeFile(join(rootPath, 'one/a.ts'), 'one');
            await writeFile(join(rootPath, 'two/b.ts'), 'two');
            const f = await fixture(rootPath, 2);
            try {
                await f.open('one/a.ts', 'one');
                await f.open('two/b.ts', 'two');
                expect(f.protocolHandles).toHaveLength(2);
                expect(await f.query('hover', 'one/a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                const definitions = DaemonLspQueryResponseSchema.parse(await f.query('definition', 'one/a.ts', { position: { line: 0, character: 0 } }));
                expect(definitions).toMatchObject({ status: 'ok', locations: [{ serverId: 'fixture/server0', path: 'one/a.ts' }] });
                if (definitions.status !== 'ok' || definitions.kind !== 'definition') throw new Error('Expected definition results');
                expect(definitions.locations).toHaveLength(1);
                const references = DaemonLspQueryResponseSchema.parse(await f.query('references', 'two/b.ts', { position: { line: 0, character: 0 } }));
                expect(references).toMatchObject({ status: 'ok', locations: [{ serverId: 'fixture/server0', path: 'two/b.ts', lineText: 'two' }] });
                if (references.status !== 'ok' || references.kind !== 'references') throw new Error('Expected reference results');
                expect(references.locations).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'one/a.ts' } });
                expect(await f.query('hover', 'two/b.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                expect(f.protocolHandles).toHaveLength(2);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'two/b.ts' } });
                await Promise.all(f.protocolHandles.map(handle => expect(handle.wait()).resolves.toBeDefined()));
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('reports only document servers and capabilities in sync while watches aggregate the root', async () => {
        await withTempDir('happier-lsp-document-servers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'typescript');
            await writeFile(join(rootPath, 'file.example'), 'example');
            const f = await fixture(rootPath, 2, {}, undefined, undefined, [
                { languageIds: { typescript: 'typescript' }, filePatterns: ['**/*.ts'], initializationOptions: { semanticEdits: true } },
                { languageIds: { example: 'example-lsp' }, filePatterns: ['**/*.example'] },
            ]);
            try {
                expect(await f.open('a.ts', 'typescript')).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }], capabilities: { rename: true } });
                const sync = (op: Record<string, unknown>) => f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { path: 'file.example', ...op } });
                const explicit = DaemonLspSyncResponseSchema.parse(await sync({ op: 'open', languageId: 'example', text: 'example', version: 1, unsaved: false }));
                expect.soft(explicit).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { hover: true, rename: false } });
                const fallback = DaemonLspSyncResponseSchema.parse(await sync({ op: 'snapshot', languageId: 'text', text: 'example two', version: 2, unsaved: false }));
                expect.soft(fallback).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { rename: false } });
                expect.soft(await sync({ op: 'change', baseVersion: 2, version: 3, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 7, text: 'changed' }, unsaved: true }))
                    .toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { rename: false } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                const opened = (await f.messages()).filter(message => message.method === 'textDocument/didOpen');
                expect(opened).toContainEqual(expect.objectContaining({ params: { textDocument: expect.objectContaining({ languageId: 'example-lsp' }) } }));
                expect.soft(await sync({ op: 'close' })).toMatchObject({ status: 'ok', servers: [], capabilities: { hover: false } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('retains a shared document until its last holder closes', async () => {
        await withTempDir('happier-lsp-shared-document-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', 'shared');
                await f.open('a.ts', 'shared');
                expect(f.protocolHandles).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                expect(f.protocolHandles).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            } finally { await f.host.dispose(); }
        });
    });
    it('settles an opening holder and terminates its child when close arrives during initialize', async () => {
        await withTempDir('happier-lsp-close-initialize-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, { stallInitialize: true });
            try {
                const opening = f.open('a.ts', 'shared');
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'initialize')).toBe(true));
                // The controller can subscribe before open acknowledges: the real
                // Machine watch already reports native startup during initialize.
                expect(DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
                    .toMatchObject({ status: 'ok', servers: [{ state: 'starting', loading: false }] });
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } })).toMatchObject({ status: 'ok' });
                await opening;
                expect(f.protocolHandles).toHaveLength(1);
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            } finally { await f.host.dispose(); }
        });
    });
    it('does not start a child after its holder closes during asynchronous marker discovery', async () => {
        await withTempDir('happier-lsp-close-markers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            await writeFile(join(rootPath, 'project.marker'), '');
            const f = await fixture(rootPath, 1, {}, ['project.marker']);
            try {
                const opening = f.open('a.ts', 'shared');
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } })).toMatchObject({ status: 'ok' });
                await opening;
                expect(f.protocolHandles).toHaveLength(0);
                const watch = DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }));
                expect(watch).toMatchObject({ status: 'ok', servers: [] });
            } finally { await f.host.dispose(); }
        });
    });
    it('prevents late attachment after host disposal during asynchronous marker discovery', async () => {
        await withTempDir('happier-lsp-dispose-markers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            await writeFile(join(rootPath, 'project.marker'), '');
            const f = await fixture(rootPath, 1, {}, ['project.marker']);
            try {
                const opening = f.open('a.ts', 'shared');
                await f.host.dispose();
                await opening;
                expect(f.protocolHandles).toHaveLength(0);
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['linux', 'darwin'] as const)('keeps narrower marker sessions independent with workspace external changes on %s', async platform => {
        await withTempDir('happier-lsp-marker-sessions-', async rootPath => {
            for (const directory of ['one', 'two']) {
                await mkdir(join(rootPath, directory));
                await writeFile(join(rootPath, directory, 'project.marker'), '');
                await writeFile(join(rootPath, directory, 'a.ts'), directory);
            }
            await writeFile(join(rootPath, 'unrelated.ts'), 'unrelated');
            const f = await fixture(rootPath, 1, {}, ['project.marker'], undefined, undefined, platform);
            try {
                await f.open('one/a.ts', 'one');
                await f.open('two/a.ts', 'two');
                expect(f.protocolHandles).toHaveLength(2);
                for (const directory of ['one', 'two']) {
                    expect(await f.query('hover', `${directory}/a.ts`, { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: directory }] });
                    expect(await f.query('references', `${directory}/a.ts`, { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', locations: [{ path: `${directory}/a.ts`, lineText: directory }] });
                }
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'external', paths: ['two/a.ts', 'unrelated.ts'] } })).toMatchObject({ status: 'ok' });
                await Promise.all(f.protocolHandles.map(handle => handle.client.request('fixture/barrier')));
                const changes = (await f.messages()).filter(message => message.method === 'workspace/didChangeWatchedFiles');
                expect(changes).toHaveLength(platform === 'linux' ? 2 : 0);
                for (const change of changes) expect(change).toMatchObject({ params: { changes: [{ uri: expect.stringContaining('/two/a.ts') }, { uri: expect.stringContaining('/unrelated.ts') }] } });
                expect(f.protocolHandles).toHaveLength(2);
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['snapshot', 'open'] as const)('restores every existing holder when a registry update adds a definition on %s', async operation => {
        await withTempDir('happier-lsp-registry-holders-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', 'shared', 7);
                await f.open('a.ts', 'shared', 7);
                f.setDefinitionCount(2);
                expect.soft(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: operation, path: 'a.ts', languageId: 'typescript', version: 21, text: 'shared', unsaved: false } }))
                    .toMatchObject({ status: 'ok', version: 7 });
                expect(f.protocolHandles).toHaveLength(2);
                expect.soft(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 7, sections: [{ markdown: 'shared' }, { markdown: 'shared' }] });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.query('hover', 'a.ts', { serverId: 'fixture/server1', position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server1', markdown: 'shared' }] });
                expect(f.protocolHandles).toHaveLength(2);
                if (operation === 'open') {
                    await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                    expect(await f.query('hover', 'a.ts', { serverId: 'fixture/server1', position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok' });
                    expect(f.protocolHandles).toHaveLength(2);
                }
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await Promise.all(f.protocolHandles.map(handle => expect(handle.wait()).resolves.toBeDefined()));
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves special property names as own watch dictionary paths', async () => {
        await withTempDir('happier-lsp-watch-keys-', async rootPath => {
            const f = await fixture(rootPath);
            try {
                for (const path of ['__proto__', 'constructor']) {
                    await writeFile(join(rootPath, path), 'broken');
                    await f.open(path, 'broken');
                    expect(await f.query('diagnostics', path)).toMatchObject({ status: 'ok', diagnostics: [{ path, message: 'broken' }] });
                }
                const rawWatch = await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath });
                if (!rawWatch || typeof rawWatch !== 'object' || !('diagnostics' in rawWatch) || !rawWatch.diagnostics || typeof rawWatch.diagnostics !== 'object') throw new Error('Expected watch diagnostics dictionary');
                expect(Object.hasOwn(rawWatch.diagnostics, '__proto__')).toBe(true);
                const watch = DaemonLspWatchResponseSchema.parse(rawWatch);
                if (watch.status !== 'ok') throw new Error('Expected watch snapshot');
                expect(Object.keys(watch.diagnostics).sort()).toEqual(['__proto__', 'constructor']);
                for (const path of ['__proto__', 'constructor']) {
                    expect(Object.hasOwn(watch.diagnostics, path)).toBe(true);
                    expect(watch.diagnostics[path]).toMatchObject({ 'fixture/server0': { state: 'ready', items: [{ path, message: 'broken' }] } });
                }
            } finally { await f.host.dispose(); }
        });
    });
    it('retains complete stdio reference responses beyond the unrelated tunnel budget', async () => {
        await withTempDir('happier-lsp-large-references-', async rootPath => {
            const text = 'x\n'.repeat(3500);
            await writeFile(join(rootPath, 'a.ts'), text);
            const f = await fixture(rootPath, 1, { referenceCount: 3500 });
            try {
                await f.open('a.ts', text);
                const result = DaemonLspQueryResponseSchema.parse(await f.query('references', 'a.ts', { position: { line: 0, character: 0 } }));
                expect(result).toMatchObject({ status: 'ok', kind: 'references', hasMore: false });
                if (result.status !== 'ok' || result.kind !== 'references') throw new Error('Expected references');
                expect(result.locations).toHaveLength(3500);
                expect(result.locations.at(-1)?.range.start.line).toBe(3499);
                expect(result.locations.every(location => location.lineText === 'x')).toBe(true);
                expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
            } finally { await f.host.dispose(); }
        });
    });
    it('retains one reference with a multibyte preview larger than the unrelated tunnel budget', async () => {
        await withTempDir('happier-lsp-large-reference-row-', async rootPath => {
            const text = 'λ'.repeat(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
            await writeFile(join(rootPath, 'a.ts'), text);
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', text);
                const result = DaemonLspQueryResponseSchema.parse(await f.query('references', 'a.ts', { position: { line: 0, character: 0 } }));
                expect(result).toMatchObject({ status: 'ok', kind: 'references', hasMore: false });
                if (result.status !== 'ok' || result.kind !== 'references') throw new Error('Expected references');
                expect(result.locations).toHaveLength(1);
                expect(result.locations[0]).toMatchObject({ path: 'a.ts', lineText: text });
            } finally { await f.host.dispose(); }
        });
    });
});
