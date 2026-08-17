import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileItem } from '@/sync/domains/input/suggestionFile';

/**
 * EU-2 characterization suite.
 *
 * Pins the observable `getSuggestions` contract that the registry carve-out must
 * NOT change: every trigger, the `plugin:` / `plugins:` scope aliases, prompt
 * invocation selection, the session-metadata catalog path (which every other
 * suggestion test bypasses with `catalogOverrides`), and the shape all three
 * production callers rely on.
 *
 * It must pass unchanged before and after the refactor.
 */

const searchFilesMock = vi.hoisted(() => vi.fn(async (): Promise<FileItem[]> => []));
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const fetchArtifactWithBodyMock = vi.hoisted(() => vi.fn(async () => null as unknown));

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, { id?: string; active?: boolean; metadata?: Record<string, unknown> }>,
    machines: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn(),
    updateArtifact: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => storageStateMock },
    });
});

vi.mock('@/sync/sync', () => ({
    sync: { fetchArtifactWithBody: fetchArtifactWithBodyMock },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: searchFilesMock,
}));

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: searchCommandsMock,
}));

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
    async (importOriginal) => {
        const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedSessionRpcModuleMock({
            sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params) as never,
        })(importOriginal);
    },
);

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
    async (importOriginal) => {
        const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedMachineRpcModuleMock({
            machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params) as never,
        })(importOriginal);
    },
);

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId',
    async (importOriginal) => {
        const { installResolvePreferredServerIdForSessionIdModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installResolvePreferredServerIdForSessionIdModuleMock({
            resolvePreferredServerIdForSessionId: () => 'server-a',
        })(importOriginal);
    },
);

const GMAIL_PLUGIN = {
    vendorPluginRef: 'plugin://gmail@openai-curated',
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Mail and calendar',
    installed: true,
    enabled: true,
};

const REVIEW_SKILL = {
    name: 'review',
    displayName: 'Review',
    description: 'Review a diff',
    path: '/repo/.happier/skills/review/SKILL.md',
    origin: 'happier',
};

/**
 * A skill row's key is its STRUCTURED identity — `(id, origin, backendId, agentId,
 * projectionRef, path, name)` lowercased — not its bare name. Two providers may publish a
 * `review` skill in the same session, so the name alone cannot key a row (nor de-duplicate
 * one). `id` wins when the daemon supplies one.
 */
const REVIEW_SKILL_KEY = 'skill-happier:/repo/.happier/skills/review/skill.md:review';

/** Seeds the CANONICAL session-metadata catalog snapshot keys the daemon actually writes. */
function seedSessionWithCatalogs(options?: Readonly<{ vendorPlugins?: unknown[]; skills?: unknown[] }>) {
    storageStateMock.sessions = {
        s1: {
            id: 's1',
            active: true,
            metadata: {
                path: '/repo',
                sessionVendorPluginCatalogV1: { vendorPlugins: options?.vendorPlugins ?? [GMAIL_PLUGIN] },
                sessionSkillCatalogV1: { skills: options?.skills ?? [REVIEW_SKILL] },
            },
        },
    };
}

async function importSuggestions() {
    return await import('./suggestions');
}

