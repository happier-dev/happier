import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { waitForProcessExit } from '@/testkit/process/spawn';

describe('daemon-owned Agent preflight process lifetime', () => {
    it('retires a pending native catalog process when the daemon lifetime ends before registry disposal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-preflight-daemon-lifetime-'));
        const pidPath = join(root, 'native.pid');
        const script = join(root, 'probe.cjs');
        const daemon = new AbortController();
        let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        let probe: Promise<unknown> | undefined;
        let pid: number | undefined;
        try {
            await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`);
            const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
            const executable = writeExecutableShimSync({ dir: root,
                fileName: process.platform === 'win32' ? 'probe.cmd' : 'probe',
                contents: process.platform === 'win32'
                    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
            });
            runtime = await createAuthoredAdmittedPluginRuntimeFixture({
                runtimeOptions: { signal: daemon.signal },
                plugins: [{
                    manifest: createPluginManifestV2Fixture({
                        id: 'acme.preflight-lifetime',
                        contributes: {
                            agents: [{ id: 'native', title: 'Native', runtime: { kind: 'custom' }, primary: 'sessions',
                                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
                            systemTools: [{ id: 'native-cli', title: 'Native', executableNames: [executable] }],
                        },
                    }),
                    files: {
                    'runner.mjs': `export async function nativeRuntime() { throw new Error('No Session is created'); }`,
                    'daemon.mjs': `import { nativeRuntime } from './runner.mjs';
                    export function activate(api) {
                        api.agents.register('native', nativeRuntime, {
                            sessionRunnerFactory: { module: './runner.mjs', export: 'nativeRuntime', runtimeApiVersion: 1 },
                            preflightSessionControls: {
                                models: { command: { toolId: 'native-cli', args: [] }, parseOutput: () => [] },
                            },
                        });
                    }` },
                }],
            });
            const agent = runtime.registry.contributes.agents.find(value => value.pluginId === 'acme.preflight-lifetime');
            expect(runtime.registry.pluginDiagnosticsByPluginId['acme.preflight-lifetime'] ?? []).toEqual([]);
            const entry = agent ? await runtime.registry.acquireAgentCatalogEntry?.(agent.id) : null;
            const adapter = await entry?.getPreflightSessionControlsProbeAdapter?.();
            if (!adapter?.probeModelsRaw) throw new Error('Missing admitted native preflight adapter');
            probe = adapter.probeModelsRaw({ cwd: root, timeoutMs: 30_000 });
            void probe.catch(() => undefined);
            await vi.waitFor(async () => {
                pid = Number(await readFile(pidPath, 'utf8'));
                expect(pid).toBeGreaterThan(0);
            });
            daemon.abort();
            // Registry leases can still be draining. Native observation must
            // end under the daemon lifetime, before that later disposal.
            expect(await waitForProcessExit(pid!, { timeoutMs: 2_000 })).toBe(true);
            await probe;
        } finally {
            daemon.abort();
            await runtime?.dispose();
            await probe?.catch(() => undefined);
            if (pid) expect(await waitForProcessExit(pid)).toBe(true);
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);
});
