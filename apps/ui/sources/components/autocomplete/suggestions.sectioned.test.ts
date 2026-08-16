import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileItem } from '@/sync/domains/input/suggestionFile';

/**
 * EU-3 — the sectioned picker's behaviour contract.
 *
 * Covers INV-2 (no kind suppresses another), INV-3 (an inserted token re-parses
 * to the kind that produced it), D-22 (the per-trigger row budget), D-25 (a hung
 * kind must not hide healthy sections) and D-15 (a superseded query contributes
 * nothing and reports nothing).
 */

const searchFilesMock = vi.hoisted(() => vi.fn(
    async (_sessionId: string, _query: string, _options?: Readonly<{ limit?: number }>): Promise<FileItem[]> => [],
));
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const logMock = vi.hoisted(() => vi.fn((_message: string) => {}));
const WORKSPACE = { machineId: 'machine-a', path: '/repo', serverId: 'server-a' } as const;

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, { id?: string; active?: boolean; metadata?: Record<string, unknown> }>,
    sessionListViewDataByServerId: {} as Record<string, unknown[]>,
    machines: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn(),
    updateArtifact: vi.fn(),
}));

vi.mock('@/log', () => ({ log: { log: logMock } }));

vi.mock('@/sync/domains/state/storage', async () => {
    const { installStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return installStorageModuleStub({
        storage: { getState: () => storageStateMock },
    })();
});

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
    marketplace: 'openai-curated',
    installed: true,
    enabled: true,
};

function file(fullPath: string): FileItem {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        fileName,
        filePath: fullPath.slice(0, fullPath.length - fileName.length),
        fullPath,
        fileType: 'file',
    } as FileItem;
}

function seedSession(metadata?: Record<string, unknown>) {
    storageStateMock.sessions = {
        s1: { id: 's1', active: true, metadata: { path: '/repo', ...metadata } },
    };
}

function seedCatalogs(options?: Readonly<{ vendorPlugins?: unknown[]; skills?: unknown[] }>) {
    seedSession({
        sessionVendorPluginCatalogV1: { vendorPlugins: options?.vendorPlugins ?? [GMAIL_PLUGIN] },
        sessionSkillCatalogV1: { skills: options?.skills ?? [] },
    });
}

async function importSuggestions() {
    const module = await import('./suggestions');
    return {
        ...module,
        getSuggestions: (
            sessionId: string | null,
            query: string,
            options?: Parameters<typeof module.getSuggestions>[2],
        ) => module.getSuggestions(sessionId, query, { workspace: WORKSPACE, ...options }),
    };
}