describe('getSuggestions characterization (EU-2)', () => {
    // The first import of the suggestion graph is expensive under vite-node; warm it once
    // instead of letting it charge against the first test's timeout.
    beforeAll(async () => {
        await importSuggestions();
    }, 180_000);

    beforeEach(() => {
        searchFilesMock.mockReset();
        searchFilesMock.mockResolvedValue([]);
        searchCommandsMock.mockReset();
        searchCommandsMock.mockResolvedValue([]);
        sessionRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerScopeMock.mockResolvedValue({});
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({});
        fetchArtifactWithBodyMock.mockReset();
        storageStateMock.applySessions.mockReset();
        storageStateMock.updateArtifact.mockReset();
        storageStateMock.artifacts = {};
        storageStateMock.machines = {};
        seedSessionWithCatalogs();
    });

    it('returns nothing for an empty query', async () => {
        const { getSuggestions } = await importSuggestions();
        expect(await getSuggestions('s1', '')).toEqual([]);
    });

    it('returns nothing for a query without a trigger', async () => {
        const { getSuggestions } = await importSuggestions();
        expect(await getSuggestions('s1', 'plain text')).toEqual([]);
    });

    describe('slash command trigger', () => {
        it('maps commands to suggestions with label, description and row height', async () => {
            searchCommandsMock.mockResolvedValue([
                { command: 'goal', description: 'Set or inspect the session goal' },
            ]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '/go');

            expect(searchCommandsMock).toHaveBeenCalledWith('s1', 'go', { limit: 8 });
            expect(suggestions).toHaveLength(1);
            expect(suggestions[0]).toMatchObject({
                key: 'cmd-goal',
                text: '/goal',
                label: '/goal',
                description: 'Set or inspect the session goal',
            });
            expect(suggestions[0]?.rowHeight).toBeGreaterThan(0);
        });

        it('carries prompt invocation metadata through to the suggestion', async () => {
            searchCommandsMock.mockResolvedValue([
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
            ]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '/qa');

            expect(suggestions[0]?.promptInvocation).toMatchObject({
                invocationId: 'tmpl_1',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
            });
        });

        it('returns nothing when command search fails', async () => {
            searchCommandsMock.mockRejectedValue(new Error('offline'));
            const { getSuggestions } = await importSuggestions();

            expect(await getSuggestions('s1', '/go')).toEqual([]);
        });
    });

    describe('mention trigger', () => {
        it('returns file suggestions for a path-like query', async () => {
            searchFilesMock.mockResolvedValue([
                { fileName: 'foo.ts', filePath: 'src/foo.ts', fullPath: 'src/foo.ts', fileType: 'file' } as FileItem,
            ]);
            const { getSuggestions } = await importSuggestions();

            // The file search is addressed by the machine + folder its host supplies, and that
            // scope must arrive unchanged. Asserting `null` instead would pass just as well
            // with the host's scope dropped on the way through the dispatcher.
            const workspace = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' } as const;
            const suggestions = await getSuggestions('s1', '@src/fo', { workspace });

            expect(searchFilesMock).toHaveBeenCalledWith(workspace, 'src/fo', expect.objectContaining({
                limit: 12,
                signal: expect.any(AbortSignal),
            }));
            expect(suggestions[0]).toMatchObject({ key: 'file-src/foo.ts', text: '@src/foo.ts' });
        });

        it('reads the vendor plugin catalog from session metadata without an override', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@gma');

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0]).toMatchObject({
                key: 'vendor-plugin-plugin://gmail@openai-curated',
                text: '@gmail',
                structuredInput: {
                    kind: 'vendorPlugin',
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    label: 'Gmail',
                },
            });
        });

        it('does not issue a catalog RPC when the metadata snapshot is already present', async () => {
            const { getSuggestions } = await importSuggestions();

            await getSuggestions('s1', '@gma');

            expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
            expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        });

        it('skips uninstalled and disabled plugins', async () => {
            seedSessionWithCatalogs({
                vendorPlugins: [
                    { ...GMAIL_PLUGIN, vendorPluginRef: 'plugin://a', name: 'alpha', installed: false },
                    { ...GMAIL_PLUGIN, vendorPluginRef: 'plugin://b', name: 'beta', enabled: false },
                    { ...GMAIL_PLUGIN, vendorPluginRef: 'plugin://c', name: 'gamma' },
                ],
            });
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@');

            expect(suggestions.map((s) => s.key)).toEqual(['vendor-plugin-plugin://c']);
        });

        it.each(['@plugin:gma', '@plugins:gma'])('scopes %s to plugins only', async (query) => {
            searchFilesMock.mockResolvedValue([
                { fileName: 'gmail.ts', filePath: 'src/gmail.ts', fullPath: 'src/gmail.ts', fileType: 'file' } as FileItem,
            ]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', query);

            expect(suggestions.map((s) => s.key)).toEqual(['vendor-plugin-plugin://gmail@openai-curated']);
        });

        it('matches a plugin by display name as well as by name', async () => {
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('s1', '@plugin:Gmail')).map((s) => s.key))
                .toEqual(['vendor-plugin-plugin://gmail@openai-curated']);
        });

        it('reads the marketplace from the `marketplaceId` alias', async () => {
            // Older daemon snapshots name this field `marketplaceId`. Dropping the alias is
            // silent: the row keeps rendering, it just falls back to the plugin's own name as
            // its subtitle, so the user can no longer tell two same-named marketplaces apart.
            seedSessionWithCatalogs({
                vendorPlugins: [{ ...GMAIL_PLUGIN, marketplaceId: 'openai-curated' }],
            });
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('s1', '@plugin:gma'))[0]?.description).toBe('openai-curated');
        });
    });

    describe('skill trigger', () => {
        it('reads the skill catalog from session metadata without an override', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '$rev');

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0]).toMatchObject({
                key: REVIEW_SKILL_KEY,
                text: '$review',
                structuredInput: {
                    kind: 'skill',
                    name: 'review',
                    path: '/repo/.happier/skills/review/SKILL.md',
                    displayName: 'Review',
                    description: 'Review a diff',
                    origin: 'happier',
                },
            });
        });

        it('skips disabled skills and de-duplicates by structured identity', async () => {
            seedSessionWithCatalogs({
                skills: [
                    { ...REVIEW_SKILL, name: 'off', enabled: false },
                    { ...REVIEW_SKILL, name: 'Review' },
                    { ...REVIEW_SKILL, name: 'review' },
                ],
            });
            const { getSuggestions } = await importSuggestions();

            // `Review` and `review` differ only in case and so collapse to one identity.
            expect((await getSuggestions('s1', '$')).map((s) => s.key)).toEqual([REVIEW_SKILL_KEY]);
        });

        it.each([
            ['codex_native', { origin: 'vendor', backendId: 'codex' }, 'skill-vendor:codex:/s/review.md:review'],
            ['opencode_native', { origin: 'vendor', backendId: 'opencode' }, 'skill-vendor:opencode:/s/review.md:review'],
            ['happier_projected', { origin: 'happier', projectionRef: 'happier_projected' }, 'skill-happier:happier_projected:/s/review.md:review'],
        ])('folds the legacy `%s` origin into the canonical origin triple', async (origin, expected, expectedKey) => {
            // A legacy daemon payload and a current one must produce the SAME suggestion
            // identity and the same provider context, or the row key flips — and the skill
            // mention reaches the provider without the backend it belongs to.
            seedSessionWithCatalogs({
                skills: [{ name: 'review', path: '/s/review.md', origin }],
            });
            const { getSuggestions } = await importSuggestions();

            const [suggestion] = await getSuggestions('s1', '$rev');

            expect(suggestion?.key).toBe(expectedKey);
            expect(suggestion?.structuredInput).toEqual(expect.objectContaining({
                kind: 'skill',
                name: 'review',
                ...expected,
            }));
        });
    });

    // SB-8: `hasCatalogSnapshot` accepts `plugins`/`items` as proof a snapshot
    // exists, so the reader must accept the same shapes — otherwise `ensure` skips
    // the RPC while the reader finds nothing. The former TOP-LEVEL aliases
    // (`vendorPluginCatalogV1`, `vendorPlugins`, `skillCatalogV1`, `skills`) had no
    // producer anywhere and no matching presence check, and were deleted.
    describe('catalog snapshot shapes', () => {
        it.each(['plugins', 'items'])('reads a vendor plugin snapshot stored under the %s alias', async (alias) => {
            storageStateMock.sessions = {
                s1: {
                    id: 's1',
                    active: true,
                    metadata: { path: '/repo', sessionVendorPluginCatalogV1: { [alias]: [GMAIL_PLUGIN] } },
                },
            };
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('s1', '@plugin:gma')).map((s) => s.key))
                .toEqual(['vendor-plugin-plugin://gmail@openai-curated']);
        });

        it('reads a skill snapshot stored under the items alias', async () => {
            storageStateMock.sessions = {
                s1: {
                    id: 's1',
                    active: true,
                    metadata: { path: '/repo', sessionSkillCatalogV1: { items: [REVIEW_SKILL] } },
                },
            };
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('s1', '$rev')).map((s) => s.key)).toEqual([REVIEW_SKILL_KEY]);
        });

        it('ignores a producer-less top-level catalog key', async () => {
            storageStateMock.sessions = {
                s1: {
                    id: 's1',
                    active: true,
                    // The daemon never writes this key; reading it would only make
                    // `ensure` and the reader disagree about what a snapshot is.
                    metadata: { path: '/repo', vendorPluginCatalogV1: { vendorPlugins: [GMAIL_PLUGIN] } },
                },
            };
            sessionRpcWithServerScopeMock.mockResolvedValue({ vendorPlugins: [] });
            const { getSuggestions } = await importSuggestions();

            expect(await getSuggestions('s1', '@plugin:gma')).toEqual([]);
        });
    });

    describe('sessions without catalogs (participant and automation composers)', () => {
        beforeEach(() => {
            storageStateMock.sessions = {
                s1: { id: 's1', active: true, metadata: { path: '/repo' } },
            };
        });

        it('still returns files for a mention query when no catalog snapshot exists', async () => {
            searchFilesMock.mockResolvedValue([
                { fileName: 'foo.ts', filePath: 'src/foo.ts', fullPath: 'src/foo.ts', fileType: 'file' } as FileItem,
            ]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@src/fo');

            expect(suggestions.map((s) => s.key)).toEqual(['file-src/foo.ts']);
        });

        it('does not throw for an unknown session id', async () => {
            const { getSuggestions } = await importSuggestions();

            await expect(getSuggestions('missing', '@foo')).resolves.toEqual([]);
            await expect(getSuggestions('missing', '$foo')).resolves.toEqual([]);
        });
    });
});

