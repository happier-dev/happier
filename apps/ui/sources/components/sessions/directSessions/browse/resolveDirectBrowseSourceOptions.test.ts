import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const directBrowseModulePromise = import('./resolveDirectBrowseSourceOptions');

describe('resolveDirectBrowseSourceOptions', () => {
    it('lists browse providers from registered provider behavior order', async () => {
        const { listDirectBrowseProviderIds } = await directBrowseModulePromise;
        expect(listDirectBrowseProviderIds()).toEqual(['codex', 'claude', 'opencode']);
    });

    it('returns the codex user home and per-profile connected-service sources when codex profiles exist', async () => {
        const { resolveDirectBrowseSourceOptions } = await directBrowseModulePromise;
        const options = resolveDirectBrowseSourceOptions({
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
                            },
                            {
                                profileId: 'personal',
                                status: 'needs_reauth',
                                kind: null,
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                            },
                        ],
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
        const { resolveDirectBrowseSourceOptions } = await directBrowseModulePromise;
        const options = resolveDirectBrowseSourceOptions({
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
        const { resolveDirectBrowseLinkEnsureRequestExtras } = await directBrowseModulePromise;

        const extras = resolveDirectBrowseLinkEnsureRequestExtras({
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
                            vendorSessionId: 'thread-1',
                        },
                    },
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                },
            },
        });
        expect(extras.codexBackendMode).toBe('appServer');
        expect(extras.source).toEqual({ kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' });
        expect(readSessionMetadataRuntimeDescriptor({
            agentRuntimeDescriptorV1: extras.runtimeDescriptor,
        }, 'codex')).toEqual({
            providerId: 'codex',
            backendMode: 'appServer',
            vendorSessionId: 'thread-1',
            home: 'user',
            connectedServiceId: null,
            connectedServiceProfileId: null,
            homePath: '/tmp/custom-home',
        });

        expect(resolveDirectBrowseLinkEnsureRequestExtras({
            providerId: 'opencode',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
            candidate: { details: { codexBackendMode: 'appServer' } },
        })).toEqual({});
    });
});