describe('sectioned composer suggestions (EU-3)', () => {
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
        logMock.mockReset();
        storageStateMock.applySessions.mockReset();
        storageStateMock.machines = {};
        storageStateMock.sessionListViewDataByServerId = {};
        seedCatalogs();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('INV-2 — no kind suppresses another', () => {
        it('returns both files and plugins for a bare-word query that matches a plugin', async () => {
            // The headline defect: one enabled matching plugin used to return ZERO files.
            searchFilesMock.mockResolvedValue([file('src/gmail.ts')]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@gma');

            expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['file', 'vendorPlugin']);
            expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
                'file-src/gmail.ts',
                'vendor-plugin-plugin://gmail@openai-curated',
            ]);
        });

        it('offers a scoped plugin for a path-like query (@src/)', async () => {
            searchFilesMock.mockResolvedValue([file('src/index.ts')]);
            seedCatalogs({
                vendorPlugins: [{ ...GMAIL_PLUGIN, name: 'src/formatter', vendorPluginRef: 'plugin://fmt' }],
            });
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@src/');

            expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
                'file-src/index.ts',
                'vendor-plugin-plugin://fmt',
            ]);
        });

        it('lists README.md for @REA while a non-matching plugin is installed', async () => {
            searchFilesMock.mockResolvedValue([file('README.md')]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@REA');

            expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
        });

        it('starts the file search without waiting for the plugin catalog RPC', async () => {
            // The plugin catalog is hydrated inside the plugin kind's own promise, so a
            // slow daemon never puts the file search behind it. (The list still settles
            // as a whole — incremental streaming is explicitly out of scope for v1.)
            seedSession();
            const catalogGate: { release: (() => void) | null } = { release: null };
            sessionRpcWithServerScopeMock.mockImplementation(() => new Promise((resolve) => {
                catalogGate.release = () => resolve({ vendorPlugins: [GMAIL_PLUGIN] });
            }));
            searchFilesMock.mockResolvedValue([file('README.md')]);
            const { getSuggestions } = await importSuggestions();

            const pending = getSuggestions('s1', '@REA');
            await vi.waitFor(() => {
                expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'REA', { limit: 12 });
            });
            expect(catalogGate.release).not.toBeNull();

            catalogGate.release?.();
            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
        });
    });

    describe('scope aliases', () => {
        it.each(['@plugin:gma', '@plugins:gma'])('%s narrows to plugins by explicit intent', async (query) => {
            searchFilesMock.mockResolvedValue([file('src/gmail.ts')]);
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', query);

            expect(suggestions.map((suggestion) => suggestion.key))
                .toEqual(['vendor-plugin-plugin://gmail@openai-curated']);
            expect(searchFilesMock).not.toHaveBeenCalled();
        });
    });

    describe('EU-7 — the session kind', () => {
        const PEER_SESSION = {
            id: 'cmslj08960ku1tmhrd0v4a0a7',
            title: 'Fix Detached Dev Stack Startup',
            workspaceLabel: '~/projects/app',
            agentLabel: 'codex',
            agentId: 'codex',
            updatedAt: 10,
            active: true,
        } as const;

        it('shows a Sessions section alongside Files for a bare `@` (INV-2)', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@fix', {
                catalogs: { files: [file('src/fix.ts')], sessions: [PEER_SESSION] },
            });

            expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(['file', 'session']);
        });

        it('narrows to sessions under the `session:` scope alias', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@session:fix', {
                catalogs: { files: [file('src/fix.ts')], sessions: [PEER_SESSION] },
            });

            expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
                `session-${PEER_SESSION.id}`,
            ]);
        });

        it('round-trips its token back to the session kind (INV-3)', async () => {
            const { getSuggestions } = await importSuggestions();

            const first = await getSuggestions('s1', '@session:', {
                catalogs: { sessions: [PEER_SESSION] },
            });
            expect(first[0]?.text).toBe('@session:fix-detached-dev-stack-startup-v4a0a7');

            const reparsed = await getSuggestions('s1', first[0]!.text, {
                catalogs: { files: [file('src/fix.ts')], sessions: [PEER_SESSION] },
            });

            expect(reparsed.map((suggestion) => suggestion.key)).toEqual([`session-${PEER_SESSION.id}`]);
            expect(reparsed[0]?.kind).toBe('session');
        });

        it('carries the session id, never the title, as the mention identity', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@session:', {
                catalogs: { sessions: [PEER_SESSION] },
            });

            expect(suggestions[0]?.structuredInput).toEqual({
                kind: 'session',
                sessionId: PEER_SESSION.id,
                label: PEER_SESSION.title,
            });
        });

        /**
         * Every other `@` kind is one concept with one glyph, so the kind's icon says
         * everything. A session is not: which agent is running in it is the thing a user
         * scans this list for, and one shared speech bubble on every row withholds it.
         */
        it('draws each row with its own provider logo', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@session:', {
                catalogs: {
                    sessions: [
                        PEER_SESSION,
                        { ...PEER_SESSION, id: 'cmslj08960ku1tmhrd0v4a0b8', title: 'Claude Work', agentLabel: 'claude', agentId: 'claude' },
                    ],
                },
            });

            expect(suggestions.map(
                (suggestion) => (suggestion.icon as ReactElement<{ agentId: string }> | undefined)?.props.agentId,
            )).toEqual(['codex', 'claude']);
        });

        it('leaves the row to the kind glyph when the provider is not one this build knows', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@session:', {
                catalogs: { sessions: [{ ...PEER_SESSION, agentLabel: 'some-future-agent', agentId: null }] },
            });

            expect(suggestions[0]?.kind).toBe('session');
            expect(suggestions[0]?.icon).toBeUndefined();
        });

        // The cases above all inject `catalogs.sessions`, so none of them reaches the real
        // store projection. These do — which is the only way the server scoping below is
        // exercised at all.
        describe('server scoping through the real store projection (D-8)', () => {
            function listed(serverId: string, ids: readonly string[]) {
                storageStateMock.sessionListViewDataByServerId[serverId] = ids.map((id) => ({
                    type: 'session',
                    serverId,
                    session: {
                        id,
                        active: true,
                        updatedAt: 10,
                        metadata: { name: `Session ${id}`, path: '/repo' },
                    },
                }));
            }

            it('scopes a host WITH a session to that session\'s server, and excludes it', async () => {
                seedCatalogs();
                listed('server-a', ['s1', 'peer']);
                listed('server-b', ['elsewhere']);
                const { getSuggestions } = await importSuggestions();

                const suggestions = await getSuggestions('s1', '@session:');

                expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['session-peer']);
            });

            it('scopes a host with NO session to the server it declares, excluding nothing', async () => {
                // The new-session composer: no session at all, plus the server its session will
                // spawn on. `kinds` is narrowed to the session kind so the assertion is about
                // server scoping and nothing else.
                listed('server-a', ['s1', 'peer']);
                listed('server-b', ['elsewhere']);
                const { getSuggestions } = await importSuggestions();

                const suggestions = await getSuggestions(null, '@session:', {
                    kinds: ['session', 'slashCommand'],
                    serverId: 'server-a',
                });

                // `s1` is present: with no current session there is nothing to exclude.
                expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['session-peer', 'session-s1']);
            });

            it('offers nothing when a host with no session declares no server', async () => {
                // Fail-closed: the sentinel id must never fall back to "every server" — a
                // reference on another server is one the agent could never act on (D-8).
                listed('server-a', ['s1', 'peer']);
                const { getSuggestions } = await importSuggestions();

                expect(await getSuggestions(null, '@session:', {
                    kinds: ['session', 'slashCommand'],
                })).toEqual([]);
                expect(await getSuggestions(null, '@session:', {
                    kinds: ['session', 'slashCommand'],
                    serverId: '',
                })).toEqual([]);
            });

            it('never leaks another server\'s sessions to a host that declared a different one', async () => {
                listed('server-a', ['peer']);
                listed('server-b', ['elsewhere']);
                const { getSuggestions } = await importSuggestions();

                const suggestions = await getSuggestions(null, '@session:', {
                    kinds: ['session', 'slashCommand'],
                    serverId: 'server-b',
                });

                expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['session-elsewhere']);
            });
        });
    });

    describe('INV-3 — an inserted token re-parses to the kind that produced it', () => {
        it.each([
            ['file', '@sr', [file('src/foo.ts')], undefined, undefined],
            ['file with a space in its path', '@my', [file('my file.ts')], undefined, undefined],
            ['plugin', '@gma', [], undefined, undefined],
            ['plugin whose name looks like a path', '@acme', [], [{ ...GMAIL_PLUGIN, name: 'acme/formatter', vendorPluginRef: 'plugin://acme' }], undefined],
            ['skill', '$rev', [], undefined, [{ name: 'review', path: '/s/review.md' }]],
        ])('round-trips a %s token', async (_label, query, files, vendorPlugins, skills) => {
            searchFilesMock.mockImplementation(async (_sessionId, search) =>
                (files as FileItem[]).filter((item) => item.fullPath.includes(search.split('/')[0]!)));
            seedCatalogs({
                ...(vendorPlugins ? { vendorPlugins } : {}),
                ...(skills ? { skills } : {}),
            });
            const { getSuggestions } = await importSuggestions();

            const first = await getSuggestions('s1', query);
            const candidate = first.find((suggestion) => suggestion.kind !== 'slashCommand');
            expect(candidate).toBeDefined();

            // Feed the literal token the picker would insert straight back in.
            const reparsed = await getSuggestions('s1', candidate!.text);

            expect(reparsed.map((suggestion) => suggestion.key)).toContain(candidate!.key);
            expect(reparsed.find((suggestion) => suggestion.key === candidate!.key)?.kind)
                .toBe(candidate!.kind);
        });

        it('round-trips a slash command token', async () => {
            searchCommandsMock.mockResolvedValue([{ command: 'h.review', description: 'Review' }]);
            const { getSuggestions } = await importSuggestions();

            const first = await getSuggestions('s1', '/h.rev');
            expect(first[0]?.text).toBe('/h.review');

            const reparsed = await getSuggestions('s1', first[0]!.text);
            expect(reparsed.map((suggestion) => suggestion.key)).toEqual(['cmd-h.review']);
        });
    });

    // Plan §7.3 at the resolution layer. EU-1 covers detection (`findActiveWord`);
    // these prove the query the dispatcher searches for survives the same inputs.
    describe('input methods (plan 7.3)', () => {
        it.each([
            ['astral characters', 'docs/🙂-notes.md'],
            ['right-to-left text', 'docs/שלום.md'],
            ['a space, which forces a quoted token', 'docs/my notes.md'],
        ])('round-trips a file token containing %s', async (_label, fullPath) => {
            searchFilesMock.mockResolvedValue([file(fullPath)]);
            const { getSuggestions } = await importSuggestions();

            const [candidate] = await getSuggestions('s1', '@docs/');
            expect(candidate?.key).toBe(`file-${fullPath}`);

            // Re-open the picker on the token the composer now holds — the state a
            // restored draft or a pasted token arrives in.
            searchFilesMock.mockClear();
            const reparsed = await getSuggestions('s1', candidate!.text);

            expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, fullPath, { limit: 12 });
            expect(reparsed.map((suggestion) => suggestion.key)).toContain(`file-${fullPath}`);
        });
    });

    describe('D-22 — per-trigger row budget', () => {
        it('caps a catalog kind at its declared limit instead of mounting the whole catalog', async () => {
            seedCatalogs({
                vendorPlugins: Array.from({ length: 40 }, (_unused, index) => ({
                    ...GMAIL_PLUGIN,
                    name: `plugin-${index}`,
                    vendorPluginRef: `plugin://p${index}`,
                })),
            });
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@plugin:');

            expect(suggestions).toHaveLength(12);
        });

        it('caps a kind whose source ignores the limit it was handed', async () => {
            // The dispatcher is the enforcement point, not each resolver: the catalog
            // kinds happen to stop at `limit` themselves, so a test that only exercises
            // them passes with the dispatcher's bound removed. A source that returns
            // more than it was asked for — a warm cache, or a kind added later — is
            // what the bound actually exists for.
            searchFilesMock.mockResolvedValue(
                Array.from({ length: 40 }, (_unused, index) => file(`src/file-${index}.ts`)),
            );
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@src/', { kinds: ['file'] });

            expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'src/', { limit: 12 });
            expect(suggestions).toHaveLength(12);
        });

        it('keeps every trigger under the mounted-row ceiling', async () => {
            const { COMPOSER_SUGGESTION_TRIGGER_ROW_BUDGET, resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');
            const {
                COMPOSER_SUGGESTION_KIND_IDS,
                COMPOSER_SUGGESTION_TRIGGERS,
                resolveComposerSuggestionTrigger,
            } = await import('./composerSuggestionGrammar');

            for (const trigger of COMPOSER_SUGGESTION_TRIGGERS) {
                const total = COMPOSER_SUGGESTION_KIND_IDS
                    .filter((id) => resolveComposerSuggestionTrigger(id) === trigger)
                    .reduce((sum, id) => sum + resolveComposerSuggestionKind(id).limit, 0);
                expect(total).toBeGreaterThan(0);
                expect(total).toBeLessThanOrEqual(COMPOSER_SUGGESTION_TRIGGER_ROW_BUDGET);
            }
        });
    });

    describe('D-25 — a stalled kind cannot hide a healthy one', () => {
        it('renders the other sections once the deadline passes, and reports the stalled kind', async () => {
            seedSession();
            sessionRpcWithServerScopeMock.mockImplementation(() => new Promise(() => {}));
            searchFilesMock.mockResolvedValue([file('README.md')]);
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            const suggestions = await pending;

            expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('vendorPlugin'));
        });

        // The other half of D-25, and the one that shipped broken: the deadline is a
        // TRIM that lets a healthy section render, not a cut-off. When NO kind is
        // healthy there is no section to protect, and cutting the fan-out short only
        // discards a result that lands moments later — permanently, because
        // `getSuggestions` settles once per query. That is a cold `@` in every
        // session: the file kind builds its index through a daemon ripgrep RPC.
        it('waits past the deadline when trimming would leave nothing to show', async () => {
            seedSession();
            let releaseFiles!: (files: FileItem[]) => void;
            const files = new Promise<FileItem[]>((resolve) => { releaseFiles = resolve; });
            searchFilesMock.mockReturnValue(files);
            sessionRpcWithServerScopeMock.mockResolvedValue({ vendorPlugins: [] });
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            releaseFiles([file('README.md')]);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
            // The wait is announced when it starts, not only when it ends: a kind whose
            // transport never answers must not produce an empty picker in total silence.
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('still waiting on file'));
        });

        // The half that broke when the deadline became a trim: past the deadline the
        // wait had NO bound left, so a kind whose transport never answers hid every
        // healthy section for as long as the query stayed current — strictly worse
        // than the cut-off it replaced, which at least returned.
        //
        // Observed on an iOS dev client (lane N1, 2026-08-10): for a bare `@` the
        // plugin kind produced its row in 12 ms and the picker was STILL empty ten
        // minutes later, because the file kind's module load never resolved. D-25 and
        // INV-2 say a hung kind leaves the others intact; that has to hold after the
        // deadline too, not only at it.
        it('renders a section that lands after the deadline while another kind never settles', async () => {
            seedSession();
            let releaseFiles!: (files: FileItem[]) => void;
            searchFilesMock.mockReturnValue(new Promise<FileItem[]>((resolve) => {
                releaseFiles = resolve;
            }));
            sessionRpcWithServerScopeMock.mockReturnValue(new Promise(() => {}));
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            releaseFiles([file('README.md')]);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('"vendorPlugin"'));
        });

        // What a COLD `@` actually promises, and the half that is easiest to break
        // while "fixing" the other. On a fresh session every kind is past the
        // deadline: the file kind is building its index and the catalog kinds are
        // hydrating through the daemon. The query settles on the FIRST section that
        // becomes ready — it must not block on the catalogs still in flight, or the
        // picker stays empty for the whole hydration.
        //
        // But "stopped waiting on" must not become "cancelled": the hydration this
        // query walked away from is what makes the NEXT keystroke warm. A cold path
        // that tears down its own outstanding catalog work would re-issue and
        // re-cancel it on every keystroke and never converge — an empty Plugins
        // section for as long as the user keeps typing.
        it('settles a cold query on the first ready section and still warms the catalog for the next one', async () => {
            seedSession();
            // The real hydration write-back, which the default no-op stub suppresses.
            storageStateMock.applySessions.mockImplementation((sessions: { id?: string }[]) => {
                for (const session of sessions) {
                    if (session.id) storageStateMock.sessions[session.id] = session;
                }
            });
            let releaseFiles!: (files: FileItem[]) => void;
            searchFilesMock.mockReturnValue(new Promise<FileItem[]>((resolve) => {
                releaseFiles = resolve;
            }));
            let releaseCatalog!: (response: unknown) => void;
            sessionRpcWithServerScopeMock.mockReturnValue(new Promise((resolve) => {
                releaseCatalog = resolve;
            }));
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@gma');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            releaseFiles([file('src/gmail.ts')]);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-src/gmail.ts']);

            releaseCatalog({ vendorPlugins: [GMAIL_PLUGIN] });
            vi.useRealTimers();
            await vi.waitFor(() => {
                expect(storageStateMock.sessions.s1?.metadata?.sessionVendorPluginCatalogV1).toBeDefined();
            });

            searchFilesMock.mockResolvedValue([file('src/gmail.ts')]);
            expect((await getSuggestions('s1', '@gma')).map((suggestion) => suggestion.key)).toEqual([
                'file-src/gmail.ts',
                'vendor-plugin-plugin://gmail@openai-curated',
            ]);
        });

        // A kind's failure is a diagnostic, never an empty result. `resolveFileSuggestions`
        // used to `catch { return [] }`, which made a failed import, a rejected file-search
        // RPC and a genuinely empty repository the same observable outcome — an empty
        // picker with nothing anywhere to debug.
        it('reports a failing kind instead of returning it as an empty section', async () => {
            seedSession();
            searchFilesMock.mockRejectedValue(new Error('file search transport closed'));
            sessionRpcWithServerScopeMock.mockResolvedValue({ vendorPlugins: [] });
            const { getSuggestions } = await importSuggestions();

            expect(await getSuggestions('s1', '@REA')).toEqual([]);
            expect(logMock).toHaveBeenCalledWith(
                expect.stringContaining('file search transport closed'),
            );
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('"file"'));
        });

        // The dispatcher declares itself "the ONE place a kind's failure surfaces".
        // That is only true if EVERY kind lets its failure reach it. The slash-command
        // kind used to swallow its own transport error into `[]`, which is the exact
        // shape that hid the dead `@` for hours — and it would hide a dead `/` the same
        // way, on the one trigger users still had.
        it('reports a failing slash-command kind instead of swallowing it into an empty section', async () => {
            seedSession();
            searchCommandsMock.mockRejectedValue(new Error('command search transport closed'));
            const { getSuggestions } = await importSuggestions();

            expect(await getSuggestions('s1', '/rev')).toEqual([]);
            expect(logMock).toHaveBeenCalledWith(
                expect.stringContaining('command search transport closed'),
            );
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('"slashCommand"'));
        });
    });

    describe('D-15 — supersession', () => {
        it('contributes nothing when the signal is already aborted', async () => {
            const { getSuggestions } = await importSuggestions();
            const controller = new AbortController();
            controller.abort();

            expect(await getSuggestions('s1', '@gma', { signal: controller.signal })).toEqual([]);
            expect(searchFilesMock).not.toHaveBeenCalled();
        });

        it('settles a stalled query as soon as it is superseded, and reports nothing', async () => {
            seedSession();
            sessionRpcWithServerScopeMock.mockImplementation(() => new Promise(() => {}));
            searchFilesMock.mockResolvedValue([file('README.md')]);
            const { getSuggestions } = await importSuggestions();
            const controller = new AbortController();

            const pending = getSuggestions('s1', '@REA', { signal: controller.signal });
            controller.abort();

            expect(await pending).toEqual([]);
            // A rejection caused by the user typing the next character is not a diagnostic.
            expect(logMock).not.toHaveBeenCalled();
        });
    });

    describe('R-9 — host eligible-kind subsets', () => {
        it('returns no skills for a host that does not offer the skill kind', async () => {
            seedCatalogs({ skills: [{ name: 'review', path: '/s/review.md' }] });
            const { getSuggestions } = await importSuggestions();

            const withSkills = await getSuggestions('s1', '$rev', { kinds: ['file', 'vendorPlugin', 'skill', 'slashCommand'] });
            const withoutSkills = await getSuggestions('s1', '$rev', { kinds: ['file', 'vendorPlugin', 'slashCommand'] });

            expect(withSkills.map((suggestion) => suggestion.key)).toEqual(['skill-review']);
            expect(withoutSkills).toEqual([]);
        });

        it('returns no mentions for a host that offers slash commands only', async () => {
            searchFilesMock.mockResolvedValue([file('README.md')]);
            searchCommandsMock.mockResolvedValue([{ command: 'goal' }]);
            const { getSuggestions } = await importSuggestions();

            expect(await getSuggestions('s1', '@REA', { kinds: ['slashCommand'] })).toEqual([]);
            expect(searchFilesMock).not.toHaveBeenCalled();
            expect((await getSuggestions('s1', '/go', { kinds: ['slashCommand'] })).map((s) => s.key))
                .toEqual(['cmd-goal']);
        });

        it('tolerates a session id with no session record (new-session composer)', async () => {
            storageStateMock.sessions = {};
            searchCommandsMock.mockResolvedValue([{ command: 'goal' }]);
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('new-session', '/go', { kinds: ['slashCommand'] })).map((s) => s.key))
                .toEqual(['cmd-goal']);
        });
    });
});