describe('registry-owned selection application (D-20)', () => {
    beforeEach(() => {
        fetchArtifactWithBodyMock.mockReset();
        storageStateMock.artifacts = {
            artifact_prompt_1: {
                body: JSON.stringify({ v: 1, markdown: 'Run QA now', createdAtMs: 1, updatedAtMs: 1 }),
            },
        };
    });

    it('rewrites the whole input through the kind that produced the candidate', async () => {
        // The host asks the registry, not a per-host prop: this rewrite used to be
        // duplicated byte-for-byte in SessionView and useNewSessionScreenModel.
        const { resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');
        const applySelection = resolveComposerSuggestionKind('slashCommand').applySelection;
        expect(applySelection).toBeDefined();

        const result = await applySelection!({
            suggestion: {
                kind: 'slashCommand',
                key: 'cmd-qa',
                text: '/qa',
                promptInvocation: {
                    invocationId: 'tmpl_1',
                    token: '/qa',
                    targetArtifactId: 'artifact_prompt_1',
                    behavior: 'insert',
                    allowArgs: false,
                },
            },
            inputText: 'before /qa after',
            selection: { start: 10, end: 10 },
            activeWord: { offset: 7, endOffset: 10 },
        });

        expect(result).toEqual({ handled: true, text: 'before Run QA now after', cursorPosition: 17 });
    });

    it('declines for a slash command without a prompt invocation, so the token insert runs', async () => {
        const { resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');

        await expect(resolveComposerSuggestionKind('slashCommand').applySelection!({
            suggestion: { kind: 'slashCommand', key: 'cmd-goal', text: '/goal' },
            inputText: 'before /goal after',
            selection: { start: 12, end: 12 },
            activeWord: { offset: 7, endOffset: 12 },
        })).resolves.toEqual({ handled: false });
    });

    it.each(['file', 'vendorPlugin', 'skill'] as const)('leaves %s selection to the token insert', async (kind) => {
        const { resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');
        expect(resolveComposerSuggestionKind(kind).applySelection).toBeUndefined();
    });
});

describe('prompt invocation selection characterization (D-20)', () => {
    // Driven through the registry's `applySelection`, which is the canonical owner of a
    // selection that is not "replace the token with a string" — and therefore the boundary
    // the composer host actually calls.
    async function applySlashCommandSelection(args: Readonly<{
        promptInvocation?: Record<string, unknown>;
        inputText: string;
        selection: Readonly<{ start: number; end: number }>;
        activeWord: Readonly<{ offset: number; endOffset: number }> | null;
    }>) {
        const { resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');
        const applySelection = resolveComposerSuggestionKind('slashCommand').applySelection;
        expect(applySelection).toBeDefined();
        return await applySelection!({
            suggestion: {
                kind: 'slashCommand',
                key: 'cmd-qa',
                text: '/qa',
                ...(args.promptInvocation ? { promptInvocation: args.promptInvocation as never } : {}),
            },
            inputText: args.inputText,
            selection: args.selection,
            activeWord: args.activeWord,
        });
    }

    beforeEach(() => {
        fetchArtifactWithBodyMock.mockReset();
        storageStateMock.artifacts = {
            artifact_prompt_1: {
                body: JSON.stringify({ v: 1, markdown: 'Run QA now', createdAtMs: 1, updatedAtMs: 1 }),
            },
        };
    });

    it('rewrites the whole input, not just the token, for an insert-behavior invocation', async () => {
        const result = await applySlashCommandSelection({
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
            inputText: 'before /qa after',
            selection: { start: 10, end: 10 },
            activeWord: { offset: 7, endOffset: 10 },
        });

        expect(result).toEqual({
            handled: true,
            text: 'before Run QA now after',
            cursorPosition: 17,
        });
    });

    it('declines to handle a suggestion without a prompt invocation', async () => {
        await expect(applySlashCommandSelection({
            inputText: 'before /qa after',
            selection: { start: 10, end: 10 },
            activeWord: { offset: 7, endOffset: 10 },
        })).resolves.toEqual({ handled: false });
    });

    it('declines to handle an insert_and_send invocation at selection time', async () => {
        await expect(applySlashCommandSelection({
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert_and_send',
                allowArgs: false,
            },
            inputText: 'before /qa after',
            selection: { start: 10, end: 10 },
            activeWord: { offset: 7, endOffset: 10 },
        })).resolves.toEqual({ handled: false });
    });

    it('declines when the token span is unknown, leaving the default token replacement to run', async () => {
        // `../dev`'s resolver requires the token span: without it there is nothing to
        // replace, and inventing one from the bare caret would rewrite the wrong range.
        await expect(applySlashCommandSelection({
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
            inputText: 'before /qa after',
            selection: { start: 10, end: 10 },
            activeWord: null,
        })).resolves.toEqual({ handled: false });
    });
});
