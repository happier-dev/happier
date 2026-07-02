import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn((_sessionId: string) => 'server-a'));
const searchFilesMock = vi.hoisted(() => vi.fn(async () => []));
const suggestionFileModuleImportCount = vi.hoisted(() => ({ value: 0 }));
const storageStateMock = vi.hoisted(() => ({
    sessions: {
        s1: {
            id: 's1',
            active: true,
            metadata: {
                path: '/repo',
            },
        },
    } as Record<string, { id?: string; active?: boolean; metadata?: Record<string, unknown> }>,
    machines: {} as Record<string, unknown>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn((sessions: Array<{ id?: string; metadata?: Record<string, unknown> }>) => {
        for (const session of sessions) {
            if (!session.id) continue;
            storageStateMock.sessions[session.id] = {
                ...(storageStateMock.sessions[session.id] ?? { id: session.id }),
                ...session,
            };
        }
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageStateMock,
        },
    });
});

vi.mock('@/sync/domains/input/suggestionFile', () => {
    suggestionFileModuleImportCount.value += 1;
    return {
        searchFiles: searchFilesMock,
    };
});

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: vi.fn(async () => [
        { command: 'goal', description: 'Set or inspect the session goal' },
        {
            command: 'qa',
            description: 'QA prompt',
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
        },
    ]),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

