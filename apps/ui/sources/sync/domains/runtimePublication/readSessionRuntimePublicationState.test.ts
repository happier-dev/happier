import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';

import { readSessionRuntimePublicationState } from './readSessionRuntimePublicationState';

describe('readSessionRuntimePublicationState', () => {
    it('prefers runtimeDescriptorV1 over legacy agentRuntimeDescriptorV1 metadata', () => {
        expect(readSessionRuntimePublicationState({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                },
            },
            agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'acp',
                },
            },
        })).toEqual({
            descriptor: {
                v: 1,
                agentId: 'codex',
                provider: {
                    backendMode: 'appServer',
                },
            },
            capabilities: null,
            facets: null,
        });
    });

    it('normalizes descriptor, capabilities, and facets from session metadata together', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/runtime-publication',
            host: 'localhost',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'acme.provider',
                provider: {
                    backendMode: 'native',
                },
            },
            agentRuntimeCapabilitiesV1: {
                executionRun: {
                    supported: true,
                },
            },
            agentRuntimeFacetsV1: {
                v: 1,
                transcriptSource: {
                    supported: true,
                    followLeaseSupported: true,
                },
            },
        } as any);

        expect(readSessionRuntimePublicationState(metadata)).toEqual({
            descriptor: {
                v: 1,
                agentId: 'acme.provider',
                provider: {
                    backendMode: 'native',
                },
            },
            capabilities: {
                executionRun: {
                    supported: true,
                },
            },
            facets: {
                v: 1,
                transcriptSource: {
                    supported: true,
                    followLeaseSupported: true,
                },
            },
        });
    });

    it('fails closed on invalid runtime facets while preserving other runtime publication state', () => {
        expect(readSessionRuntimePublicationState({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'acme.provider',
                provider: {
                    backendMode: 'native',
                },
            },
            agentRuntimeCapabilitiesV1: {
                executionRun: {
                    supported: true,
                },
            },
            agentRuntimeFacetsV1: {
                v: 1,
                transcriptSource: {
                    supported: false,
                },
            },
        })).toEqual({
            descriptor: {
                v: 1,
                agentId: 'acme.provider',
                provider: {
                    backendMode: 'native',
                },
            },
            capabilities: {
                executionRun: {
                    supported: true,
                },
            },
            facets: null,
        });
    });
});
