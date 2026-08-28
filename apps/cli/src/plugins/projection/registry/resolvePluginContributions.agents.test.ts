import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
    planAgentCliInstallForRuntime,
    resolveAgentCliCommandForRuntime,
} from '@happier-dev/cli-common/agents';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { readCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { projectLoadedPluginContributes } from './resolvePluginContributions';

function loadedAgentPlugin(): LoadedPlugin {
    const pluginId = 'com.acme.agent';
    return {
        pluginId,
        pluginRootPath: `/plugins/${pluginId}`,
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: normalizePluginManifestV2({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Acme Agent',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'agent-process',
                    capability: 'process',
                    reason: 'Run the declared Agent executable',
                    scope: { executables: [{ kind: 'systemTool', id: 'acme-cli' }] },
                }],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'acme',
                    title: 'Acme',
                    runtime: { kind: 'custom' },
                    cli: {
                        executable: {
                            binaryName: 'acme',
                            alternativeBinaryNames: ['acme-cli'],
                            knownUserBinDirSuffixes: ['.acme/bin'],
                            sourcePreference: 'system-first',
                            acceptsJavaScriptFileOverride: false,
                        },
                        install: {
                            managed: {
                                kind: 'github_release_binary',
                                githubRepo: 'acme/cli',
                                binaryName: 'acme',
                            },
                            manual: {
                                kind: 'vendor_recipe',
                                recipes: {
                                    darwin: [{ cmd: 'brew', args: ['install', 'acme'] }],
                                    linux: [{ cmd: 'sh', args: ['install-acme'] }],
                                    win32: [{ cmd: 'winget', args: ['install', 'acme'] }],
                                },
                            },
                            guideUrl: 'https://example.com/acme/install',
                            docsUrl: 'https://example.com/acme/docs',
                        },
                        auth: {
                            support: 'login_terminal',
                            environmentVariables: ['ACME_API_KEY'],
                            loginLaunches: [
                                { kind: 'primary', args: ['login'] },
                                { kind: 'device_code', args: ['login', '--device-code'] },
                            ],
                        },
                    },
                    primary: 'sessions',
                    capabilities: {
                        surfaces: ['terminal', 'externalSessions'],
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                    surfaces: {
                        externalSession: {
                            sources: [{
                                sourceKind: 'acmeConfig',
                                schema: {
                                    fields: [{ name: 'kind', kind: 'literal', value: 'acmeConfig' }],
                                },
                                key: { segments: [{ kind: 'literal', value: 'acmeConfig' }] },
                                instances: [{ kind: 'default', constants: {} }],
                            }],
                        },
                    },
                }],
            },
        }),
    };
}

