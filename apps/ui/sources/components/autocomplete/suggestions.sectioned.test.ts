import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MENTION_KIND_V1,
    RPC_METHODS,
    buildMentionRefForKindV1,
    type PluginContributionLifecycleRecordV1,
    type PluginProjectionV2,
    type PluginUiIconTokenV1,
} from '@happier-dev/protocol';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import type { FileItem, FileSuggestionScope } from '@/sync/domains/input/suggestionFile';

/**
 * EU-3 — the sectioned picker's behaviour contract.
 *
 * Covers INV-2 (no kind suppresses another), INV-3 (an inserted token re-parses
 * to the kind that produced it), D-22 (the per-trigger row budget), D-25 (a hung
 * kind must not hide healthy sections) and D-15 (a superseded query contributes
 * nothing and reports nothing).
 */

const searchFilesMock = vi.hoisted(() => vi.fn(
    async (
        _scope: FileSuggestionScope | null,
        _query: string,
        _options?: Readonly<{ limit?: number; signal?: AbortSignal }>,
    ): Promise<FileItem[]> => [],
));

/**
 * The machine + folder a composer addresses its file search to, supplied by the host and
 * forwarded verbatim. Asserting that this exact scope arrives at `searchFiles` is what proves
 * the search is addressed by workspace; asserting `null` would pass just as well with the
 * host's scope dropped on the floor.
 */
const WORKSPACE: FileSuggestionScope = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' };
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const logMock = vi.hoisted(() => vi.fn((_message: string) => {}));

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, { id?: string; active?: boolean; metadata?: Record<string, unknown> }>,
    machines: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn(),
    updateArtifact: vi.fn(),
}));

vi.mock('@/log', () => ({ log: { log: logMock } }));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => storageStateMock },
    });
});

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: searchFilesMock,
}));

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: searchCommandsMock,
}));

// The registry imports this eagerly and deliberately (a lazy first-party import is a
// network chunk fetch on native — see `composerSuggestionKinds.moduleLoad.native.test.ts`),
// so its whole artifact-store graph would be transformed for a suite that never invokes
// `applySelection`. Stubbed as the boundary it is; the module-loading contract has its
// own owner.
vi.mock('@/sync/domains/input/slashCommands/promptInvocationSuggestion', () => ({
    resolvePromptInvocationAutocompleteSelection: vi.fn(async () => ({ handled: false as const })),
}));

