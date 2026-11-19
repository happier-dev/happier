import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { AgentExecutionRunEvent, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginFileSystemService } from '@/plugins/runtime/invocation/services/filesystem';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { activate, PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/review-deepsec/src/index';
import { buildGitSnapshot } from '../../../../../../../packages/plugins/scm-git/src/statusSnapshot';

it.each([
    { selectedPath: join('src', 'nested', 'name café.ts'), refused: false },
    ...(process.platform === 'win32' ? [] : [{ selectedPath: 'src/nested\\name café.ts', refused: true }]),
])('preserves native selected path identity (refused=$refused, path=$selectedPath)', async ({ selectedPath, refused }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-deepsec-path-identity-'));
    const literalPath = 'src/nested\\name café.ts';
    const slashPath = 'src/nested/name café.ts';
    try {
        execFileSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
        await mkdir(join(directory, 'src', 'nested'), { recursive: true });
        if (process.platform !== 'win32') await writeFile(join(directory, literalPath), 'selected literal filename');
        await writeFile(join(directory, slashPath), 'unrelated slash filename');
        const snapshot = buildGitSnapshot({ projectKey: 'fixture', fetchedAt: 0, rootPath: directory,
            statusOutput: execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: directory, encoding: 'utf8' }),
            includedNumStatOutput: '', pendingNumStatOutput: '' });
        expect(snapshot.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([slashPath, ...(process.platform === 'win32' ? [] : [literalPath])]));
        const signal = new AbortController().signal;
        const nativeFs = createPluginFileSystemService({ roots: { pluginData: join(directory, 'data'), workspace: directory, projects: new Map() },
            signal, isOccurrenceCurrent: () => true });
        const stat = vi.fn(nativeFs.stat);
        const unavailable = createUnavailablePluginServices();
        const nativeLists: string[] = [];
        // Only native process execution and unrelated host I/O ports are substituted.
        // Git status production, registered plugin, scope translation and host fs stay real.
        const services: PluginServices = { ...unavailable,
            availability: id => id === 'fs' || id === 'exec' ? { status: 'available' } : unavailable.availability(id),
            fs: { ...unavailable.fs, ...nativeFs, stat },
            connectedAccounts: { ...unavailable.connectedAccounts, resolveSelection: async () => ({ credentialSource: 'machineLogin' }) },
            exec: { ...unavailable.exec,
                agentCli: { checkReadiness: async () => ({ launchable: [{ agentId: 'claude' }] }) },
                systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'deepsec-cli' }, executablePath: '/native/deepsec' }) },
                async run(request) {
                    const listIndex = request.args?.indexOf('--files-from') ?? -1;
                    const list = listIndex < 0 ? undefined : request.args?.[listIndex + 1];
                    if (list) nativeLists.push(await readFile(list, 'utf8'));
                    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                },
            },
        };
        const unused = async (): Promise<never> => { throw new Error('Unexpected UI or protocol access'); };
        const context: AgentRuntimeContext = { plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: 'deepsec', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/deepsec` },
            surface: 'agent', signal, services, agent: { id: 'deepsec' }, protocols: { acp: { open: unused } },
            ui: { askQuestions: unused, confirm: unused, notify: unused, status: { set: unused }, widget: { set: unused },
                title: { set: unused }, composer: { replace: unused } } };
        const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        try {
            const factory = plugin.registration('agents', 'deepsec')?.factory;
            if (!factory) throw new Error('DeepSec Agent registration missing');
            const agent = await factory({ plugin: context.plugin, agent: context.agent, signal });
            const changedPaths = snapshot.entries.map(entry => ({ path: entry.path, previousPath: null, kind: 'added',
                hasCommittedDelta: false, hasUncommittedDelta: true, diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false } }));
            const runtime = await agent.executionRuns?.open({ kind: 'create', runId: 'path-identity', cwd: directory,
                profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'review' }, input: { text: 'Review selected file', structuredInput: {
                    reviewers: [{ kind: 'engine', engineId: 'deepsec' }], instructions: 'Review selected file',
                    engines: { deepsec: { mode: 'selected_files', confirmedCostWarning: true } },
                    scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
                        repositoryRoot: directory, worktreeRoot: directory, baseRef: { source: 'unavailable', ref: null },
                        selectedPaths: [selectedPath], changedPaths, committedPaths: [], uncommittedPaths: changedPaths,
                        diff: { committedAvailable: false, uncommittedAvailable: true }, diagnostics: [] } } } }, context);
            if (!runtime) throw new Error('DeepSec execution runtime missing');
            try {
                const events: AgentExecutionRunEvent[] = [];
                await new Promise<void>(resolve => runtime.watch(event => {
                    events.push(event);
                    if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve();
                }));
                if (refused) {
                    expect(events.at(-1), JSON.stringify({ terminal: events.at(-1), nativeLists }))
                        .toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_scope_failed' } });
                    expect(nativeLists).toEqual([]);
                    expect(stat).not.toHaveBeenCalled();
                } else {
                    expect(events.at(-1)).toMatchObject({ kind: 'run-complete' });
                    expect(nativeLists).toEqual([`${slashPath}\n`]);
                    expect(stat).toHaveBeenCalledWith({ root: 'workspace', relativePath: slashPath },
                        { signal: expect.any(AbortSignal) });
                }
            } finally { await runtime.dispose(); }
        } finally { await plugin.dispose(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
});
