import { definePlugin } from '@happier-dev/plugin-sdk';

import { createDeterministicSessionAgentRuntime } from './agent/deterministicSessionAgent.js';

export const { manifest, activate } = definePlugin({
    id: 'examples.session-agent',
    version: '0.1.0',
    displayName: 'Deterministic Session Agent',
    entrypoints: { daemon: './dist/index.js' },
    agents: {
        'session-agent': {
            declaration: {
                title: 'Deterministic Session Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            },
            factory: createDeterministicSessionAgentRuntime,
            sessionRunnerFactory: {
                module: './agent/deterministicSessionAgent.js',
                export: 'createDeterministicSessionAgentRuntime',
                runtimeApiVersion: 1,
            },
        },
    },
});