// These resolver tests never mount candidate rows. Keep the registry's eager
// production imports intact while replacing only their visual leaves; otherwise
// Vite transforms the complete file-preview icon graph before the dispatcher
// module can load and the test never reaches its first behavior assertion.
vi.mock('@/components/sessions/agentInput/components/AgentInputSuggestionView', () => ({
    FileMentionSuggestion: () => null,
    // Stubbed for the same reason: it draws a registry image asset, and the session
    // rows here are asserted by the props the registry hands it, not by what it paints.
    SessionMentionAgentLogo: () => null,
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => null,
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

function composerReferenceProjection(entries: readonly Readonly<{
    pluginId: string;
    localId: string;
    title?: string;
    description?: string;
    icon?: PluginUiIconTokenV1;
    triggers?: readonly ('@' | '$' | '/')[];
    registrationState?: 'bound' | 'unbound' | 'unavailable';
    registrationGeneration?: string;
    activationState?: 'active' | 'dormant' | 'unavailable';
    activationGeneration?: string;
}>[]): PluginProjectionV2 {
    const generation = 7;
    return {
        v: 2,
        generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        contributionIntrospection: {
            version: 1,
            generation,
            contributions: entries.map((entry): PluginContributionLifecycleRecordV1 => ({
                version: 1,
                contribution: {
                    kind: 'localId',
                    pluginId: entry.pluginId,
                    family: 'composerReferences',
                    qualifiedId: `${entry.pluginId}/${entry.localId}`,
                    localId: entry.localId,
                },
                progression: { declared: true, normalized: true, merged: true },
                registration: {
                    requirement: 'required',
                    state: entry.registrationState ?? 'bound',
                    ...(entry.registrationState === 'bound' || entry.registrationState === undefined
                        ? { generation: entry.registrationGeneration ?? String(generation) }
                        : {}),
                },
                activation: entry.activationState === 'dormant'
                    ? { state: 'dormant' }
                    : entry.activationState === 'unavailable'
                        ? { state: 'unavailable', reason: 'test unavailable' }
                        : { state: 'active', generation: entry.activationGeneration ?? String(generation) },
                projection: { state: 'projected' },
                consumer: 'composer-reference-host',
                platforms: ['cli', 'web'],
                diagnostics: [],
                presentation: {
                    kind: 'composerReference' as const,
                    title: entry.title ?? 'Issues',
                    ...(entry.description ? { description: entry.description } : {}),
                    icon: entry.icon ?? 'search',
                    triggers: [...(entry.triggers ?? ['@'])],
                },
            })),
            diagnostics: [],
        },
        diagnostics: [],
    };
}

async function importSuggestions() {
    return await import('./suggestions');
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

        it('returns files for a bare-word query when NO plugin matches, and when none is installed', async () => {
            // `../dev`'s predecessor returned `vendorPluginSuggestions` — often empty — for any
            // non-path-like `@` query and never reached file search at all, so `@gma` in a
            // session with no matching plugin produced an empty list rather than the files.
            searchFilesMock.mockResolvedValue([file('src/gmail.ts')]);
            seedCatalogs({ vendorPlugins: [] });
            const { getSuggestions } = await importSuggestions();

            expect((await getSuggestions('s1', '@gma', { workspace: WORKSPACE })).map((suggestion) => suggestion.key))
                .toEqual(['file-src/gmail.ts']);
            expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'gma', expect.objectContaining({
                limit: 12,
                signal: expect.any(AbortSignal),
            }));
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

            const pending = getSuggestions('s1', '@REA', { workspace: WORKSPACE });
            await vi.waitFor(() => {
                expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'REA', expect.objectContaining({
                    limit: 12,
                    signal: expect.any(AbortSignal),
                }));
            });
            expect(catalogGate.release).not.toBeNull();

            catalogGate.release?.();
            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
        });
    });

    describe('public composer references', () => {
        it('renders a $-declared reference only for $, carries its declared presentation, and preserves $ in the selection token', async () => {
            const projection = composerReferenceProjection([{
                pluginId: 'acme.issues',
                localId: 'issues',
                title: 'Issue tracker',
                description: 'Search project issues',
                icon: 'search',
                triggers: ['$'],
            }]);
            machineRpcWithServerScopeMock.mockResolvedValue({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'issue-42', label: 'Issue 42', description: 'Current sprint issue' }],
            });
            const { getSuggestions } = await importSuggestions();

            const dollarSuggestions = await getSuggestions('s1', '$issue', {
                kinds: ['composerReference'],
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection,
                    isCurrent: () => true,
                },
            });

            expect(dollarSuggestions).toEqual([
                expect.objectContaining({
                    kind: 'composerReference',
                    key: 'composer-reference-["acme.issues","issues","issue-42"]',
                    text: '$"Issue 42"',
                    label: 'Issue 42',
                    group: 'Issue tracker',
                    description: 'Search project issues · Current sprint issue · acme.issues/issues',
                    icon: expect.objectContaining({
                        props: expect.objectContaining({ name: 'magnifying-glass', size: 16 }),
                    }),
                }),
            ]);
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
                method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
                payload: {
                    machineId: 'machine-a',
                    expectedGeneration: '7',
                    reference: { pluginId: 'acme.issues', localId: 'issues' },
                    trigger: '$',
                    query: 'issue',
                },
                signal: expect.any(AbortSignal),
            }));

            machineRpcWithServerScopeMock.mockClear();
            await expect(getSuggestions('s1', '@issue', {
                kinds: ['composerReference'],
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection,
                    isCurrent: () => true,
                },
            })).resolves.toEqual([]);
            expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        });

        it('discovers only a current bound reference and carries its Protocol-owned qualified selection through the existing @ picker', async () => {
            searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
            const projection = composerReferenceProjection([
                { pluginId: 'acme.issues', localId: 'issues' },
                // A stale lifecycle record must not become a second local reference
                // registry or issue a daemon call.
                {
                    pluginId: 'acme.retired',
                    localId: 'old-issues',
                    activationGeneration: '6',
                },
            ]);
            const controller = new AbortController();
            machineRpcWithServerScopeMock.mockResolvedValue({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'issue-42', label: 'Issue 42', description: 'Current sprint issue' }],
            });
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@issue', {
                kinds: ['file', 'composerReference'],
                signal: controller.signal,
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection,
                    isCurrent: () => true,
                },
            });

            expect(suggestions).toEqual([
                expect.objectContaining({
                    kind: 'file',
                    key: 'file-src/issues.ts',
                }),
                {
                    kind: 'composerReference',
                    key: 'composer-reference-["acme.issues","issues","issue-42"]',
                    text: '@"Issue 42"',
                    label: 'Issue 42',
                    group: 'Issues',
                    icon: expect.objectContaining({
                        props: expect.objectContaining({ name: 'magnifying-glass', size: 16 }),
                    }),
                    description: 'Current sprint issue · acme.issues/issues',
                    structuredInput: {
                        kind: 'happier.composerReference',
                        ref: 'composerReference:issue-42',
                        composerReference: { pluginId: 'acme.issues', localId: 'issues' },
                        label: 'Issue 42',
                    },
                },
            ]);
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-a',
                serverId: 'server-a',
                method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
                payload: {
                    machineId: 'machine-a',
                    expectedGeneration: '7',
                    reference: { pluginId: 'acme.issues', localId: 'issues' },
                    trigger: '@',
                    query: 'issue',
                },
                signal: expect.any(AbortSignal),
            }));
        });

        it('publishes built-in rows before a late reference provider and then aggregates both sections', async () => {
            searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
            let releaseReference: ((value: unknown) => void) | undefined;
            machineRpcWithServerScopeMock.mockImplementation(() => new Promise((resolve) => {
                releaseReference = resolve;
            }));
            const updates: AutocompleteSuggestion[][] = [];
            const { getSuggestions } = await importSuggestions();
            const options: NonNullable<Parameters<typeof getSuggestions>[2]> = {
                kinds: ['file', 'composerReference'],
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'issues' },
                    ]),
                    isCurrent: () => true,
                },
                onUpdate: (suggestions) => updates.push(suggestions),
            };

            const pending = getSuggestions('s1', '@issue', options);
            await vi.waitFor(() => {
                expect(updates.map((suggestions) => suggestions.map((suggestion) => suggestion.key))).toEqual([
                    ['file-src/issues.ts'],
                ]);
            });

            releaseReference?.({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'issue-42', label: 'Issue 42' }],
            });

            await expect(pending).resolves.toEqual([
                expect.objectContaining({ key: 'file-src/issues.ts' }),
                expect.objectContaining({
                    key: 'composer-reference-["acme.issues","issues","issue-42"]',
                }),
            ]);
            expect(updates.at(-1)?.map((suggestion) => suggestion.key)).toEqual([
                'file-src/issues.ts',
                'composer-reference-["acme.issues","issues","issue-42"]',
            ]);
        });

        it('publishes a healthy reference while a sibling provider remains unsettled', async () => {
            const controller = new AbortController();
            machineRpcWithServerScopeMock.mockImplementation((rawParams: unknown) => {
                const params = rawParams as Readonly<{
                    payload?: Readonly<{ reference?: Readonly<{ localId?: string }> }>;
                }>;
                if (params.payload?.reference?.localId === 'healthy') {
                    return Promise.resolve({
                        ok: true,
                        reference: { pluginId: 'acme.issues', localId: 'healthy' },
                        page: [{ id: 'issue-42', label: 'Issue 42' }],
                    });
                }
                return new Promise(() => {});
            });
            const updates: AutocompleteSuggestion[][] = [];
            const { getSuggestions } = await importSuggestions();
            const pending = getSuggestions('s1', '@issue', {
                kinds: ['composerReference'],
                signal: controller.signal,
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'healthy' },
                        { pluginId: 'acme.issues', localId: 'stalled' },
                    ]),
                    isCurrent: () => true,
                },
                onUpdate: (suggestions) => updates.push(suggestions),
            });

            try {
                await vi.waitFor(() => {
                    expect(updates.some((suggestions) => suggestions.map((suggestion) => suggestion.key).includes(
                        'composer-reference-["acme.issues","healthy","issue-42"]',
                    ))).toBe(true);
                });
            } finally {
                controller.abort();
                await pending;
            }
        });

        it('forwards cancellation to reference work and fences a result that arrives after its host retires', async () => {
            let current = true;
            let releaseSearch: ((value: unknown) => void) | undefined;
            let forwardedSignal: AbortSignal | undefined;
            machineRpcWithServerScopeMock.mockImplementation((rawParams: unknown) => {
                const params = rawParams as Readonly<{ signal?: AbortSignal }>;
                forwardedSignal = params.signal;
                return new Promise((resolve) => {
                    releaseSearch = resolve;
                });
            });
            const controller = new AbortController();
            const { getSuggestions } = await importSuggestions();

            const pending = getSuggestions('s1', '@issue', {
                kinds: ['composerReference'],
                signal: controller.signal,
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'issues' },
                    ]),
                    isCurrent: () => current,
                },
            });
            await vi.waitFor(() => {
                expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
            });
            expect(forwardedSignal).toBeInstanceOf(AbortSignal);
            expect(forwardedSignal?.aborted).toBe(false);

            current = false;
            releaseSearch?.({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'issue-42', label: 'Issue 42' }],
            });

            await expect(pending).resolves.toEqual([]);
        });

        it('aborts the in-flight reference boundary when a newer composer query supersedes it', async () => {
            let observedAbort = false;
            machineRpcWithServerScopeMock.mockImplementation((rawParams: unknown) => new Promise((_resolve, reject) => {
                const params = rawParams as Readonly<{ signal?: AbortSignal }>;
                params.signal?.addEventListener('abort', () => {
                    observedAbort = true;
                    reject(new Error('reference work aborted'));
                }, { once: true });
            }));
            const controller = new AbortController();
            const { getSuggestions } = await importSuggestions();

            const pending = getSuggestions('s1', '@issue', {
                kinds: ['composerReference'],
                signal: controller.signal,
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'issues' },
                    ]),
                    isCurrent: () => true,
                },
            });
            await vi.waitFor(() => {
                expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
            });
            controller.abort();

            await expect(pending).resolves.toEqual([]);
            expect(observedAbort).toBe(true);
            expect(logMock).not.toHaveBeenCalled();
        });

        it('fails closed against an older daemon that does not implement reference search without suppressing a healthy section', async () => {
            searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
            machineRpcWithServerScopeMock.mockRejectedValue(new Error('method not found'));
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@issue', {
                kinds: ['file', 'composerReference'],
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'issues' },
                    ]),
                    isCurrent: () => true,
                },
            });

            expect(suggestions.map((suggestion) => suggestion.key)).toEqual(['file-src/issues.ts']);
            expect(suggestions.find((suggestion) => suggestion.kind === 'composerReference')).toBeUndefined();
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('method not found'));
        });
    });

    describe('built-in same-server session references', () => {
        const PEER_SESSION = {
            id: 'cmslj08960ku1tmhrd0v4a0a7',
            title: 'Fix Detached Dev Stack Startup',
            workspaceLabel: '~/projects/app',
            agentLabel: 'codex',
            agentId: 'codex',
            updatedAt: 10,
            active: true,
        } as const;

        it('coexists with files and writes only the Protocol relative session identity', async () => {
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@session:fix', {
                catalogs: {
                    files: [file('src/fix.ts')],
                    sessions: [PEER_SESSION],
                },
            });

            expect(suggestions).toEqual([{
                kind: 'session',
                key: `session-${PEER_SESSION.id}`,
                text: '@session:fix-detached-dev-stack-startup-v4a0a7',
                label: PEER_SESSION.title,
                description: PEER_SESSION.workspaceLabel,
                icon: expect.anything(),
                structuredInput: {
                    kind: MENTION_KIND_V1.session,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, PEER_SESSION.id),
                    label: PEER_SESSION.title,
                },
            }]);
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

    describe('INV-3 — an inserted token re-parses to the kind that produced it', () => {
        it.each([
            ['file', '@sr', [file('src/foo.ts')], undefined, undefined],
            ['file with a space in its path', '@my', [file('my file.ts')], undefined, undefined],
            ['plugin', '@gma', [], undefined, undefined],
            ['plugin whose name looks like a path', '@acme', [], [{ ...GMAIL_PLUGIN, name: 'acme/formatter', vendorPluginRef: 'plugin://acme' }], undefined],
            ['skill', '$rev', [], undefined, [{ name: 'review', path: '/s/review.md' }]],
        ])('round-trips a %s token', async (_label, query, files, vendorPlugins, skills) => {
            searchFilesMock.mockImplementation(async (_scope, search) =>
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

            const [candidate] = await getSuggestions('s1', '@docs/', { workspace: WORKSPACE });
            expect(candidate?.key).toBe(`file-${fullPath}`);

            // Re-open the picker on the token the composer now holds — the state a
            // restored draft or a pasted token arrives in.
            searchFilesMock.mockClear();
            const reparsed = await getSuggestions('s1', candidate!.text, { workspace: WORKSPACE });

            expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, fullPath, expect.objectContaining({
                limit: 12,
                signal: expect.any(AbortSignal),
            }));
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

            const suggestions = await getSuggestions('s1', '@src/', { kinds: ['file'], workspace: WORKSPACE });

            expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'src/', expect.objectContaining({
                limit: 12,
                signal: expect.any(AbortSignal),
            }));
            expect(suggestions).toHaveLength(12);
        });

        it('keeps every trigger under the mounted-row ceiling', async () => {
            const { COMPOSER_SUGGESTION_TRIGGER_ROW_BUDGET, resolveComposerSuggestionKind } = await import('./composerSuggestionKinds');
            const {
                COMPOSER_SUGGESTION_KIND_IDS,
                COMPOSER_SUGGESTION_TRIGGERS,
                resolveComposerSuggestionTriggersForKind,
            } = await import('./composerSuggestionGrammar');

            for (const trigger of COMPOSER_SUGGESTION_TRIGGERS) {
                const total = COMPOSER_SUGGESTION_KIND_IDS
                    .filter((id) => resolveComposerSuggestionTriggersForKind(id).includes(trigger))
                    .reduce((sum, id) => sum + resolveComposerSuggestionKind(id).limit, 0);
                expect(total).toBeGreaterThan(0);
                expect(total).toBeLessThanOrEqual(COMPOSER_SUGGESTION_TRIGGER_ROW_BUDGET);
            }
        });
    });

    describe('a failing kind is reported, never silently empty', () => {
        it('reports a rejected slash-command search instead of returning no matches', async () => {
            // `getCommandSuggestions` used to wrap its whole body in
            // `catch { return [] }`, so a dead command-search RPC and "no command
            // starts with those letters" were the SAME observable outcome: an empty
            // picker, no diagnostic, nothing to debug. That is the silent shape that
            // let a completely dead `@` look like an empty repository. The dispatcher
            // is the one place that decision belongs, and it says so out loud.
            searchCommandsMock.mockRejectedValue(new Error('command search rpc failed'));
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '/rev');

            expect(suggestions).toEqual([]);
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('command search rpc failed'));
        });

        it('reports a rejected file search instead of returning no matches', async () => {
            searchFilesMock.mockRejectedValue(new Error('file search rpc failed'));
            const { getSuggestions } = await importSuggestions();

            const suggestions = await getSuggestions('s1', '@REA', { kinds: ['file'] });

            expect(suggestions).toEqual([]);
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('file search rpc failed'));
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

        it('aborts timed-out reference work once a healthy section is returned', async () => {
            let observedAbort = false;
            let releaseSearch: ((value: unknown) => void) | undefined;
            machineRpcWithServerScopeMock.mockImplementation((rawParams: unknown) => new Promise((resolve) => {
                releaseSearch = resolve;
                const params = rawParams as Readonly<{ signal?: AbortSignal }>;
                params.signal?.addEventListener('abort', () => {
                    observedAbort = true;
                }, { once: true });
            }));
            searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();
            const controller = new AbortController();
            const addParentListener = vi.spyOn(controller.signal, 'addEventListener');
            const removeParentListener = vi.spyOn(controller.signal, 'removeEventListener');

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@issue', {
                kinds: ['file', 'composerReference'],
                signal: controller.signal,
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'issues' },
                    ]),
                    isCurrent: () => true,
                },
            });
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);

            await expect(pending).resolves.toEqual([
                expect.objectContaining({ kind: 'file', key: 'file-src/issues.ts' }),
            ]);
            expect(observedAbort).toBe(true);
            const parentAbortHandlers = addParentListener.mock.calls
                .filter(([type]) => type === 'abort')
                .map(([, handler]) => handler);
            expect(parentAbortHandlers.length).toBeGreaterThan(0);
            for (const handler of parentAbortHandlers) {
                expect(removeParentListener).toHaveBeenCalledWith('abort', handler);
            }
            releaseSearch?.({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [],
            });
        });

        it('keeps a healthy reference row when its sibling reaches the kind deadline', async () => {
            searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
            machineRpcWithServerScopeMock.mockImplementation((rawParams: unknown) => {
                const params = rawParams as Readonly<{
                    payload?: Readonly<{ reference?: Readonly<{ localId?: string }> }>;
                }>;
                if (params.payload?.reference?.localId === 'healthy') {
                    return Promise.resolve({
                        ok: true,
                        reference: { pluginId: 'acme.issues', localId: 'healthy' },
                        page: [{ id: 'issue-42', label: 'Issue 42' }],
                    });
                }
                return new Promise(() => {});
            });
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@issue', {
                kinds: ['file', 'composerReference'],
                composerReferenceHost: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    projection: composerReferenceProjection([
                        { pluginId: 'acme.issues', localId: 'healthy' },
                        { pluginId: 'acme.issues', localId: 'stalled' },
                    ]),
                    isCurrent: () => true,
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual([
                'file-src/issues.ts',
                'composer-reference-["acme.issues","healthy","issue-42"]',
            ]);
        });

        it('keeps a cold @ query alive when every section is empty at the deadline', async () => {
            // A cold file index can take longer than the deadline. The deadline is
            // only allowed to trim a slow kind when another section already has rows;
            // otherwise the one-shot query would become permanently empty until the
            // user types another character.
            let releaseFileSearch: ((files: FileItem[]) => void) | undefined;
            searchFilesMock.mockImplementation(() => new Promise<FileItem[]>((resolve) => {
                releaseFileSearch = resolve;
            }));
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            releaseFileSearch?.([file('README.md')]);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
            // The wait is announced when it STARTS, not only when it ends. This is the
            // one state where every transport is silent and the picker is empty, so it
            // must not also be silent in the logs — that combination is what cost ten
            // minutes of a device investigation before the kind ids were nameable.
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('still waiting on file'));
        });

        it('renders a section that lands after the deadline while another kind never settles', async () => {
            // The device failure this case exists for. On a bare `@` the plugin catalog
            // RPC never answered while the file index resolved a moment after the
            // deadline; measured on an iOS dev client, one kind produced its row in
            // 12 ms and the picker was still empty ten minutes later. The case above
            // ("keeps a cold @ query alive") cannot see it: only ONE kind is pending
            // there, so "wait for ALL pending kinds" and "wait until ANY of them has
            // rows" are the same thing. Here they are not — a post-deadline wait with
            // no second bound never returns, which is D-25 inverted past the deadline.
            seedSession();
            sessionRpcWithServerScopeMock.mockImplementation(() => new Promise(() => {}));
            let releaseFileSearch: ((files: FileItem[]) => void) | undefined;
            searchFilesMock.mockImplementation(() => new Promise<FileItem[]>((resolve) => {
                releaseFileSearch = resolve;
            }));
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA');
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            releaseFileSearch?.([file('README.md')]);

            expect((await pending).map((suggestion) => suggestion.key)).toEqual(['file-README.md']);
        });

        // What a COLD `@` actually promises, and the half that is easiest to break
        // while "fixing" the other. On a fresh session every kind is past the
        // deadline: the file kind is building its index and the catalog kinds are
        // hydrating through the daemon. The query settles on the FIRST section that
        // becomes ready — it must not block on the catalogs still in flight, or the
        // picker stays empty for the whole hydration.
        //
        // But "stopped waiting on" must not become "cancelled". This dispatcher
        // ABORTS every still-pending kind the moment the cold wait finishes, and the
        // hydration it walks away from is what makes the NEXT keystroke warm. If that
        // abort ever reached the catalog RPC, a cold session would re-issue and
        // re-cancel hydration on every keystroke and never converge — an empty
        // Plugins section for as long as the user keeps typing. (remote-dev runs a
        // structurally different dispatcher and carries the twin of this case; this
        // is the contract on which the two shapes are required to agree.)
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

        it('bounds the cold empty wait at the daemon RPC ceiling and still warms the catalog', async () => {
            // The other half of the cold contract. "Outlive the deadline" must not
            // mean "wait forever": if the user stops typing, `signal` never fires and
            // a stuck transport leaves the picker pending with no completion. The
            // wait is bounded by the one real boundary underneath it — the default
            // server-scoped RPC operation timeout both the catalog hydration and the
            // file index bottom out on. Past it nothing in flight is merely slow.
            seedSession();
            storageStateMock.applySessions.mockImplementation((sessions: { id?: string }[]) => {
                for (const session of sessions) {
                    if (session.id) storageStateMock.sessions[session.id] = session;
                }
            });
            searchFilesMock.mockImplementation(() => new Promise(() => {}));
            let releaseCatalog!: (response: unknown) => void;
            sessionRpcWithServerScopeMock.mockReturnValue(new Promise((resolve) => {
                releaseCatalog = resolve;
            }));
            const {
                getSuggestions,
                COMPOSER_SUGGESTION_KIND_DEADLINE_MS,
                COMPOSER_SUGGESTION_COLD_START_GRACE_MS,
            } = await importSuggestions();
            const updates: Array<Readonly<{ rows: number; complete: boolean }>> = [];

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@gma', {
                onUpdate: (suggestions, status) => {
                    updates.push({ rows: suggestions.length, complete: status?.complete === true });
                },
            });
            let settled = false;
            void pending.then(() => { settled = true; });

            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            await Promise.resolve();
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_COLD_START_GRACE_MS + 1);
            await expect(pending).resolves.toEqual([]);
            // The picker is told the query is over rather than left pending forever.
            expect(updates.at(-1)).toEqual({ rows: 0, complete: true });
            expect(logMock).toHaveBeenCalledWith(expect.stringContaining('stopped waiting on'));

            // Walking away from the wait must not cancel the hydration that makes the
            // next keystroke warm.
            releaseCatalog({ vendorPlugins: [GMAIL_PLUGIN] });
            vi.useRealTimers();
            await vi.waitFor(() => {
                expect(storageStateMock.sessions.s1?.metadata?.sessionVendorPluginCatalogV1).toBeDefined();
            });
        });

        it('keeps the cold empty query cancellable after the deadline', async () => {
            // The continued wait must still belong to this query. A superseding
            // keystroke releases it immediately rather than allowing stale rows to
            // apply after the composer has moved on.
            searchFilesMock.mockImplementation(() => new Promise(() => {}));
            sessionRpcWithServerScopeMock.mockImplementation(() => new Promise(() => {}));
            const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await importSuggestions();
            const controller = new AbortController();

            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const pending = getSuggestions('s1', '@REA', { signal: controller.signal });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1);
            await Promise.resolve();

            expect(settled).toBe(false);
            controller.abort();
            await expect(pending).resolves.toEqual([]);
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

        it('forwards supersession cancellation to the query-owned file search', async () => {
            let observedAbort = false;
            searchFilesMock.mockImplementation((
                _scope: FileSuggestionScope | null,
                _query: string,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => new Promise<FileItem[]>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    observedAbort = true;
                    reject(new Error('file search aborted'));
                }, { once: true });
            }));
            const { getSuggestions } = await importSuggestions();
            const controller = new AbortController();

            const pending = getSuggestions('s1', '@REA', {
                kinds: ['file'],
                workspace: WORKSPACE,
                signal: controller.signal,
            });
            await vi.waitFor(() => {
                expect(searchFilesMock).toHaveBeenCalledWith(WORKSPACE, 'REA', expect.objectContaining({
                    signal: expect.any(AbortSignal),
                }));
            });

            controller.abort();

            await expect(pending).resolves.toEqual([]);
            expect(observedAbort).toBe(true);
        });
    });

    describe('R-9 — host eligible-kind subsets', () => {
        it('returns no skills for a host that does not offer the skill kind', async () => {
            seedCatalogs({ skills: [{ name: 'review', path: '/s/review.md' }] });
            const { getSuggestions } = await importSuggestions();

            const withSkills = await getSuggestions('s1', '$rev', { kinds: ['file', 'vendorPlugin', 'skill', 'slashCommand'] });
            const withoutSkills = await getSuggestions('s1', '$rev', { kinds: ['file', 'vendorPlugin', 'slashCommand'] });

            expect(withSkills.map((suggestion) => suggestion.key)).toEqual(['skill-/s/review.md:review']);
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
