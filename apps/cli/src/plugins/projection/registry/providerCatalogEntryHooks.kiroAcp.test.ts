import { describe, expect, it } from 'vitest';

import { KIRO_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kiro/agent/contributions/runtime';

import { createProviderRuntimeCatalogEntryHooks } from './providerCatalogEntryHooks';

describe('Kiro ACP catalog projection', () => {
    it('projects Kiro ACP runtime from the plugin-owned spec without degrading auth or stderr rules', async () => {
        const hooks = createProviderRuntimeCatalogEntryHooks({
            agentId: 'kiro',
            packageName: '@happier-dev/plugins-kiro',
            contribution: KIRO_PROVIDER_RUNTIME_CONTRIBUTION,
        })();

        const bridge = await hooks.getAcpRuntimeDefinitionBridge?.();
        const definition = bridge?.createDefinition({
            cwd: '/workspace/kiro-project',
            env: {},
        });

        expect(definition).toMatchObject({
            backendId: 'kiro',
            source: {
                kind: 'plugin_contributed',
            },
            transport: {
                kind: 'stdio',
                launch: {
                    kind: 'agent-cli',
                    agentId: 'kiro',
                    args: ['acp'],
                },
            },
            ux: {
                name: 'kiro',
                title: 'Kiro',
            },
            auth: {
                config: {
                    support: 'login_terminal',
                    machineLoginKey: 'kiro-cli',
                    docsUrl: 'https://kiro.dev/docs/cli/acp/',
                    loginCommand: {
                        command: 'kiro-cli',
                        args: ['login'],
                    },
                    statusCommand: ['whoami', '--format', 'json'],
                    parser: 'kiroWhoamiJson',
                },
            },
            sessionIdHeaderName: 'kiroSessionId',
            stderrRules: {
                suppress: [
                    {
                        includes: ['error handling notification', '_kiro.dev/', 'method not found'],
                    },
                ],
            },
            mcp: { policy: 'pass_through' },
        });
    });
});
