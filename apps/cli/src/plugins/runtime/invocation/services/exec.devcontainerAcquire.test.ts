import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { DEVCONTAINER_PLUGIN } from '@happier-dev/plugins-devcontainer/manifest';
import { createDevcontainerProvider } from '../../../../../../../packages/plugins/devcontainer/src/machine/provider';
import { readDevcontainerEffectReview } from '../../../../../../../packages/plugins/devcontainer/src/machine/effectReview';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { captureProcessTree } from '@/processes/terminate/terminateProcessTree';
import { withTempDir } from '@/testkit/fs/tempDir';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { createProductionPluginInvocationServiceOwners } from './production';

function nativeResult(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

describe('Devcontainer acquisition process composition', () => {
    it('keeps the native container attachment alive after successful up and invocation retirement', async ({ task }) => {
        if (process.platform === 'win32') return;
        await withTempDir('happier-devcontainer-up-', async directory => {
            const containerId = 'a'.repeat(64);
            const configPath = join(directory, '.devcontainer', 'devcontainer.json');
            const script = join(directory, 'native-up.cjs');
            const ready = join(directory, 'ready.json');
            const release = join(directory, 'release');
            await mkdir(join(directory, '.devcontainer'));
            await writeFile(configPath, JSON.stringify({ image: 'example:latest' }));
            await writeFile(script, `
                const fs = require('node:fs');
                const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
                child.unref();
                process.stdout.write(${JSON.stringify(JSON.stringify({ outcome: 'success', containerId, remoteUser: 'coder', remoteWorkspaceFolder: '/workspace' }))},
                    () => fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: process.pid, attachment: child.pid })));
                setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
            `);
            const manifest = normalizePluginManifestV2(DEVCONTAINER_PLUGIN.manifest);
            const controller = new AbortController();
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                // Substitute the native executable; production Exec owns its real process tree.
                exec: { resolveExecutable: async () => ({ command: process.execPath, args: [script] }), resolvePath: async () => directory } });
            let attachment: number | undefined;
            try {
                const seed = { plugin: { id: manifest.id, version: manifest.version },
                    contribution: { id: 'acquire', qualifiedId: `${manifest.id}/actions/acquire` },
                    occurrenceId: 'devcontainer-up-test', correlationId: 'devcontainer-up-test', surface: 'cli' as const,
                    signal: controller.signal, isOccurrenceCurrent: () => true };
                const binding = owners.resolveInvocationHostPolicy({ pluginId: manifest.id, occurrenceId: seed.occurrenceId,
                    qualifiedId: seed.contribution.qualifiedId }, { hostAccessRequests: manifest.hostAccess.required.map(request => ({ request, required: true })),
                    surface: seed.surface, signal: seed.signal }).serviceBinding;
                const services = owners.createServices(seed, binding);
                const executable = (localId: string) => ({ kind: 'managedDependency' as const, id: { pluginId: manifest.id, localId } });
                const exec: Pick<ExecService, 'run' | 'spawn'> = { spawn: services.exec.spawn, run: async (request, options) => {
                    if (request.args?.[0] === 'up') return services.exec.run(request, options);
                    // Other native observations remain external boundary fixtures.
                    switch (request.args?.[0]) {
                        case 'read-configuration': return nativeResult({ configuration: { image: 'example:latest' },
                            mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/workspace' },
                            workspace: { workspaceFolder: '/workspace' }, featuresConfiguration: { featureSets: [] } });
                        case 'image': return nativeResult([{ Id: 'sha256:image', Config: { Labels: {} } }]);
                        case 'inspect': return nativeResult([{ Id: containerId, State: { Running: true, Paused: false },
                            Config: { Labels: { 'devcontainer.local_folder': directory, 'devcontainer.config_file': configPath,
                                'happier.managed-machine': 'managed-up' } }, Mounts: [] }]);
                        case 'exec': return nativeResult('coder\n/workspace\n');
                        default: throw new Error(`Unexpected native command: ${request.args?.[0]}`);
                    }
                } };
                const tools = { exec, docker: executable('docker'), devcontainer: executable('devcontainer-cli'), signal: controller.signal, observedAt: 1 };
                const reviewed = await readDevcontainerEffectReview(tools, { workspaceFolder: directory, configPath });
                const acquisition = createDevcontainerProvider(tools).acquire(reviewed.launch, 'managed-up');
                let root = 0;
                await vi.waitUntil(async () => {
                    try { const ids = JSON.parse(await readFile(ready, 'utf8')) as { root: number; attachment: number };
                        root = ids.root; attachment = ids.attachment; return true; }
                    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
                }, { timeout: task.timeout });
                expect((await captureProcessTree({ pid: root })).status).toBe('ok');
                await writeFile(release, '');
                expect(await acquisition).toMatchObject({ kind: 'bound' });
                controller.abort();
                await owners.dispose();
                expect(await waitForProcessExit(attachment!, { timeoutMs: 200 })).toBe(false);
            } finally {
                controller.abort();
                await owners.dispose();
                if (attachment) {
                    try { process.kill(attachment, 'SIGKILL'); } catch { /* already terminated */ }
                    await waitForProcessExit(attachment);
                }
            }
        });
    });
});