describe('resolved plugin Agent projection', () => {
    it('retains the same canonical Manifest V2 definition and projects executable, install, auth, and login facts for bundled and external plugins', async () => {
        const plugin = loadedAgentPlugin();
        const bundled = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
            provenance: 'first_party',
        }).agents?.[0];
        const external = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
            provenance: 'external',
        }).agents?.[0];

        expect(bundled?.richDefinition).toEqual({
            provenance: 'first_party',
            definition: plugin.manifest.contributes.agents[0],
        });
        expect(external?.richDefinition).toEqual({
            provenance: 'external',
            definition: plugin.manifest.contributes.agents[0],
        });
        expect(bundled?.richDefinition?.definition).toEqual(external?.richDefinition?.definition);
        expect(external?.cliMetadata).toEqual(plugin.manifest.contributes.agents[0]?.cli);
        expect(external?.richDefinition?.definition).not.toHaveProperty('agentCliRuntime');
        expect(external?.hostAccess).toEqual(plugin.manifest.hostAccess);
        expect(external?.identity).toEqual({
            pluginId: 'com.acme.agent',
            localId: 'acme',
        });
        expect(readCurrentExternalSessionAgentIdentity(external)).toEqual({
            identity: { pluginId: 'com.acme.agent', localId: 'acme' },
            sourceKinds: ['acmeConfig'],
        });
        expect(bundled?.richDefinition?.definition.capabilities.surfaces).toEqual([
            'terminal',
            'externalSessions',
        ]);
        // Capability parity is exact; only the routing id differs, because a
        // bundled Agent keeps its released unqualified identifier while an
        // installed Agent is addressed by its qualified `{pluginId, localId}`.
        expect(bundled?.id).toBe('acme');
        expect(external?.id).toBe('com.acme.agent/acme');
        expect({ ...bundled?.runtimeSpec, id: null }).toEqual({ ...external?.runtimeSpec, id: null });
        expect(bundled?.runtimeSpec?.id).toBe('acme');
        expect(external?.runtimeSpec).toMatchObject({
            id: 'com.acme.agent/acme',
            title: 'Acme',
            binaryName: 'acme',
            alternativeBinaryNames: ['acme-cli'],
            knownUserBinDirSuffixes: ['.acme/bin'],
            sourcePreferenceDefault: 'system-first',
            managedInstall: {
                kind: 'github_release_binary',
                githubRepo: 'acme/cli',
                binaryName: 'acme',
            },
            manualInstallKind: 'vendor_recipe',
            installGuideUrl: 'https://example.com/acme/install',
            docsUrl: 'https://example.com/acme/docs',
        });
        expect(external?.runtimeSpec?.manualInstallRecipes?.win32).toEqual([
            { cmd: 'winget', args: ['install', 'acme'] },
        ]);
        const runtimeSpec = external?.runtimeSpec;
        if (!runtimeSpec) throw new Error('expected native Agent runtime descriptor');
        const manualRuntimeSpec = { ...runtimeSpec, managedInstall: null };
        for (const [platform, commands] of [
            ['darwin', [{ cmd: 'brew', args: ['install', 'acme'] }]],
            ['linux', [{ cmd: 'sh', args: ['install-acme'] }]],
            ['win32', [{ cmd: 'winget', args: ['install', 'acme'] }]],
        ] as const) {
            expect(planAgentCliInstallForRuntime({
                runtimeSpec: manualRuntimeSpec,
                platform,
            })).toMatchObject({
                ok: true,
                plan: {
                    installMode: 'vendor_recipe',
                    docsUrl: 'https://example.com/acme/install',
                    commands,
                },
            });
        }
        if (process.platform !== 'win32') {
            const executableDir = await mkdtemp(join(tmpdir(), 'happier-native-agent-cli-'));
            try {
                const alternativeBinary = join(executableDir, 'acme-cli');
                await writeFile(alternativeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
                await chmod(alternativeBinary, 0o755);
                expect(resolveAgentCliCommandForRuntime(runtimeSpec, {
                    processEnv: { PATH: [executableDir, process.env.PATH ?? ''].join(delimiter) },
                })).toEqual({ source: 'system', command: alternativeBinary });
            } finally {
                await rm(executableDir, { recursive: true, force: true });
            }
        }

        expect(bundled?.catalogEntry?.id).toBe('acme');
        expect(external?.catalogEntry?.id).toBe('com.acme.agent/acme');
        expect(await external?.catalogEntry?.getCliDetect?.()).toEqual({
            versionArgsToTry: [['--version'], ['version'], ['-v']],
            loginStatusArgs: null,
        });
        const authSpec = await external?.catalogEntry?.getCliAuthSpec?.();
        expect(authSpec?.binaryNames).toEqual(['acme', 'acme-cli']);
        const previousApiKey = process.env.ACME_API_KEY;
        try {
            delete process.env.ACME_API_KEY;
            await expect(authSpec?.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/acme' })).resolves.toMatchObject({
                state: 'logged_out',
                reason: 'missing_credentials',
            });
            process.env.ACME_API_KEY = 'secret';
            await expect(authSpec?.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/acme' })).resolves.toMatchObject({
                state: 'logged_in',
                method: 'api_key_env',
                source: 'env',
            });
        } finally {
            if (previousApiKey === undefined) delete process.env.ACME_API_KEY;
            else process.env.ACME_API_KEY = previousApiKey;
        }

        expect(external?.cliMetadata?.auth.loginLaunches).toEqual([
            { kind: 'primary', args: ['login'] },
            { kind: 'device_code', args: ['login', '--device-code'] },
        ]);
    });
});
