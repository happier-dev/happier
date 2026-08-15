import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import type { GetSuggestionsOptions } from './suggestions';
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn((_sessionId: string) => 'server-a'));
const searchFilesMock = vi.hoisted(() => vi.fn(async (): Promise<FileItem[]> => []));
const WORKSPACE = { machineId: 'machine-a', path: '/repo', serverId: 'server-a' } as const;
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
    const { installStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return installStorageModuleStub({
        storage: {
            getState: () => storageStateMock,
        },
    })();
});

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: searchFilesMock,
}));

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

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
    async (importOriginal) => {
        const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedSessionRpcModuleMock({
            sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
        })(importOriginal);
    },
);

async function getSuggestionsForSession(query: string, options?: GetSuggestionsOptions) {
    const { getSuggestions } = await import('./suggestions');
    return await getSuggestions('s1', query, { workspace: WORKSPACE, ...options });
}

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
    async (importOriginal) => {
        const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedMachineRpcModuleMock({
            machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
        })(importOriginal);
    },
);

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId',
    async (importOriginal) => {
        const { installResolvePreferredServerIdForSessionIdModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installResolvePreferredServerIdForSessionIdModuleMock({
            resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
        })(importOriginal);
    },
);

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

    // Scoping is about which kinds a trigger RESOLVES, not about when their modules
    // load: the registry imports its dependencies eagerly on purpose, because on
    // native a deferred first-party import never completes in a dev client
    // (`composerSuggestionKinds.moduleLoad.native.test.ts` owns that contract).
    it('searches files for mention queries only, never for other triggers', async () => {
        const { getCommandSuggestions } = await import('./commandSuggestions');
        const { getSuggestions } = await import('./suggestions');

        await getCommandSuggestions('s1', '/go');
        await getSuggestionsForSession('$rev', {
            catalogs: { skills: [{ name: 'review' }] },
        });

        // A trigger the file kind does not serve never reaches the file search.
        expect(searchFilesMock).not.toHaveBeenCalled();

        // INV-2: a matching plugin no longer suppresses files, so a bare-word `@`
        // query resolves BOTH kinds. Trigger scoping was never allowed to be a
        // kind-suppression mechanism.
        await getSuggestionsForSession('@gmail', {
            catalogs: {
                vendorPlugins: [
                    {
                        name: 'gmail',
                        displayName: 'Gmail',
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        installed: true,
                        enabled: true,
                    },
                ],
            },
        });

        expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'gmail', { limit: 12 });

        await getSuggestionsForSession('@/src');

        expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, '/src', { limit: 12 });
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

        const suggestions = await getSuggestionsForSession('@plugin:gmail', {
            catalogs: {
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
            },
        });

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

    it('populates selected vendor plugin suggestions from the session catalog RPC', async () => {
        sessionRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'session.vendorPluginCatalog.list') {
                return {
                    vendorPlugins: [
                        {
                            name: 'gmail',
                            displayName: 'Gmail',
                            description: 'Mail and calendar',
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            installed: true,
                            enabled: true,
                        },
                    ],
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

        const suggestions = await getSuggestionsForSession('@plugin:gmail');
        const mention = suggestions[0]
            ? createStructuredInputMentionFromSuggestion({ suggestion: suggestions[0] })
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
                    sessionVendorPluginCatalogV1: {
                        vendorPlugins: [
                            expect.objectContaining({
                                vendorPluginRef: 'plugin://gmail@openai-curated',
                            }),
                        ],
                    },
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

        await expect(getSuggestionsForSession('@plugin:gmail')).resolves.toEqual([]);
        expect(storageStateMock.applySessions).not.toHaveBeenCalled();

        await expect(getSuggestionsForSession('@plugin:gmail')).resolves.toEqual([
            expect.objectContaining({
                structuredInput: expect.objectContaining({
                    kind: 'vendorPlugin',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                }),
            }),
        ]);
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps path-like at queries file-first without suppressing a matching plugin', async () => {
        // INV-2 / SB-2: the predecessor answered "is this query path-like?" and used
        // the answer to discard the whole plugin kind. Files still lead the list —
        // that is section order, not suppression.
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestionsForSession('@src/', {
            catalogs: {
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
                        name: 'src/formatter',
                        displayName: 'Source Formatter',
                        vendorPluginRef: 'plugin://src@openai-curated',
                        installed: true,
                        enabled: true,
                    },
                ],
            },
        });

        expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
            'file-src/index.ts',
            'vendor-plugin-plugin://src@openai-curated',
        ]);
        expect(suggestions[0]?.structuredInput).toBeUndefined();
        expect(suggestions[1]?.structuredInput).toMatchObject({ kind: 'vendorPlugin' });
    });

    it('falls back to file suggestions for plain at queries when no vendor plugin matches', async () => {
        sessionRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'session.vendorPluginCatalog.list') {
                return { vendorPlugins: [] };
            }
            if (params.method === 'session.skillCatalog.list') {
                return { skills: [] };
            }
            return {};
        });
        searchFilesMock.mockResolvedValueOnce([
            {
                fileName: 'README.md',
                filePath: '',
                fullPath: 'README.md',
                fileType: 'file',
            },
        ]);
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestionsForSession('@REA');

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'server-a',
            method: 'session.vendorPluginCatalog.list',
            payload: { cwd: '/repo' },
        });
        expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'REA', { limit: 12 });
        expect(suggestions).toEqual([
            expect.objectContaining({
                key: 'file-README.md',
                text: '@README.md',
            }),
        ]);
    });

    it('populates selected skill suggestions from the session catalog RPC', async () => {
        sessionRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === 'session.vendorPluginCatalog.list') {
                return { vendorPlugins: [] };
            }
            if (params.method === 'session.skillCatalog.list') {
                return {
                    skills: [
                        {
                            name: 'review',
                            displayName: 'Review',
                            description: 'Review code',
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
        const { createStructuredInputMentionFromSuggestion, buildStructuredInputMetaOverrides } = await import(
            '@/components/sessions/agentInput/structuredInputMentions'
        );

        const suggestions = await getSuggestionsForSession('$rev');
        const mention = suggestions[0]
            ? createStructuredInputMentionFromSuggestion({ suggestion: suggestions[0] })
            : null;
        const fileMention = createStructuredInputMentionFromSuggestion({
            suggestion: {
                kind: 'file',
                key: 'file-src/index.ts',
                text: '@src/index.ts',
            },
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
            key: 'skill-review',
            text: '$review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                path: '/skills/review/SKILL.md',
            },
        });
        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
                skillMentions: [
                    {
                        name: 'review',
                        path: '/skills/review/SKILL.md',
                        displayName: 'Review',
                        origin: 'codex_native',
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

        await expect(getSuggestionsForSession('@plugin:gmail')).resolves.toEqual([
            expect.objectContaining({
                structuredInput: expect.objectContaining({
                    kind: 'vendorPlugin',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                }),
            }),
        ]);
        await expect(getSuggestionsForSession('$rev')).resolves.toEqual([
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

        const suggestions = await getSuggestionsForSession('$rev', {
            catalogs: {
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
            },
        });

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({
            key: 'skill-review',
            text: '$review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                path: '/skills/review/SKILL.md',
            },
        });
    });
});
