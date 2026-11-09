import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';

import { evaluatePortableCommonJs } from '../../test-support/evaluatePortableCommonJs.js';

import { discoverExecutablePluginUiArtifacts, discoverHostedStaticPluginUiArtifacts } from './manifestArtifactDiscovery.js';

import { buildUniversalPluginUiArtifacts } from './buildUniversalUiArtifacts.js';

const firstPartyArtifactCounts = Object.freeze({
    channels: 2,
    inspector: 1,
    posthog: 2,
    'scm-azure-devops': 2,
    'scm-bitbucket': 2,
    'scm-github': 2,
    'scm-gitlab': 2,
    sentry: 2,
    triage: 5,
});

const firstPartyVoicePlugins = ['codex', 'elevenlabs', 'openai', 'xai'] as const;

describe('first-party universal Plugin UI artifacts', () => {
    it('builds every declared artifact through the one esbuild compiler', async () => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        let total = 0;
        for (const pluginId of Object.keys(firstPartyArtifactCounts)) {
            const projectRoot = resolve(repositoryRoot, 'packages/plugins', pluginId);
            const declarations = [...await discoverExecutablePluginUiArtifacts(projectRoot), ...await discoverHostedStaticPluginUiArtifacts(projectRoot)];
            const result = await buildUniversalPluginUiArtifacts(
                resolve(repositoryRoot, 'packages/plugins', pluginId),
            );
            expect(result.manifest.version).toBe(2);
            expect(result.manifest.entries.map(entry => entry.artifactId).sort())
                .toEqual(declarations.map(entry => entry.artifactId).sort());
            expect(result.manifest.entries.every((entry) => (
                entry.tier === 'reactNative'
                && entry.files.length === 1
                && entry.entry.endsWith('/entry.cjs.bundle')
                && entry.builtWith.bundler === 'esbuild'
            ))).toBe(true);
            total += result.manifest.entries.length;
        }
        expect(total).toBeGreaterThan(0);
    }, 120_000);

    it.each(firstPartyVoicePlugins)('builds %s client voice activation through the same compiler', async (pluginId) => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        const projectRoot = resolve(repositoryRoot, 'packages/plugins', pluginId);
        const manifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(
            resolve(projectRoot, '.happier-plugin/plugin.json'), 'utf8',
        )));
        const voiceProviders = manifest.contributes.voiceProviders.filter(provider => provider.kind === 'conversation');
        expect(voiceProviders.length).toBeGreaterThan(0);
        const sourcePackages = ['plugin-sdk', 'protocol', 'agents', 'cli-common', 'triage-protocol'];
        // Repository test tooling is outside the SDK compilation root. Load
        // its existing resolver at the test-runner boundary, not into SDK emit.
        const { resolveWorkspacePackageSource }: {
            resolveWorkspacePackageSource: (
                specifier: string, packageName: string, sourceRoot: string,
                options: Readonly<{ exportConditions: readonly string[] }>,
            ) => string | null;
        } = await import(resolve(repositoryRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts'));
        const result = await buildUniversalPluginUiArtifacts(
            resolve(repositoryRoot, 'packages/plugins', pluginId),
            undefined,
            {
                exportConditions: ['happier-source'],
                resolveSourceImport: (specifier) => {
                    for (const packageName of sourcePackages) {
                        const source = resolveWorkspacePackageSource(
                            specifier, `@happier-dev/${packageName}`,
                            resolve(repositoryRoot, 'packages', packageName, 'src'),
                            { exportConditions: ['happier-source'] },
                        );
                        if (source) return source;
                    }
                    return undefined;
                },
            },
        );
        for (const voiceProvider of voiceProviders) {
            const artifact = result.manifest.entries.find(entry => entry.artifactId === voiceProvider.client.artifactId);
            expect(artifact).toBeDefined();
            if (!artifact) throw new Error('voice_artifact_missing');
            expect(artifact).toMatchObject({
                tier: 'reactNative',
                executable: { exports: expect.arrayContaining([voiceProvider.client.exportName]) },
            });
            const bytes = await readFile(resolve(result.artifactsRoot, artifact.entry), 'utf8');
            for (const platform of ['web', 'ios', 'android']) {
                // Evaluate the actual published CommonJS graph. Only the native
                // platform module is a host boundary; provider/SDK internals stay real.
                const module = { exports: {} as Record<string, unknown> };
                evaluatePortableCommonJs(bytes, module, (specifier) => {
                    if (specifier === 'react-native') return { Platform: { OS: platform } };
                    throw new Error(`Unexpected host dependency: ${specifier}`);
                });
                const activate = module.exports[voiceProvider.client.exportName];
                expect(activate).toBeTypeOf('function');
                if (typeof activate !== 'function') throw new Error('voice_activation_missing');
                const register = vi.fn();
                activate({ voiceProviders: { register } });
                expect(register.mock.calls).toEqual([[expect.any(String), expect.objectContaining({
                    kind: 'conversation',
                    microphoneMode: pluginId === 'elevenlabs' ? 'provider_managed' : pluginId === 'xai' ? 'host_pcm' : 'host_webrtc',
                })]]);
                if (pluginId === 'elevenlabs' && platform === 'web') {
                    // Exercise Start in the actual CommonJS graph. Only host media,
                    // browser permissions and the vendor socket are boundaries.
                    const runtime: unknown = register.mock.calls[0]?.[1];
                    if (!runtime || typeof runtime !== 'object'
                        || !('createConnection' in runtime) || typeof runtime.createConnection !== 'function') {
                        throw new Error('voice_connection_factory_missing');
                    }
                    let open: (() => Promise<void>) | undefined;
                    const vendorBoundary = Object.assign(new Error('vendor socket boundary'), {
                        code: 'voice_test_vendor_socket_boundary',
                    });
                    vi.stubGlobal('WebSocket', class { constructor() { throw vendorBoundary; } });
                    vi.stubGlobal('navigator', {
                        userAgent: 'Voice artifact web test',
                        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
                    });
                    try {
                        await Reflect.apply(runtime.createConnection, runtime, [{
                            session: { config: { agentId: 'artifact-web-agent', connectionType: 'websocket', useWakeLock: false } },
                            tools: [], execution: { kind: 'direct_media' }, interruption: { duckGain: 0.3 },
                            media: {
                                createSdkHandleConnection({ driver }: {
                                    driver: { open(input: {
                                        signal: AbortSignal; onControl(event: unknown): void;
                                        onTransport(event: unknown): void; onRemoteClose(reason: string): void;
                                    }): Promise<void> };
                                }) {
                                    open = () => driver.open({
                                        signal: new AbortController().signal,
                                        onControl() {}, onTransport() {}, onRemoteClose() {},
                                    });
                                    return { close: async () => {} };
                                },
                            },
                        }]);
                        if (!open) throw new Error('voice_media_driver_missing');
                        await expect(open()).rejects.toMatchObject({ code: vendorBoundary.code });
                    } finally {
                        vi.unstubAllGlobals();
                    }
                }
            }
        }
    }, 120_000);
});
