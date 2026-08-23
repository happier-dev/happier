import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import {
    PluginProjectionV2Schema,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const externalSessionBrowseModulePromise = import('./resolveExternalSessionBrowseSourceOptions');

const CODEX_SOURCE_DECLARATION = {
    sourceKind: 'codexHome',
    schema: {
        fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'homePath', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
        ],
        refinements: [
            { kind: 'requiresWhenEquals', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
            { kind: 'forbidsWhenEquals', fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'], when: { field: 'home', equals: 'user' } },
        ],
    },
    key: {
        segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
            { kind: 'conditionalField', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
            { kind: 'connectedServiceScope', groupField: 'connectedServiceGroupId', profileField: 'connectedServiceProfileId', when: { field: 'home', equals: 'connectedService' } },
            { kind: 'field', field: 'homePath' },
        ],
    },
    instances: [
        { kind: 'default', constants: { home: 'user' } },
        {
            kind: 'connectedServiceProfiles',
            serviceId: 'openai-codex',
            constants: { home: 'connectedService' },
            fields: {
                serviceId: 'connectedServiceId',
                profileId: 'connectedServiceProfileId',
            },
        },
    ],
} as const;

function createProjection(agentIds: readonly string[]): PluginProjectionV2 {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 17,
        installedPackagesById: {
            'happier.external-sessions-fixture': {
                id: 'happier.external-sessions-fixture',
                displayName: 'External sessions fixture',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.external-sessions-fixture' },
            },
        },
        agentsById: Object.fromEntries(agentIds.map((agentId) => [
            agentId,
            {
                id: agentId,
                title: agentId,
                externalSessions: {
                    agent: {
                        pluginId: 'happier.external-sessions-fixture',
                        localId: agentId.toLowerCase(),
                    },
                    generation: 17,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: agentId === 'codex'
                        ? [CODEX_SOURCE_DECLARATION]
                        : [{
                            sourceKind: `${agentId}Archive`,
                            schema: {
                                fields: [{ name: 'kind', kind: 'literal', value: `${agentId}Archive` }],
                            },
                            key: { segments: [{ kind: 'literal', value: `${agentId}Archive` }] },
                            instances: [{ kind: 'default', constants: {} }],
                        }],
                },
            },
        ])),
    });
}

function createOpenCodeProjection(): PluginProjectionV2 {
    const contribution = (OPENCODE_PLUGIN_MANIFEST.contributes.agents ?? []).find(
        (candidate) => candidate.id === 'opencode',
    ) as (NonNullable<typeof OPENCODE_PLUGIN_MANIFEST.contributes.agents>[number] & Readonly<{
        surfaces?: Readonly<{
            externalSession?: Readonly<{
                sources?: NonNullable<
                    PluginProjectionV2['agentsById'][string]['externalSessions']
                >['sources'];
            }>;
        }>;
    }>) | undefined;
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 21,
        installedPackagesById: {
            'happier.agent.opencode': {
                id: 'happier.agent.opencode',
                displayName: 'OpenCode',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.opencode' },
            },
        },
        agentsById: {
            opencode: {
                id: 'opencode',
                title: 'OpenCode',
                externalSessions: {
                    agent: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
                    generation: 21,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: contribution?.surfaces?.externalSession?.sources ?? [],
                },
            },
        },
    });
}

