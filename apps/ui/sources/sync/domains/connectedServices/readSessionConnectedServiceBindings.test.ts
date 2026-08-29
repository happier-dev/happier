import { beforeEach, describe, expect, it } from 'vitest';
import {
    createConnectedAccountDescriptorProjectionLoadingState,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { readSessionConnectedServiceBindings } from './readSessionConnectedServiceBindings';

const CLAUDE_SERVICE_KEY = 'happier.agent.claude/anthropic';

const readerProjection = {
    scopeKey: 'reader-test',
    status: 'ready' as const,
    descriptors: [],
    conflicts: [],
    errorReason: null,
} satisfies ConnectedAccountDescriptorProjectionState;

describe('readSessionConnectedServiceBindings', () => {
    beforeEach(() => {
        installConnectedAccountDescriptorProjection(readerProjection);
    });

    it('reads the current qualified writer shape verbatim', () => {
        expect(readSessionConnectedServiceBindings({
            metadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            },
            agentId: 'claude',
        })).toEqual({
            v: 1,
            bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
    });

    it('maps released bundled scalar bindings through the provenance-named legacy ingress', () => {
        // Persisted legacy session metadata carries the bare built-in service id.
        // The reader surfaces it under the canonical qualified key for display,
        // while canonical writers keep producing qualified keys.
        expect(readSessionConnectedServiceBindings({
            metadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            },
            agentId: 'claude',
        })).toEqual({
            v: 1,
            bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
    });

    it('rejects unknown bare service ids instead of inventing an owner (fail closed)', () => {
        expect(readSessionConnectedServiceBindings({
            metadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'totally-unknown-service': { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            },
            agentId: 'claude',
        })).toBeNull();
    });

    it('keeps an explicitly empty binding set and never consults the descriptor fallback for it', () => {
        expect(readSessionConnectedServiceBindings({
            metadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {},
                },
                agentRuntimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                },
            },
            agentId: 'codex',
        })).toEqual({ v: 1, bindingsByServiceId: {} });
    });

    it('normalizes the bounded descriptor fallback for older sessions to qualified keys', () => {
        // Released sessions recorded the connected service in the flat provider
        // descriptor with a scalar id; the reader projects it qualified.
        expect(readSessionConnectedServiceBindings({
            metadata: {
                agentRuntimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceProfileId: 'happier',
                    },
                },
            },
            agentId: 'codex',
        })).toEqual({
            v: 1,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
            },
        });
    });

    it('never reconstructs host bindings from a current Agent-owned descriptor', () => {
        expect(readSessionConnectedServiceBindings({
            metadata: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: {
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceProfileId: 'current',
                    },
                },
                agentRuntimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceProfileId: 'retired',
                    },
                },
            },
            agentId: 'codex',
        })).toBeNull();
    });
});
