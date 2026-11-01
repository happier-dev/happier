import { describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { LUME_PLUGIN } from '@happier-dev/plugins-machine-lume/manifest';
import { CUA_PLUGIN } from '@happier-dev/plugins-machine-cua/manifest';
import { DOCKER_SANDBOXES_PLUGIN } from '@happier-dev/plugins-machine-docker-sandboxes/manifest';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

import { createProductionPluginInvocationServiceOwners } from './production';

describe('native provisioner production process composition', () => {
    it.for(['run', 'spawn'] as const)('preserves native descendants through the public %s projection after invocation retirement', async (method, { task }) => {
        await withTempDir('happier-native-exec-composed-', async directory => {
            vi.stubEnv('HAPPIER_STACK_STACK', 'native-lifetime-fixture');
            vi.stubEnv('HAPPIER_STACK_ENV_FILE', `${directory}/env`);
            vi.stubEnv('HAPPIER_STACK_PROCESS_KIND', 'daemon');
            const fixture = createDaemonizingProcessFixture(directory);
            const manifest = normalizePluginManifestV2(LIMA_PLUGIN.manifest);
            const controller = new AbortController();
            let failNextDiscovery = method === 'run';
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                // Only executable discovery crosses a substituted OS boundary.
                exec: { resolveExecutable: async () => {
                    if (failNextDiscovery) {
                        failNextDiscovery = false;
                        throw new Error('Executable discovery unavailable');
                    }
                    // Exercise a valid OS discovery phase beyond waitFor's 1s default.
                    if (method === 'run') await delay(1_100);
                    return { command: process.execPath };
                }, resolvePath: async () => directory },
            });
            try {
                const seed = { plugin: { id: manifest.id, version: manifest.version },
                    contribution: { id: 'power', qualifiedId: `${manifest.id}/actions/power` },
                    occurrenceId: 'native-lifetime-test', correlationId: 'native-lifetime-test', surface: 'cli' as const,
                    signal: controller.signal, isOccurrenceCurrent: () => true };
                const binding = owners.resolveInvocationHostPolicy({ pluginId: manifest.id,
                    occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
                }, { hostAccessRequests: manifest.hostAccess.required.map(request => ({ request, required: true })),
                    surface: seed.surface, signal: seed.signal }).serviceBinding;
                const services = owners.createServices(seed, binding);
                const access = manifest.hostAccess.required.find(request => request.capability === 'process');
                if (!access || access.capability !== 'process') throw new Error('Native executable declaration missing');
                const executable = access.scope.executables[0]!;
                const request = { executable, args: fixture.args };
                const options = { descendantDisposition: 'preserve-on-success' as const, signal: controller.signal };
                if (method === 'run') {
                    const rejectedLaunch = services.exec.run(request, options);
                    const launchError: unknown = await rejectedLaunch.catch((error: unknown) => error);
                    expect(launchError).toMatchObject({ code: 'plugin_exec_resolve_failed' });
                    await expect(fixture.ready({ launch: rejectedLaunch, timeoutMs: task.timeout })).rejects.toBe(launchError);
                }
                const handle = method === 'spawn' ? await services.exec.spawn(request, options) : null;
                const pending = handle ? handle.wait() : services.exec.run(request, options);
                const pid = await fixture.ready({ launch: pending, timeoutMs: task.timeout });
                await fixture.release();
                expect((await pending).termination).toEqual({ observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } });
                await handle?.dispose();
                controller.abort();
                await owners.dispose();
                expect(await waitForProcessExit(pid, { timeoutMs: 200 })).toBe(false);
                if (process.platform === 'linux') {
                    const keys = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')
                        .map(entry => entry.slice(0, entry.indexOf('='))).filter(key => key.startsWith('HAPPIER_STACK_'));
                    expect(keys).toEqual([]);
                }
            } finally {
                controller.abort();
                await owners.dispose();
                await fixture.cleanup();
                vi.unstubAllEnvs();
            }
        });
    });

    it.each([LUME_PLUGIN.manifest, CUA_PLUGIN.manifest, DOCKER_SANDBOXES_PLUGIN.manifest].map(manifest => normalizePluginManifestV2(manifest)))(
        'preserves native overrides and inherited host configuration for $id',
        async (manifest) => {
            vi.stubEnv('NATIVE_AMBIENT_CONFIGURATION', 'ambient-configuration');
            vi.stubEnv('NATIVE_CONFIGURATION', 'ambient-configuration');
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write() {} },
                exec: {
                    // Replace only the native executable, keeping host composition
                    // and process supervision real for each public manifest.
                    resolveExecutable: async () => ({ command: process.execPath }),
                    resolvePath: async () => process.cwd(),
                },
            });
            try {
                const requests = manifest.hostAccess.required.map(request => ({ request, required: true }));
                const processRequest = manifest.hostAccess.required.find(request => request.capability === 'process');
                if (!processRequest || processRequest.capability !== 'process') throw new Error('Native process declaration is missing');
                const executable = processRequest.scope.executables[0];
                if (!executable) throw new Error('Native executable declaration is missing');
                const seed = {
                    plugin: { id: manifest.id, version: manifest.version },
                    contribution: { id: 'check', qualifiedId: `${manifest.id}/actions/check` },
                    occurrenceId: 'native-process-test', correlationId: 'native-process-test', surface: 'cli' as const,
                    signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                };
                const binding = owners.resolveInvocationHostPolicy({ pluginId: manifest.id,
                    occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
                }, { hostAccessRequests: requests, surface: seed.surface, signal: seed.signal }).serviceBinding;
                const services = owners.createServices(seed, binding);
                const result = await services.exec.run({ executable,
                    args: ['-e', 'process.stdout.write(JSON.stringify({selected:process.env.NATIVE_CONFIGURATION, ambient:process.env.NATIVE_AMBIENT_CONFIGURATION}))'],
                    env: { NATIVE_CONFIGURATION: 'selected-configuration' },
                });
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ selected: 'selected-configuration', ambient: 'ambient-configuration' });
            } finally {
                await owners.dispose();
                vi.unstubAllEnvs();
            }
        },
    );
});
