import { describe, expect, it } from 'vitest';

import { resolveOpenCodeLinkEnsureRequestExtras } from './resolveOpenCodeLinkEnsureRequestExtras';

describe('resolveOpenCodeLinkEnsureRequestExtras', () => {
    it('prefers a canonical runtime descriptor from candidate details', () => {
        expect(resolveOpenCodeLinkEnsureRequestExtras({
            candidate: {
                details: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'opencode',
                        provider: {
                            backendMode: 'server',
                            vendorSessionId: 'oc_1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                },
            },
        })).toEqual({
            runtimeDescriptor: {
                v: 1,
                providerId: 'opencode',
                provider: {
                    backendMode: 'server',
                    vendorSessionId: 'oc_1',
                    serverBaseUrl: 'http://127.0.0.1:4096/',
                    serverBaseUrlExplicit: true,
                    providerExtra: {
                        owner: 'opencode',
                        schemaId: 'opencode.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'server',
                            vendorSessionId: 'oc_1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                },
            },
        });
    });

    it('returns empty extras when the candidate has no descriptor', () => {
        expect(resolveOpenCodeLinkEnsureRequestExtras({
            candidate: { details: { path: '/tmp' } },
        })).toEqual({});
    });

    it('normalizes a missing backend mode to the canonical default', () => {
        expect(resolveOpenCodeLinkEnsureRequestExtras({
            candidate: {
                details: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'opencode',
                        provider: {
                            backendMode: null,
                            vendorSessionId: 'oc_2',
                        },
                    },
                },
            },
        })).toEqual({
            runtimeDescriptor: {
                v: 1,
                providerId: 'opencode',
                provider: {
                    backendMode: 'server',
                    vendorSessionId: 'oc_2',
                    providerExtra: {
                        owner: 'opencode',
                        schemaId: 'opencode.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'server',
                            vendorSessionId: 'oc_2',
                        },
                    },
                },
            },
        });
    });
});
