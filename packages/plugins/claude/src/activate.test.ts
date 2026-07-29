import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { claudeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { claudeExternalSessionHooksContribution } from './agent/surfaces/sessions/external/hooks.js';
import { claudeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { claudeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';

describe('activate', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('registers the Claude config MCP discovery provider through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-'));
        const configRoot = join(root, '.claude');
        await mkdir(configRoot, { recursive: true });
        await writeFile(
            join(configRoot, 'settings.json'),
            JSON.stringify({
                mcpServers: {
                    review: {
                        command: 'review-mcp',
                        args: ['--stdio'],
                    },
                },
            }),
            'utf8',
        );
        vi.stubEnv('HOME', root);
        vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot);

        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        const agent = activation.registration('agents', 'claude');

        expect(agent).toEqual(expect.objectContaining({
            factory: expect.any(Function),
            providerBinding: CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
            externalSessions: claudeExternalSessionsContribution,
            externalSessionTakeover: claudeExternalSessionTakeoverContribution,
            externalSessionObservation: claudeExternalSessionObservationContribution,
            externalSessionHooks: claudeExternalSessionHooksContribution,
        }));
        expect(Object.keys(
            agent?.externalSessions ?? {},
        ).sort()).toEqual([
            'listCandidates',
            'pageTranscript',
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
            { family: 'mcp.discoveryProviders', localId: 'config' },
            { family: 'hooks', localId: 'resolve-prerequisites' },
            { family: 'hooks', localId: 'augment-spawn-env' },
        ]));

        const discovery = activation.registration('mcp.discoveryProviders', 'config');
        if (!discovery) throw new Error('Missing Claude MCP discovery registration');
        await expect(Reflect.apply(discovery, undefined, [{}])).resolves.toEqual({
            items: [],
            servers: [
                expect.objectContaining({
                    id: 'claude.config.review',
                    name: 'review',
                    transport: {
                        kind: 'stdio',
                        launch: {
                            kind: 'binary',
                            executablePath: 'review-mcp',
                            args: ['--stdio'],
                        },
                    },
                }),
            ],
            warnings: [],
        });
        await activation.dispose();
    });

    it('propagates Claude MCP discovery warnings through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-warning-'));
        const configRoot = join(root, '.claude');
        await mkdir(configRoot, { recursive: true });
        const settingsPath = join(configRoot, 'settings.json');
        await writeFile(settingsPath, '{', 'utf8');
        vi.stubEnv('HOME', root);
        vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot);

        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

        const discovery = activation.registration('mcp.discoveryProviders', 'config');
        if (!discovery) throw new Error('Missing Claude MCP discovery registration');

        await expect(Reflect.apply(discovery, undefined, [{}])).resolves.toEqual({
            items: [],
            servers: [],
            warnings: [{
                provider: 'claude',
                code: 'parse_failed',
                path: settingsPath,
            }],
        });
        await activation.dispose();
    });

    it('passes direct activation-hook payloads through to Claude spawn env augmentation', async () => {
        const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

        const envHook = activation.registration('hooks', 'augment-spawn-env');

        await expect(Promise.resolve(envHook?.({
            env: {
                HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/claude-direct',
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
        expect(runtime.executionRuns?.open).toBeTypeOf('function');
        await activation.dispose();
    });

    it('declares exact qualified subscription and API-key purposes for the Claude Agent', () => {
        expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([
            {
                purpose: 'model_upstream',
                service: 'claude-subscription',
                required: false,
                materializationKinds: ['environment', 'files'],
            },
            {
                purpose: 'model_upstream_api_key',
                service: 'anthropic',
                required: false,
                materializationKinds: ['environment'],
            },
        ]);
    });
});