describe('structured input autocomplete suggestions', () => {
    beforeEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockClear();
        storageStateMock.applySessions.mockClear();
        storageStateMock.machines = {};
        storageStateMock.getProjectForSession.mockReset();
        searchFilesMock.mockClear();
        storageStateMock.sessions = {
            s1: {
                id: 's1',
                active: true,
                metadata: {
                    path: '/repo',
                },
            },
        };
    });

    it('loads file search only for file mention queries', async () => {
        vi.resetModules();
        suggestionFileModuleImportCount.value = 0;

        const { getCommandSuggestions } = await import('./commandSuggestions');
        const { getSuggestions } = await import('./suggestions');

        expect(suggestionFileModuleImportCount.value).toBe(0);

        await getCommandSuggestions('s1', '/go');
        await getSuggestions('s1', '$rev', {
            skills: [{ name: 'review' }],
        });
        await getSuggestions('s1', '@gmail', {
            vendorPlugins: [
                {
                    name: 'gmail',
                    displayName: 'Gmail',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    installed: true,
                    enabled: true,
                },
            ],
        });

        expect(suggestionFileModuleImportCount.value).toBe(0);

        await getSuggestions('s1', '@/src');

        expect(suggestionFileModuleImportCount.value).toBe(1);
        expect(searchFilesMock).toHaveBeenCalledWith('s1', '/src', { limit: 12 });
    });

    it('uses a taller row height for slash commands with descriptions', async () => {
        const { getCommandSuggestions } = await import('./commandSuggestions');

        const suggestions = await getCommandSuggestions('s1', '/go');

        expect(suggestions[0]).toMatchObject({
            key: 'cmd-goal',
            text: '/goal',
            label: '/goal',
            description: 'Set or inspect the session goal',
            rowHeight: 52,
        });
    });

    it('carries prompt invocation metadata on slash command suggestions', async () => {
        const { getCommandSuggestions } = await import('./commandSuggestions');

        const suggestions = await getCommandSuggestions('s1', '/qa');

        expect(suggestions.find((suggestion) => suggestion.key === 'cmd-qa')).toMatchObject({
            key: 'cmd-qa',
            text: '/qa',
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
        });
    });

    it('returns vendor plugin suggestions from explicit plugin namespace queries', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '@plugin:gmail', {
            vendorPlugins: [
                {
                    name: 'gmail',
                    displayName: 'Gmail',
                    description: 'Mail and calendar',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    marketplace: 'openai-curated',
                    installed: true,
                    enabled: true,
                },
            ],
        } as never);

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({
            key: 'vendor-plugin-plugin://gmail@openai-curated',
            text: '@gmail',
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: 'plugin://gmail@openai-curated',
            },
        });
    });

    it('hides explicitly unmentionable vendor plugins', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '@plugin:gmail', {
            vendorPlugins: [
                {
                    name: 'gmail',
                    displayName: 'Gmail',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    installed: true,
                    enabled: true,
                    mentionable: false,
                },
            ],
        } as never);

        expect(suggestions).toEqual([]);
    });

    it('populates selected vendor plugin suggestions from the session catalog RPC', async () => {
        sessionRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'session.vendorPluginCatalog.list') {
                return {
                    catalog: {
                        v: 1,
                        backendId: 'codex',
                        agentId: 'codex-agent',
                        updatedAt: 100,
                        items: [
                            {
                                v: 1,
                                backendId: 'codex',
                                agentId: 'codex-agent',
                                displayName: 'Gmail',
                                description: 'Mail and calendar',
                                vendorPluginRef: 'plugin://gmail@openai-curated',
                                installed: true,
                                enabled: true,
                            },
                        ],
                    },
                };
            }
            if (params.method === 'session.skillCatalog.list') {
                return { skills: [] };
            }
            return {};
        });
        const { getSuggestions } = await import('./suggestions');
        const { createStructuredInputMentionFromSuggestion, buildStructuredInputMetaOverrides } = await import(
            '@/components/sessions/agentInput/structuredInputMentions'
        );

        const suggestions = await getSuggestions('s1', '@plugin:gmail');
        const mention = suggestions[0]
            ? createStructuredInputMentionFromSuggestion({ suggestion: suggestions[0], start: 0 })
            : null;
        const meta = buildStructuredInputMetaOverrides({
            mentions: mention ? [mention] : [],
            text: '@gmail',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'server-a',
            method: 'session.vendorPluginCatalog.list',
            payload: { cwd: '/repo' },
        });
        expect(storageStateMock.applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's1',
                metadata: expect.objectContaining({
                    sessionVendorPluginCatalogV1: expect.objectContaining({
                        catalog: expect.objectContaining({
                            items: [
                                expect.objectContaining({
                                    backendId: 'codex',
                                    agentId: 'codex-agent',
                                    vendorPluginRef: 'plugin://gmail@openai-curated',
                                }),
                            ],
                        }),
                    }),
                }),
            }),
        ]);
        expect(suggestions[0]).toMatchObject({
            key: 'vendor-plugin-plugin://gmail@openai-curated',
            text: '@gmail',
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: 'plugin://gmail@openai-curated',
            },
        });
        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
                vendorPluginMentions: [
                    {
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        label: 'Gmail',
                        backendId: 'codex',
                        agentId: 'codex-agent',
                    },
                ],
            },
        });
    });

    it('does not cache transient catalog RPC failures as unsupported snapshots', async () => {
        sessionRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('temporary catalog failure'))
            .mockResolvedValueOnce({
                vendorPlugins: [
                    {
                        name: 'gmail',
                        displayName: 'Gmail',
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        installed: true,
                        enabled: true,
                    },
                ],
            });
        const { getSuggestions } = await import('./suggestions');

        await expect(getSuggestions('s1', '@plugin:gmail')).resolves.toEqual([]);
        expect(storageStateMock.applySessions).not.toHaveBeenCalled();

        await expect(getSuggestions('s1', '@plugin:gmail')).resolves.toEqual([
            expect.objectContaining({
                structuredInput: expect.objectContaining({
                    kind: 'vendorPlugin',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                }),
            }),
        ]);
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps path-like at queries file-first', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '@/src', {
            files: [
                {
                    fileName: 'index.ts',
                    filePath: 'src/',
                    fullPath: 'src/index.ts',
                    fileType: 'file',
                },
            ],
            vendorPlugins: [
                {
                    name: 'src',
                    displayName: 'Source Plugin',
                    vendorPluginRef: 'plugin://src@openai-curated',
                    installed: true,
                    enabled: true,
                },
            ],
        } as never);

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({
            key: 'file-src/index.ts',
            text: '@src/index.ts',
        });
        expect(suggestions[0]?.structuredInput).toBeUndefined();
    });

    it('populates selected skill suggestions from the session catalog RPC', async () => {
        sessionRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'session.vendorPluginCatalog.list') {
                return { vendorPlugins: [] };
            }
            if (params.method === 'session.skillCatalog.list') {
                return {
                    catalog: {
                        v: 1,
                        backendId: 'codex',
                        agentId: 'codex-agent',
                        updatedAt: 200,
                        items: [
                            {
                                v: 1,
                                id: 'codex:review',
                                name: 'review',
                                displayName: 'Review',
                                description: 'Review code',
                                path: '/skills/review/SKILL.md',
                                origin: 'vendor',
                                backendId: 'codex',
                                agentId: 'codex-agent',
                                projectionRef: 'codex-native:review',
                                enabled: true,
                            },
                        ],
                    },
                };
            }
            return {};
        });
        const { getSuggestions } = await import('./suggestions');
        const { createStructuredInputMentionFromSuggestion, buildStructuredInputMetaOverrides } = await import(
            '@/components/sessions/agentInput/structuredInputMentions'
        );

        const suggestions = await getSuggestions('s1', '$rev');
        const mention = suggestions[0]
            ? createStructuredInputMentionFromSuggestion({ suggestion: suggestions[0], start: 0 })
            : null;
        const fileMention = createStructuredInputMentionFromSuggestion({
            suggestion: {
                key: 'file-src/index.ts',
                text: '@src/index.ts',
            },
            start: 0,
        });
        const meta = buildStructuredInputMetaOverrides({
            mentions: mention ? [mention] : [],
            text: '$review',
        });

        expect(fileMention).toBeNull();
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'server-a',
            method: 'session.skillCatalog.list',
            payload: { cwd: '/repo' },
        });
        expect(suggestions[0]).toMatchObject({
            key: 'skill-codex:review',
            text: '$review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                path: '/skills/review/SKILL.md',
                origin: 'vendor',
                projectionRef: 'codex-native:review',
                backendId: 'codex',
                agentId: 'codex-agent',
            },
        });
        expect(storageStateMock.applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's1',
                metadata: expect.objectContaining({
                    sessionSkillCatalogV1: expect.objectContaining({
                        catalog: expect.objectContaining({
                            items: [
                                expect.objectContaining({
                                    origin: 'vendor',
                                    backendId: 'codex',
                                    agentId: 'codex-agent',
                                    projectionRef: 'codex-native:review',
                                }),
                            ],
                        }),
                    }),
                }),
            }),
        ]);
        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
                skillMentions: [
                    {
                        name: 'review',
                        path: '/skills/review/SKILL.md',
                        displayName: 'Review',
                        origin: 'vendor',
                        projectionRef: 'codex-native:review',
                        backendId: 'codex',
                        agentId: 'codex-agent',
                    },
                ],
            },
        });
    });

    it('hydrates missing inactive-session catalogs through daemon machine RPCs', async () => {
        storageStateMock.sessions = {
            s1: {
                id: 's1',
                active: false,
                metadata: {
                    path: '/repo',
                    machineId: 'machine-1',
                },
            },
        };
        storageStateMock.machines = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local' },
            },
        } as never;
        storageStateMock.getProjectForSession.mockReturnValue({
            key: {
                machineId: 'machine-1',
                path: '/repo',
            },
        });
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'daemon.sessionVendorPluginCatalog.list') {
                return {
                    vendorPlugins: [
                        {
                            name: 'gmail',
                            displayName: 'Gmail',
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            installed: true,
                            enabled: true,
                        },
                    ],
                };
            }
            if (params.method === 'daemon.sessionSkillCatalog.list') {
                return {
                    skills: [
                        {
                            name: 'review',
                            displayName: 'Review',
                            path: '/skills/review/SKILL.md',
                            origin: 'codex_native',
                            enabled: true,
                        },
                    ],
                };
            }
            return {};
        });
        const { getSuggestions } = await import('./suggestions');

        await expect(getSuggestions('s1', '@plugin:gmail')).resolves.toEqual([
            expect.objectContaining({
                structuredInput: expect.objectContaining({
                    kind: 'vendorPlugin',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                }),
            }),
        ]);
        await expect(getSuggestions('s1', '$rev')).resolves.toEqual([
            expect.objectContaining({
                structuredInput: expect.objectContaining({
                    kind: 'skill',
                    name: 'review',
                    path: '/skills/review/SKILL.md',
                }),
            }),
        ]);

        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.sessionVendorPluginCatalog.list',
            payload: { sessionId: 's1', cwd: '/repo' },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.sessionSkillCatalog.list',
            payload: { sessionId: 's1', cwd: '/repo' },
        }));
    });

    it('returns skill suggestions for dollar queries', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '$rev', {
            skills: [
                {
                    name: 'review',
                    displayName: 'Review',
                    description: 'Review code',
                    path: '/skills/review/SKILL.md',
                    enabled: true,
                    projectionKind: 'codex_native',
                },
            ],
        } as never);

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({
            key: 'skill-codex_native:/skills/review/skill.md:review',
            text: '$review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                path: '/skills/review/SKILL.md',
            },
        });
    });

    it('keeps same-name skill suggestions distinct when their origins differ', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '$rev', {
            skills: [
                {
                    id: 'vendor-review',
                    name: 'review',
                    displayName: 'Review',
                    enabled: true,
                    origin: 'vendor',
                    backendId: 'cursor',
                    projectionRef: 'cursor/review',
                },
                {
                    id: 'happier-review',
                    name: 'review',
                    displayName: 'Review',
                    enabled: true,
                    origin: 'happier',
                    projectionRef: 'happier/review',
                },
            ],
        } as never);

        expect(suggestions).toHaveLength(2);
        expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
            'skill-vendor-review',
            'skill-happier-review',
        ]);
        expect(suggestions.map((suggestion) => suggestion.structuredInput)).toEqual([
            expect.objectContaining({
                kind: 'skill',
                id: 'vendor-review',
                name: 'review',
                origin: 'vendor',
                backendId: 'cursor',
                projectionRef: 'cursor/review',
            }),
            expect.objectContaining({
                kind: 'skill',
                id: 'happier-review',
                name: 'review',
                origin: 'happier',
                projectionRef: 'happier/review',
            }),
        ]);
    });

    it('uses structured identity for same-name skill suggestion keys when ids are absent', async () => {
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '$rev', {
            skills: [
                {
                    name: 'review',
                    displayName: 'Review',
                    enabled: true,
                    origin: 'vendor',
                    backendId: 'cursor',
                    projectionRef: 'cursor/review',
                },
                {
                    name: 'review',
                    displayName: 'Review',
                    enabled: true,
                    origin: 'happier',
                    projectionRef: 'happier/review',
                },
            ],
        } as never);

        expect(suggestions).toHaveLength(2);
        expect(new Set(suggestions.map((suggestion) => suggestion.key)).size).toBe(2);
        expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
            'skill-vendor:cursor:cursor/review:review',
            'skill-happier:happier/review:review',
        ]);
    });
});