describe('resolveExternalSessionBrowseSourceOptions', () => {
    it('admits background follow for a currently declared source and refuses an undeclared or unparsable one', async () => {
        const { supportsExternalSessionBackgroundFollow } = await externalSessionBrowseModulePromise;
        const projection = createProjection(['codex']);

        // Observation-backed background follow depends on the linked source
        // still being declared by the current Agent generation. It does NOT
        // depend on `terminalFollow.userRowClassification`, which gates native
        // terminal-mode transcript projection and writes no rows here.
        expect(supportsExternalSessionBackgroundFollow({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            projection,
        })).toBe(true);

        // A source kind the current projection does not declare stays refused.
        expect(supportsExternalSessionBackgroundFollow({
            providerId: 'codex',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' } as never,
            projection,
        })).toBe(false);

        // A declared kind whose payload violates the declaration stays refused:
        // `home: 'connectedService'` requires `connectedServiceId`.
        expect(supportsExternalSessionBackgroundFollow({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'connectedService' } as never,
            projection,
        })).toBe(false);

        // A retired Agent generation stays refused.
        const staleProjection = PluginProjectionV2Schema.parse({
            ...projection,
            generation: projection.generation + 1,
        });
        expect(supportsExternalSessionBackgroundFollow({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            projection: staleProjection,
        })).toBe(false);
    });

    it('resolves a non-bundled auxiliary-only Agent from the daemon projection without static Agent catalog membership', async () => {
        const { listExternalSessionBrowseProviderIds, resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 17,
            installedPackagesById: {
                'acme.external-sessions-ui': {
                    id: 'acme.external-sessions-ui',
                    displayName: 'External Sessions UI fixture',
                    version: '1.0.0',
                    enabled: true,
                    source: { kind: 'path', locator: '/plugins/acme-external-sessions-ui' },
                },
            },
            agentsById: {
                'acme-auxiliary-agent': {
                    id: 'acme-auxiliary-agent',
                    title: 'Synthetic External Agent',
                    channel: 'plugin',
                    isBuiltIn: false,
                    providerOwnedEnvironmentKeys: [],
                    externalSessions: {
                        agent: {
                            pluginId: 'acme.external-sessions-ui',
                            localId: 'acme-auxiliary-agent',
                        },
                        generation: 17,
                        operations: {
                            listCandidates: true,
                            resolveLinkIdentity: true,
                            pageTranscript: true,
                            readAfterTranscript: true,
                        },
                        sources: [{
                            sourceKind: 'syntheticArchive',
                            schema: {
                                fields: [{ name: 'kind', kind: 'literal', value: 'syntheticArchive' }],
                            },
                            key: { segments: [{ kind: 'literal', value: 'syntheticArchive' }] },
                            instances: [{ kind: 'default', constants: {} }],
                        }],
                    },
                },
            },
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        });

        expect(listExternalSessionBrowseProviderIds({ projection }))
            .toEqual(['acme-auxiliary-agent']);
        expect(resolveExternalSessionBrowseSourceOptions({
            providerId: 'acme-auxiliary-agent',
            profile: null,
            settings: { connectedServicesProfileLabelByKey: {} },
            projection,
        })).toEqual([{
            key: 'acme-auxiliary-agent:syntheticArchive',
            label: 'Synthetic External Agent',
            source: { kind: 'syntheticArchive' },
        }]);
    });

    it('lists browse providers from registered provider behavior order', async () => {
        const { listExternalSessionBrowseProviderIds } = await externalSessionBrowseModulePromise;
        const projection = createProjection(['antigravity', 'claude', 'codex', 'ohMyPi', 'opencode', 'pi']);
        expect(listExternalSessionBrowseProviderIds({ projection }))
            .toEqual(['codex', 'claude', 'ohMyPi', 'opencode', 'antigravity', 'pi']);
    });

    it('fails closed for stale, uninstalled, mismatched, or unavailable projected browse descriptors', async () => {
        const { listExternalSessionBrowseProviderIds } = await externalSessionBrowseModulePromise;
        const valid = createProjection(['pi']);
        const pi = valid.agentsById.pi!;
        const externalSessions = pi.externalSessions!;
        const invalidProjections: PluginProjectionV2[] = [
            {
                ...valid,
                agentsById: {
                    pi: {
                        ...pi,
                        externalSessions: { ...externalSessions, generation: valid.generation + 1 },
                    },
                },
            },
            { ...valid, installedPackagesById: {} },
            {
                ...valid,
                agentsById: {
                    pi: {
                        ...pi,
                        id: 'other-agent',
                    },
                },
            },
            {
                ...valid,
                agentsById: {
                    pi: {
                        ...pi,
                        externalSessions: undefined,
                    },
                },
            },
            {
                ...valid,
                agentsById: {
                    pi: {
                        ...pi,
                        externalSessions: {
                            ...externalSessions,
                            operations: {
                                ...externalSessions.operations,
                                listCandidates: false,
                            },
                        },
                    },
                },
            },
            {
                ...valid,
                agentsById: {
                    pi: {
                        ...pi,
                        externalSessions: {
                            ...externalSessions,
                            operations: {
                                ...externalSessions.operations,
                                resolveLinkIdentity: false,
                            },
                        },
                    },
                },
            },
        ];

        for (const projection of invalidProjections) {
            expect(listExternalSessionBrowseProviderIds({ projection })).toEqual([]);
        }
    });

    it('uses the canonical built-in catalog title when the daemon projection omits a redundant title', async () => {
        const { resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const projection = createProjection(['pi']);
        projection.agentsById.pi = {
            ...projection.agentsById.pi!,
            title: undefined,
        };

        expect(resolveExternalSessionBrowseSourceOptions({
            providerId: 'pi',
            profile: null,
            settings: { connectedServicesProfileLabelByKey: {} },
            projection,
        })[0]?.label).toBe('agentInput.agent.pi');
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
            projection: createProjection(['codex']),
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
        ]);
    });

    it('returns only the default source when no codex connected-service profiles exist', async () => {
        const { resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const options = resolveExternalSessionBrowseSourceOptions({
            providerId: 'codex',
            profile: { connectedServicesV2: [] },
            settings: { connectedServicesProfileLabelByKey: {} },
            projection: createProjection(['codex']),
        });

        expect(options).toEqual([
            expect.objectContaining({
                key: 'codex:user',
                source: { kind: 'codexHome', home: 'user' },
            }),
        ]);
    });

    it('replaces the OpenCode managed default with the attach source bound to the active server setting', async () => {
        const { resolveExternalSessionBrowseSourceOptions } = await externalSessionBrowseModulePromise;
        const projection = createOpenCodeProjection();
        const resolve = (settings: Readonly<Record<string, unknown>>) => resolveExternalSessionBrowseSourceOptions({
            providerId: 'opencode',
            profile: null,
            settings: { connectedServicesProfileLabelByKey: {}, ...settings },
            projection,
            activeServerId: 'cloud',
        });

        const managedDefault = { key: 'opencode:default', source: { kind: 'opencodeServer' } };

        expect(resolve({})).toEqual([expect.objectContaining(managedDefault)]);
        // `agentSettingOverride` is an override, not an addition: an admitted
        // operator-configured server REPLACES the managed default so the user is
        // never offered two competing OpenCode endpoints for one server.
        expect(resolve({
            opencodeServerBaseUrl: 'http://127.0.0.1:9999',
            opencodeServerBaseUrlByServerIdV1: { cloud: 'http://127.0.0.1:4096' },
        })).toEqual([
            expect.objectContaining({
                key: 'opencode:opencodeServer:setting:opencodeServerBaseUrl',
                source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
                detail: 'http://127.0.0.1:4096/',
            }),
        ]);
        // A server the user runs off this machine is a browsable source when it is
        // reached over TLS.
        expect(resolve({
            opencodeServerBaseUrlByServerIdV1: { cloud: 'https://10.0.0.7:4096' },
        })).toEqual([
            expect.objectContaining({
                key: 'opencode:opencodeServer:setting:opencodeServerBaseUrl',
                source: { kind: 'opencodeServer', baseUrl: 'https://10.0.0.7:4096/' },
                detail: 'https://10.0.0.7:4096/',
            }),
        ]);
        // Plaintext `http:` off loopback is refused by the canonical endpoint rule, so
        // the override never materializes and the managed default stands.
        expect(resolve({
            opencodeServerBaseUrlByServerIdV1: { cloud: 'http://10.0.0.7:4096' },
        })).toEqual([expect.objectContaining(managedDefault)]);
        expect(resolve({ opencodeServerBaseUrl: 'nonsense' })).toEqual([
            expect.objectContaining(managedDefault),
        ]);
        expect(resolve({
            opencodeServerBaseUrlByServerIdV1: { cloud: 'https://opencode:secret@example.com' },
        })).toEqual([expect.objectContaining(managedDefault)]);
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
                        agentId: 'codex',
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
            agentId: 'codex',
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

        expect(resolveExternalSessionBrowseCompatibleLinkSource({
            providerId: 'codex',
            selectedSource: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'member-a',
                connectedServiceGroupId: 'primary-pool',
            },
            candidateSource: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'member-b',
                connectedServiceGroupId: 'primary-pool',
                homePath: '/tmp/member-b',
            },
        })).toEqual({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'member-b',
            connectedServiceGroupId: 'primary-pool',
            homePath: '/tmp/member-b',
        });
    });

});
