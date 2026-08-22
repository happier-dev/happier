import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    createReviewAgentRuntime,
    externalSessions,
} from './agent/reviewAgent.js';
import { refreshCatalogInBackground } from './background/refreshCatalog.js';
import { managedGatewayRuntime } from './provider/managedGateway.js';

export const { manifest, activate } = definePlugin({
    id: 'examples.advanced-package-root',
    version: '0.1.0',
    displayName: 'Advanced package-root reference',
    // `happier plugins pack` stages the daemon runtime for a code-defined
    // plugin at the declared daemon entrypoint, so the README's
    // `happier plugins test . --packed` requires it.
    entrypoints: { daemon: './dist/index.js' },
    actions: {
        summarize: {
            title: 'Summarize',
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { text: { type: 'string' } },
            },
            resultSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { summary: { type: 'string' } },
                required: ['summary'],
            },
            async run() {
                return { summary: 'Summary ready.' };
            },
        },
    },
    resources: {
        'review-guide': {
            source: 'packaged',
            kind: 'template',
            path: 'resources/review-guide.md',
            contentType: 'text/markdown',
        },
    },
    agents: {
        reviewer: {
            declaration: {
                title: 'Review Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                    surfaces: ['externalSessions'],
                },
                connectedAccounts: [{
                    purpose: 'review-api',
                    service: {
                        pluginId: 'example.accounts',
                        localId: 'review-api',
                    },
                    materializationKinds: ['httpHeaders'],
                }],
                surfaces: {
                    externalSession: {
                        sources: [{
                            sourceKind: 'example-review',
                            schema: {
                                fields: [{
                                    name: 'kind',
                                    kind: 'literal',
                                    value: 'example-review',
                                }],
                            },
                            key: {
                                segments: [{ kind: 'literal', value: 'example-review' }],
                            },
                        }],
                    },
                },
            },
            factory: createReviewAgentRuntime,
            sessionRunnerFactory: {
                module: './agent/reviewAgent.js',
                export: 'createReviewAgentRuntime',
                runtimeApiVersion: 1,
                externalSessionsExport: 'externalSessions',
            },
            externalSessions,
        },
    },
    providers: {
        gateway: {
            declaration: {
                v: 1,
                name: 'Example managed gateway',
                kind: 'aggregator',
                endpointTemplates: [{
                    id: 'responses',
                    protocol: 'openai-responses',
                    baseUrl: 'http://127.0.0.1:3210/v1',
                    capabilities: {
                        streaming: 'supported',
                        toolRoundTrips: 'unknown',
                        statefulResponses: 'unknown',
                        reasoningControls: 'unknown',
                    },
                }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                managedRuntime: {
                    kind: 'managed',
                    endpointTemplateIds: ['responses'],
                },
            },
            runtime: managedGatewayRuntime,
        },
    },
    backgroundServices: [{
        declaration: { id: 'catalog-refresh', title: 'Refresh the example catalog' },
        runner: refreshCatalogInBackground,
    }],
});
