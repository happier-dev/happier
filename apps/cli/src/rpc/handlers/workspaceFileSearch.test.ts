import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ripgrep from '@/integrations/ripgrep/index';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileSearchResponseSchema, WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol';
import { registerWorkspaceFileSearchHandler } from './workspaceFileSearch';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { DaemonWorkspaceFileSearchRequest } from '@happier-dev/protocol/machines/workspaceFiles';

describe('workspace file content search through the registered daemon owner', () => {
    it('retains a matching file above 256 KiB within the Socket.IO reply boundary', async () => {
        const text = `needle ${'é😀'.repeat(55_000)}`;
        await writeFile(join(root, 'large.txt'), `${text}\n`);
        const result = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle', contextLines: 0 }));
        expect(result).toMatchObject({ ok: true, coverage: 'complete', hasMore: false,
            files: [{ path: 'large.txt', matches: [{ text }] }] });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(300 * 1024);
    });
    let root: string;
    let handler: RpcHandler;
    let lifetime: AbortController;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-file-content-'));
        lifetime = new AbortController();
        const handlers = new Map<string, RpcHandler>();
        const registrar: RpcHandlerRegistrar = { registerHandler: (method, next) => { handlers.set(method, next); } };
        registerWorkspaceFileSearchHandler(registrar, root);
        const registered = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!;
        handler = (request, context) => registered(request, { signal: lifetime.signal, ...context });
    });
    afterEach(async () => { lifetime.abort(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

    it('refuses an arbitrary member root before native search and preserves the typed search envelope', async () => {
        await writeFile(join(root, 'private.txt'), 'needle');
        const handlers = new Map<string, RpcHandler>();
        registerWorkspaceFileSearchHandler({ registerHandler: (method, next) => { handlers.set(method, next); } }, root, {
            effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
        });
        const search = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!;
        const native = vi.spyOn(ripgrep, 'run');
        const response = DaemonWorkspaceFileSearchResponseSchema.parse(await search({ rootPath: root, query: 'needle' }, {
            signal: lifetime.signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        }));
        expect(response).toMatchObject({ ok: false, code: 'filesystem_identity_custody_unavailable',
            details: { reason: 'requester_identity_unavailable' } });
        expect(native).not.toHaveBeenCalled();
    });

    it.each(['present_user', 'account_automation'] as const)('finishes an admitted %s search after authority changes during native work', async callerAuthority => {
        await writeFile(join(root, 'ordinary.txt'), 'needle');
        const handlers = new Map<string, RpcHandler>();
        registerWorkspaceFileSearchHandler({ registerHandler: (method, next) => { handlers.set(method, next); } }, root, {
            effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
        });
        let current = true;
        const nativeRun = ripgrep.run;
        // Preserve the real native search, changing only its completion timing
        // relative to the host's externally supplied admission-current fact.
        vi.spyOn(ripgrep, 'run').mockImplementationOnce(async (...args) => {
            const result = await nativeRun(...args);
            current = false;
            return result;
        });
        const response = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!({ rootPath: root, query: 'needle' }, {
            signal: lifetime.signal, callerAuthority,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => current,
        });
        expect(response).toMatchObject({ ok: true, files: [{ path: 'ordinary.txt', matches: [{ text: 'needle' }] }] });
    });

    it('runs code definition and text-reference Actions through the registered search owner and native rg', async () => {
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'a.ts'), 'export function greet() {}\ngreet(); greet();\nconst greeting = 1;\n');
        await writeFile(join(root, 'far.ts'), 'export function greet() {}\n');
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), languageIntelligenceQuery: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), workspaceFilesSearch: async ({ machineId, ...request }, context) => {
            expect(machineId).toBe('machine');
            return DaemonWorkspaceFileSearchResponseSchema.parse(await handler(request, { signal: context.signal ?? lifetime.signal }));
        } });
        const input = { machineId: 'machine', rootPath: root, path: 'src/a.ts', line: 2, symbol: 'greet', languageId: 'typescript' };
        const definition = await executor.execute('code.definition.get', input, { surface: 'agent' });
        expect(definition).toMatchObject({ ok: true, result: { source: 'text_matches', coverage: 'complete', hasMore: false,
            locations: [{ path: 'src/a.ts', range: { start: { line: 0, character: 16 } } }, { path: 'far.ts' }] } });
        const references = await executor.execute('code.references.list', input, { surface: 'agent' });
        expect(references).toMatchObject({ ok: true, result: { source: 'text_matches', locations: expect.any(Array) } });
        if (!references.ok) throw new Error('References Action failed');
        const result = getActionSpec('code.references.list').outputSchema!.parse(references.result);
        expect(result).toMatchObject({ locations: [
            { path: 'src/a.ts', range: { start: { line: 1, character: 0 } } },
            { path: 'src/a.ts', range: { start: { line: 1, character: 9 } } },
            { path: 'src/a.ts', range: { start: { line: 0, character: 16 } } },
            { path: 'far.ts' },
        ] });
    });

    it('keeps native code-name searches exact for Unicode, combining marks and dollar names', async () => {
        const { queryCodeIntelligenceFallback } = await import('@happier-dev/protocol/machines/codeIntelligenceFallback');
        const symbols = ['cafe\u0301', '℘', '𝒜', '$item'];
        await writeFile(join(root, 'a.ts'), symbols.map(symbol => `export const ${symbol} = 1;\n${symbol}; ${symbol}; ${symbol}Extra;`).join('\n'));
        for (const symbol of symbols) {
            const input = { rootPath: root, path: 'a.ts', line: 1, symbol, languageId: 'typescript', kind: 'references' as const };
            const search = async (request: DaemonWorkspaceFileSearchRequest) =>
                DaemonWorkspaceFileSearchResponseSchema.parse(await handler(request));
            const references = await queryCodeIntelligenceFallback(input, search);
            expect(references).toMatchObject({ status: 'ok', hasMore: false, coverage: 'complete' });
            if (references.status !== 'ok') throw new Error('Native references unavailable');
            expect(references.locations).toHaveLength(3);
            const definition = await queryCodeIntelligenceFallback({ ...input, kind: 'definition' }, search);
            expect(definition).toMatchObject({ status: 'ok', locations: [{ range: { start: { character: 13 } } }] });
            if (definition.status !== 'ok') throw new Error('Native definition unavailable');
            expect(definition.locations).toHaveLength(1);
        }
    });

    it('preserves completed text matches with partial coverage when another subtree fails traversal', async () => {
        // Native process output is the boundary; the handler parses real rg records.
        vi.spyOn(ripgrep, 'run').mockImplementationOnce(async (_args, options) => {
            for (const record of [
                { type: 'begin', data: { path: { text: 'readable.txt' } } },
                { type: 'match', data: { path: { text: 'readable.txt' }, lines: { text: 'needle\n' }, line_number: 1,
                    submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }] } },
                { type: 'end', data: { path: { text: 'readable.txt' }, binary_offset: null } },
                { type: 'summary', data: {} },
            ]) options?.onStdoutLine?.(JSON.stringify(record));
            return { stdout: '', stderr: 'private: Permission denied (os error 13)', exitCode: 2 };
        });
        expect(await handler({ rootPath: root, query: 'needle' })).toEqual({ ok: true, hasMore: false, coverage: 'partial',
            files: [{ path: 'readable.txt', matches: [{ line: 1, column16: 1, length16: 6, text: 'needle', before: [], after: [] }] }] });
        vi.spyOn(ripgrep, 'run').mockResolvedValueOnce({ stdout: '', stderr: 'private: Permission denied (os error 13)', exitCode: 2 });
        expect(await handler({ rootPath: root, query: 'needle' })).toEqual({ ok: false, code: 'ripgrep_failed' });
    });

    it('finds literal metacharacters by default, case insensitively, with UTF-16 positions and CRLF context', async () => {
        await writeFile(join(root, 'a.txt'), 'before\r\né😀 A.B A.B\r\nafter\r\n');
        const result = await handler({ rootPath: root, query: 'a.b', contextLines: 2 });
        expect(result).toEqual({ ok: true, coverage: 'complete', hasMore: false, files: [{ path: 'a.txt', matches: [
            { line: 2, column16: 5, length16: 3, text: 'é😀 A.B A.B', before: ['before'], after: ['after'] },
            { line: 2, column16: 9, length16: 3, text: 'é😀 A.B A.B', before: ['before'], after: ['after'] },
        ] }] });
        expect(DaemonWorkspaceFileSearchResponseSchema.safeParse(result).success).toBe(true);
    });

    it('supports regex and case-sensitive queries, keeps exclusions and reports invalid regex distinctly', async () => {
        await writeFile(join(root, 'a.txt'), 'abc A.B\n');
        await mkdir(join(root, 'node_modules'));
        await writeFile(join(root, 'node_modules', 'ignored.txt'), 'abc\n');
        expect(await handler({ rootPath: root, query: 'a.c', regex: true, matchCase: true, contextLines: 0 }))
            .toMatchObject({ ok: true, coverage: 'complete', files: [{ path: 'a.txt', matches: [{ text: 'abc A.B', column16: 1 }] }] });
        expect(await handler({ rootPath: root, query: '[' })).toMatchObject({ ok: true, files: [] });
        expect(await handler({ rootPath: root, query: '[', regex: true })).toMatchObject({ ok: false, code: 'invalid_pattern' });
    });

    it('returns one bounded partial page at a complete file boundary, omitting oversized files whole', async () => {
        const content = `${'needle '.repeat(3000)}\n`;
        await mkdir(join(root, 'a'));
        await writeFile(join(root, 'a.txt'), content);
        await writeFile(join(root, 'a', 'file.txt'), content);
        // Each file has one hit record with many submatches, too large alone. It is omitted whole.
        await writeFile(join(root, 'c.txt'), 'needle\n');
        const result = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle' }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
        expect(result.coverage).toBe('partial');
        expect(result.files.map((file) => file.path)).toEqual(['c.txt']);
        expect(result.hasMore).toBe(false);

        const pageText = `needle ${'é'.repeat(Math.floor(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES / 3))}\n`;
        await writeFile(join(root, 'a.txt'), pageText);
        await writeFile(join(root, 'a', 'file.txt'), pageText);
        const first = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle', contextLines: 0 }));
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.hasMore).toBe(true);
        expect(first.coverage).toBe('partial');
        const includedLargeFiles = first.files.filter((file) => file.path !== 'c.txt');
        expect(includedLargeFiles).toHaveLength(1);
        expect(['a.txt', 'a/file.txt']).toContain(includedLargeFiles[0].path);
        expect(includedLargeFiles[0].matches).toHaveLength(1);
        expect(includedLargeFiles[0].matches[0].text).toBe(pageText.trimEnd());
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
    });

    it('budgets a thousand matching files with serialization proportional to the returned page', async () => {
        const count = 1000;
        await Promise.all(Array.from({ length: count }, (_, index) =>
            writeFile(join(root, `match-${index}.txt`), 'needle café 😀\n')));
        const stringify = JSON.stringify;
        let serializedBytes = 0;
        // Observe actual JSON byte work while leaving native rg and every
        // admission/projection real. Re-serializing growing prefixes is costly
        // even when the transport payload itself stays below its real ceiling.
        vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
            const result = stringify(value, replacer, space);
            if (value && typeof value === 'object' && ('files' in value || 'matches' in value || 'column16' in value)) {
                serializedBytes += Buffer.byteLength(result);
            }
            return result;
        });
        const result = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle', contextLines: 0 }));
        expect(result).toMatchObject({ ok: true, hasMore: false, coverage: 'complete' });
        if (!result.ok) throw new Error('Expected a complete search');
        expect(result.files).toHaveLength(count);
        const wireBytes = Buffer.byteLength(stringify(result));
        expect(serializedBytes).toBeLessThanOrEqual(wireBytes * 4);
    });

    it('skips non-UTF-8 lines with partial coverage and never converts a byte bag to text', async () => {
        await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, ...Buffer.from(' needle\n')]));
        await writeFile(join(root, 'text.txt'), 'needle\n');
        expect(await handler({ rootPath: root, query: 'needle' })).toMatchObject({
            ok: true, coverage: 'partial', files: [{ path: 'text.txt' }], hasMore: false,
        });
    });

    it('reports partial coverage when a binary file stops at its native binary offset', async () => {
        await writeFile(join(root, 'binary.bin'), Buffer.from('needle\0opaque\n'));
        expect(await handler({ rootPath: root, query: 'needle' })).toMatchObject({ ok: true, coverage: 'partial', hasMore: false });
    });

    it('skips byte-oriented regex hits that have no valid UTF-16 character range', async () => {
        await writeFile(join(root, 'unicode.txt'), 'é needle\n');
        expect(await handler({ rootPath: root, query: '(?-u:\\xA9)', regex: true }))
            .toEqual({ ok: true, files: [], coverage: 'partial', hasMore: false });
    });

    it('enforces root policy, rejects caller argv, and propagates cancellation', async () => {
        const restricted = new Map<string, RpcHandler>();
        registerWorkspaceFileSearchHandler({ registerHandler: (method, next) => { restricted.set(method, next); } }, root,
            { accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
        const invoke = restricted.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!;
        expect(await invoke({ rootPath: '/not-allowed', query: 'needle' })).toMatchObject({ ok: false, code: 'root_not_allowed' });
        expect(await handler({ rootPath: root, query: 'needle', args: ['--files'] })).toMatchObject({ ok: false, code: 'ripgrep_failed' });
        const controller = new AbortController();
        controller.abort();
        await expect(handler({ rootPath: root, query: 'needle' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        // Workspace operations are Machine-owned, not Session transcript authority.
        expect(resolveSocketRpcSessionAuthorization(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)).toBeNull();
    });
});
