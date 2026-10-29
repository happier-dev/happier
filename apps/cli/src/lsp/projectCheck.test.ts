import { describe, expect, it } from 'vitest';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { isPidAlive } from '@/testkit/process/spawn';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import { createLanguageServerProjectChecker } from './projectCheck';

const definition: LanguageServerDefinition = {
    id: 'fixture/checker', pluginId: 'fixture', manifestPath: '/fixture/plugin.json', title: 'Fixture',
    languageIds: { fixture: 'fixture' }, executable: { kind: 'systemTool', id: 'server' }, args: [],
    projectCheck: { executable: { kind: 'systemTool', id: 'checker' }, args: [],
        projectFile: 'tsconfig.json', output: { kind: 'typescript' } },
};
const processOwner = { kind: 'service', serviceId: 'lsp:fixture/checker:0123456789ab' } as const;

function fixture(rootPath: string, scenario: string) {
    return createLanguageServerProjectChecker({ async acquireExec(input) {
        const service = createStablePluginExecService({
            allowedExecutables: [input.definition.executable], signal: input.signal,
            processOwner: input.processOwner,
            isOccurrenceCurrent: () => !input.signal.aborted,
            resolveExecutable: async () => ({ command: process.execPath,
                args: [resolve('src/lsp/__fixtures__/projectCheck.cjs'), scenario, join(rootPath, 'started')] }),
            resolvePath: async () => rootPath,
        });
        return { service, signal: input.signal, release: async () => {} };
    } });
}

async function started(rootPath: string) {
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

describe('declared project checker', () => {
    it('completes nonzero problem output, preserves continuation and config diagnostics, and normalizes rooted paths', async () => {
        await withTempDir('happier-project-check-', async rootPath => {
            const checker = fixture(rootPath, 'diagnostics');
            const result = await checker.run({ definition, rootPath, processOwner, signal: new AbortController().signal });
            expect(result).toMatchObject({ status: 'completed', diagnostics: [
                { serverId: definition.id, path: 'src/a(b).ts', code: 'TS2322', severity: 'error',
                    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, message: 'Wrong type\n  More detail' },
                { path: 'tsconfig.json', code: 'TS18003', message: 'No inputs were found' },
            ] });
            expect(checker.readProcessRoots()).toEqual([]);
        });
    });

    it.each(['empty-failure', 'unparseable', 'outside'])('does not turn %s output into a successful empty project', async scenario => {
        await withTempDir('happier-project-check-failed-', async rootPath => {
            expect(await fixture(rootPath, scenario).run({ definition, rootPath, processOwner, signal: new AbortController().signal }))
                .toMatchObject({ status: 'failed' });
        });
    });

    it('completes a clean checker and preserves output beyond the process buffer', async () => {
        await withTempDir('happier-project-check-large-', async rootPath => {
            const input = { definition, rootPath, processOwner, signal: new AbortController().signal };
            expect(await fixture(rootPath, 'clean').run(input)).toEqual({ status: 'completed', diagnostics: [] });
            const result = await fixture(rootPath, 'large').run(input);
            expect(result.status).toBe('completed');
            if (result.status === 'completed') expect(result.diagnostics).toHaveLength(90_000);
        });
    });

    it('exposes the supervised process while running and cancellation waits for its exit', async () => {
        await withTempDir('happier-project-check-cancel-', async rootPath => {
            const checker = fixture(rootPath, 'wait');
            const controller = new AbortController();
            const pending = checker.run({ definition, rootPath, processOwner, signal: controller.signal });
            try {
                await started(rootPath);
                const roots = checker.readProcessRoots();
                expect(roots).toMatchObject([{ owner: processOwner, workspacePath: rootPath, live: true }]);
                const pid = roots[0].pid;
                expect(isPidAlive(pid)).toBe(true);
                controller.abort();
                expect(await pending).toMatchObject({ status: 'cancelled' });
                expect(isPidAlive(pid)).toBe(false);
                expect(checker.readProcessRoots()).toEqual([]);
            } finally { controller.abort(); await pending; }
        });
    });
});
