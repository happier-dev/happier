import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { claudeExternalSessionHooksContribution } from './agent/surfaces/sessions/external/hooks.js';

type Activation = Awaited<ReturnType<typeof createPluginTestkit>>;

async function discoverClaudeConfig(activation: Activation, home: string, configRoot: string) {
    const discovery = activation.registration('mcp.discoverySources', 'config');
    if (!discovery) throw new Error('Missing Claude MCP discovery registration');
    const env: Record<string, string> = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configRoot };
    return await discovery({ directory: null }, {
        services: { exec: { readEnvironment: (keys: readonly string[]) => Object.fromEntries(
            keys.filter(key => Object.hasOwn(env, key)).map(key => [key, env[key]]),
        ) } },
    } as unknown as Parameters<typeof discovery>[1]);
}

describe('activate', () => {
    const roots: string[] = [];
    it('reexports the activation compiled by its canonical public plugin definition', async () => {
        expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
            'actions',
            'agents',
            'connectedAccountDescriptors',
            'hooks',
            'mcp',
            'providers',
            'resources',
            'settings',
            'systemTools',
            'ui',
        ]);
        expect(await import('./manifest.js')).toEqual(expect.objectContaining({
            CLAUDE_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
        }));
    });

    afterEach(async () => {
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });

    it('builds Claude Session preferences through the public CLI command declaration', async () => {
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        try {
            const buildSessionOptions = activation.registration('agents', 'claude')?.cliSessionCommand?.buildSessionOptions;
            expect(buildSessionOptions).toBeTypeOf('function');
            expect(await buildSessionOptions?.({
                isExplicitCliSubcommand: true,
                parsed: { agentArgs: [] },
                settings: { claudeUnifiedTerminalResumeChoice: 'wrong-global-value' },
                pluginSettings: { account: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' } },
                environment: {},
                startOrigin: 'terminal',
            })).toEqual({
                ok: true,
                options: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' },
            });
        } finally {
            await activation.dispose();
        }
    });

    it('registers the Claude config MCP discovery source through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-'));
        roots.push(root);
        const configRoot = join(root, '.claude');
        const configPath = join(configRoot, '.claude.json');
        await mkdir(configRoot, { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                mcpServers: {
                    review: {
                        command: 'review-mcp',
                        args: ['--stdio'],
                    },
                    docs: {
                        type: 'http',
                        url: 'https://mcp.example.test/docs',
                    },
                },
            }),
            'utf8',
        );
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        const agent = activation.registration('agents', 'claude');

        expect(agent).toEqual(expect.objectContaining({
            factory: expect.any(Function),
            providerBinding: {
                v: 1,
                adapterVersion: CLAUDE_PROVIDER_BINDING_ADAPTER_V1.adapterVersion,
                modelRoles: expect.arrayContaining([
                    { id: 'fast', title: expect.any(String) },
                    { id: 'default', title: expect.any(String) },
                    { id: 'strongest', title: expect.any(String) },
                ]),
                prepare: expect.any(Function),
                materialize: expect.any(Function),
            },
            externalSessions: expect.objectContaining({
                resolveSource: expect.any(Function),
                listCandidates: expect.any(Function),
                resolveLinkIdentity: expect.any(Function),
                resolveLinkedIdentity: expect.any(Function),
                pageTranscript: expect.any(Function),
                readAfterTranscript: expect.any(Function),
                readAccounting: expect.any(Function),
                materializeTranscriptMedia: expect.any(Function),
            }),
            externalSessionTakeover: { resolveLaunch: expect.any(Function) },
            externalSessionObservation: {
                describeResource: expect.any(Function),
                observeResource: expect.any(Function),
                reconcileResource: expect.any(Function),
            },
            externalSessionHooks: {
                installationVariants: claudeExternalSessionHooksContribution.installationVariants,
                resolveInstallation: expect.any(Function),
                mapHookEvent: expect.any(Function),
            },
        }));
        const prepareInput = {
            v: 1 as const,
            agentTargetKey: 'backend:claude:built_in',
            connectionId: 'pc_claude_activation_test',
        };
        expect(agent?.providerBinding?.prepare(prepareInput)).toEqual(
            CLAUDE_PROVIDER_BINDING_ADAPTER_V1.prepare(prepareInput),
        );
        expect(Object.keys(
            agent?.externalSessions ?? {},
        ).sort()).toEqual([
            'listCandidates',
            'materializeTranscriptMedia',
            'pageTranscript',
            'readAccounting',
            'readAfterTranscript',
            'resolveLinkIdentity',
            'resolveLinkedIdentity',
            'resolveSource',
        ]);
        expect(Object.keys(
            agent?.externalSessionObservation ?? {},
        ).sort()).toEqual([
            'describeResource',
            'observeResource',
            'reconcileResource',
        ]);
        expect(Object.keys(
            agent?.externalSessionHooks ?? {},
        ).sort()).toEqual([
            'installationVariants',
            'mapHookEvent',
            'resolveInstallation',
        ]);
        expect(activation.registrations()).toEqual(expect.arrayContaining([
            { family: 'mcp.discoverySources', localId: 'config' },
            { family: 'hooks', localId: 'resolve-prerequisites' },
            { family: 'hooks', localId: 'augment-spawn-env' },
        ]));

        await expect(discoverClaudeConfig(activation, root, configRoot)).resolves.toEqual({
            items: [],
            detectedServers: [
                expect.objectContaining({
                    name: 'review',
                    transport: 'stdio',
                    stdio: { command: 'review-mcp', args: ['--stdio'] },
                    source: { kind: 'user', path: configPath },
                }),
                expect.objectContaining({
                    name: 'docs',
                    transport: 'http',
                    remote: { url: 'https://mcp.example.test/docs', headers: [] },
                    source: { kind: 'user', path: configPath },
                }),
            ],
            warnings: [],
        });
        await activation.dispose();
    });

    it('propagates Claude MCP discovery warnings through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-warning-'));
        roots.push(root);
        const configRoot = join(root, '.claude');
        await mkdir(configRoot, { recursive: true });
        const configPath = join(configRoot, '.claude.json');
        await writeFile(configPath, '{', 'utf8');

        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

        await expect(discoverClaudeConfig(activation, root, configRoot)).resolves.toEqual({
            items: [],
            detectedServers: [],
            warnings: [{
                provider: 'claude',
                code: 'parse_failed',
                path: configPath,
            }],
        });
        await activation.dispose();
    });

    it('passes the runtime selection through to Claude spawn env augmentation', async () => {
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

        const envHook = activation.registration('hooks', 'augment-spawn-env');

        await expect(Promise.resolve(envHook?.({
            runtimeSelection: {
                env: { HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/claude-direct' },
            },
        }))).resolves.toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-direct',
        });
        await activation.dispose();
    });
    it('registers a native AgentRuntime rather than the V1 compatibility carrier', async () => {
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

        const factory = activation.registration('agents', 'claude')?.factory;
        if (!factory) throw new Error('Missing Claude Agent registration');
        const runtime = await factory({
            plugin: { id: 'happier.agent.claude', version: '0.0.0' },
            agent: { id: 'claude' },
            signal: new AbortController().signal,
        });

        expect(runtime.sessions?.open).toBeTypeOf('function');
        expect(runtime.executionRuns).toBeUndefined();
        await activation.dispose();
    });

    it('declares qualified Claude, Anthropic and Kimi connected-account purposes', () => {
        expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([
            {
                purpose: 'model_upstream',
                service: 'claude-subscription',
                required: false,
                materializationKinds: ['environment', 'files', 'httpHeaders'],
                credentialKinds: ['oauth', 'token'],
            },
            {
                purpose: 'model_upstream_api_key',
                service: 'anthropic',
                required: false,
                materializationKinds: ['environment'],
                credentialKinds: ['token'],
            },
            {
                purpose: 'kimi-code-api-key',
                service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' },
                materializationKinds: ['environment'],
                credentialKinds: ['token'],
            },
        ]);
    });

    it('captures only pre-open connected-account launch facts through Agent activation', async () => {
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        try {
            const launch = activation.registration('agents', 'claude')?.connectedAccountLaunch;

            expect(launch).toMatchObject({
                requestAuthUses: [{
                    purpose: 'model_upstream',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.anthropic.com',
                        headerNames: ['authorization'],
                    },
                }],
                environmentUses: [{
                    purpose: 'kimi-code-api-key',
                    environmentKey: 'KIMI_API_KEY',
                }, {
                    purpose: 'kimi-code-api-key',
                    environmentKey: 'KIMI_CODE_ANTHROPIC_BASE_URL',
                }, {
                    purpose: 'model_upstream_api_key',
                    environmentKey: 'ANTHROPIC_API_KEY',
                }],
                stateSharingDescriptor: {
                    nativeHome: {
                        environmentKey: 'CLAUDE_CONFIG_DIR',
                        defaultRelativePath: '.claude',
                    },
                    providerSupportStatus: 'supported',
                    config: {
                        supported: true,
                        modes: ['linked', 'copied', 'isolated'],
                        entries: [
                            { path: 'CLAUDE.md', mode: 'linked_or_copied' },
                            { path: 'settings.json', mode: 'linked_or_copied' },
                            { path: 'settings.local.json', mode: 'linked_or_copied' },
                            { path: 'agents', mode: 'linked_or_copied' },
                            { path: 'commands', mode: 'linked_or_copied' },
                            { path: 'hooks', mode: 'linked_or_copied' },
                            { path: 'plugins', mode: 'linked_or_copied' },
                            { path: 'rules', mode: 'linked_or_copied' },
                            { path: 'skills', mode: 'linked_or_copied' },
                        ],
                    },
                    state: {
                        supported: true,
                        modes: ['isolated', 'shared'],
                        entries: [{ path: 'projects', mode: 'linked' }],
                        sharedStatePrivacyRiskAcknowledgementRequired: true,
                        symlinkUnavailableDegradePolicy: 'block_continuity',
                    },
                    authIsolation: {
                        mode: 'materialized_home',
                        secretEntries: [
                            'CLAUDE_CODE_OAUTH_TOKEN',
                            'CLAUDE_CODE_SETUP_TOKEN',
                            'CLAUDE_API_KEY',
                            'ANTHROPIC_API_KEY',
                            '.claude.json',
                            '.credentials.json',
                            '.happier-claude-connected-service-home.json',
                            'credentials.json',
                            'auth.json',
                            'accounts',
                        ],
                    },
                },
            });
            expect(launch?.continuity?.runtimeAuthAdapter).toEqual(expect.objectContaining({
                classifyRuntimeAuthFailure: expect.any(Function),
                materializeActiveProfile: expect.any(Function),
                canHotApply: expect.any(Function),
                hotApply: expect.any(Function),
                probeQuota: expect.any(Function),
            }));
            const verifyResumeReachable = launch?.continuity?.verifyResumeReachable;
            expect(verifyResumeReachable).toBeTypeOf('function');
            if (!verifyResumeReachable) throw new Error('Missing Claude resume reachability verifier');
            await expect(verifyResumeReachable({
                vendorResumeId: 'claude-session-exact',
                sessionFiles: {
                    verifyDeclaredPaths: async () => ({ found: false }),
                    findDeclaredCandidate: async ({ matchesCandidate }) => ({
                        found: matchesCandidate({
                            fileName: 'claude-session-exact.jsonl',
                            nativeSessionId: 'claude-session-exact',
                        }),
                    }),
                },
            })).resolves.toEqual({ ok: true });
            expect(launch).not.toHaveProperty('serviceIds');
            expect(launch?.stateSharingDescriptor).not.toHaveProperty('providerId');
        } finally {
            await activation.dispose();
        }
    });
});
