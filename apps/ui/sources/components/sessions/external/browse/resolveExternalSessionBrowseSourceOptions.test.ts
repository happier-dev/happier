import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const externalSessionBrowseModulePromise = import('./resolveExternalSessionBrowseSourceOptions');

describe('resolveExternalSessionBrowseSourceOptions', () => {
    it('lists browse providers from registered provider behavior order', async () => {
        const { listExternalSessionBrowseProviderIds } = await externalSessionBrowseModulePromise;
        expect(listExternalSessionBrowseProviderIds()).toEqual(['codex', 'claude', 'ohMyPi', 'opencode']);
    });

    it('returns the codex user home and per-profile connected-service sources when codex profiles exist', async () => {
        const { resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const options = resolveExternalSessionBrowseSourceOptions({
            providerId: 'codex',
            profile: {
                connectedServicesV2: [
                    {
                        serviceId: 'openai-codex',
                        profiles: [
                            {
                                profileId: 'work',
                                status: 'connected',
                                kind: null,
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                                health: null,
                            },
                            {
                                profileId: 'personal',
                                status: 'needs_reauth',
                                kind: null,
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                                health: null,
                            },
                        ],
                        groups: [],
                    },
                ],
            },
            settings: {
                connectedServicesProfileLabelByKey: {
                    'openai-codex/work': 'Work Profile',
                },
            },
        });

        expect(options).toEqual([
            expect.objectContaining({
                key: 'codex:user',
                source: { kind: 'codexHome', home: 'user' },
            }),
            expect.objectContaining({
                key: 'codex:connected-service:openai-codex:work',
                source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' },
                detail: 'Work Profile',
            }),
            expect.objectContaining({
                key: 'codex:connected-service:openai-codex:personal',
                source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'personal' },
                detail: 'personal',
            }),
        ]);
    });

    it('returns only the default source when no codex connected-service profiles exist', async () => {
        const { resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const options = resolveExternalSessionBrowseSourceOptions({
            providerId: 'codex',
            profile: { connectedServicesV2: [] },
            settings: { connectedServicesProfileLabelByKey: {} },
        });

        expect(options).toEqual([
            expect.objectContaining({
                key: 'codex:user',
                source: { kind: 'codexHome', home: 'user' },
            }),
        ]);
    });

    it('resolves provider-owned link ensure extras through registered browse behavior', async () => {
        const { resolveExternalSessionBrowseLinkEnsureRequestExtras } = await externalSessionBrowseModulePromise;

        const extras = resolveExternalSessionBrowseLinkEnsureRequestExtras({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    codexBackendMode: 'appServer',
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            providerSessionId: 'thread-1',
                        },
                    },
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                },
            },
        });
        expect(extras.codexBackendMode).toBe('appServer');
        expect(extras.source).toEqual({ kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' });
        expect(readSessionMetadataRuntimeDescriptor({
            runtimeDescriptorV1: extras.runtimeDescriptorV1,
        }, 'codex')).toMatchObject({
            providerId: 'codex',
            backendMode: 'appServer',
            providerSessionId: 'thread-1',
            home: 'user',
            connectedServiceId: null,
            connectedServiceProfileId: null,
            homePath: '/tmp/custom-home',
        });

        expect(resolveExternalSessionBrowseLinkEnsureRequestExtras({
            providerId: 'opencode',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
            candidate: { details: { codexBackendMode: 'appServer' } },
        })).toEqual({});
    });

    it('resolves compatible link sources through registered provider behavior', async () => {
        const { resolveExternalSessionBrowseCompatibleLinkSource } = await externalSessionBrowseModulePromise;

        expect(resolveExternalSessionBrowseCompatibleLinkSource({
            providerId: 'opencode',
            selectedSource: {
                kind: 'opencodeServer',
                baseUrl: 'http://127.0.0.1:4096',
            },
            candidateSource: {
                kind: 'opencodeServer',
                baseUrl: 'http://127.0.0.1:5000',
                directory: '/tmp/other',
            },
        })).toEqual({
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:4096',
        });

        expect(resolveExternalSessionBrowseCompatibleLinkSource({
            providerId: 'opencode',
            selectedSource: {
                kind: 'opencodeServer',
                baseUrl: 4096,
                directory: { path: '/tmp/repo' },
            },
            candidateSource: {
                kind: 'opencodeServer',
                baseUrl: 'http://127.0.0.1:4096',
                directory: '/tmp/repo',
            },
        })).toEqual({
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:4096',
            directory: '/tmp/repo',
        });
    });

});
