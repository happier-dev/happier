import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS, type PluginProjectionV2 } from '@happier-dev/protocol';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { FileItem, FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import {
    NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
    SESSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerReferenceSearchHost,
    type ComposerSuggestionKindId,
} from './composerSuggestionKinds';
import type { ActiveSuggestionsHandler } from './useActiveSuggestions';
import type { AutocompleteSuggestion } from './autocompleteTypes';

/**
 * The composer suggestion picker, wired the way a host wires it.
 *
 * Every other suite in this folder stops at `getSuggestions`. That is exactly how
 * `@` shipped completely dead in the sibling repo with 242 green tests: the
 * dispatcher's unit tests asserted the contract the dispatcher was written to, and
 * nobody asked what the picker did with it. This suite runs the real chain a
 * composer runs —
 *
 *   composer text → `findActiveWord` (host kinds)
 *                 → `useActiveSuggestions` (one AbortController per query)
 *                 → `getSuggestions` (kind fan-out, deadline, per-kind budget)
 *                 → `useAgentInputCommandMenu` → `CommandMenuItem[]` + `open`
 *
 * — and asserts what the user sees: whether the picker opens and what is in it.
 * Only true system boundaries are mocked (file search, command search, daemon RPC,
 * session storage); every module between the keystroke and the menu item is real.
 */

const searchFilesMock = vi.hoisted(() => vi.fn(
    async (_sessionId: string, _query: string, _options?: Readonly<{ limit?: number }>): Promise<FileItem[]> => [],
));
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, {
        id?: string;
        serverId?: string;
        active?: boolean;
        metadata?: Record<string, unknown>;
    }>,
    sessionListRowStateByServerId: {} as Record<string, Record<string, unknown>>,
    machines: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn(),
    updateArtifact: vi.fn(),
}));

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => storageStateMock },
    });
});

vi.mock('@/sync/domains/input/suggestionFile', () => ({ searchFiles: searchFilesMock }));
vi.mock('@/sync/domains/input/suggestionCommands', () => ({ searchCommands: searchCommandsMock }));

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

const SESSION_ID = 's1';

/** The machine + folder the new-session composer has picked, before any session exists. */
const NEW_SESSION_WORKSPACE: FileSuggestionScope = {
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo',
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

function composerReferenceHost(): ComposerReferenceSearchHost {
    const projection: PluginProjectionV2 = {
        v: 2,
        generation: 7,
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
            generation: 7,
            contributions: [{
                version: 1,
                contribution: {
                    kind: 'localId',
                    pluginId: 'acme.issues',
                    family: 'composerReferences',
                    qualifiedId: 'acme.issues/issues',
                    localId: 'issues',
                },
                stability: 'experimental',
                progression: { declared: true, normalized: true, merged: true },
                registration: { requirement: 'required', state: 'bound', generation: '7' },
                activation: { state: 'active', generation: '7' },
                projection: { state: 'projected' },
                presentation: {
                    kind: 'composerReference',
                    title: 'Issues',
                    icon: 'search',
                    triggers: ['@'],
                },
                consumer: 'composer-reference-host',
                platforms: ['cli', 'web'],
                diagnostics: [],
            }],
            diagnostics: [],
        },
        diagnostics: [],
    };
    return {
        machineId: 'machine-a',
        serverId: 'server-a',
        projection,
        isCurrent: () => true,
    };
}

/**
 * The session composer's suggestion pipeline, assembled from the same modules and
 * in the same order as `AgentInput` + `SessionView`.
 */
async function renderComposerPicker(
    initialText: string,
    composerReferenceHost?: ComposerReferenceSearchHost | null,
) {
    const { findActiveWord } = await import('./findActiveWord');
    const { useActiveSuggestions } = await import('./useActiveSuggestions');
    const { getSuggestions } = await import('./suggestions');
    const { useAgentInputCommandMenu } = await import(
        '@/components/sessions/agentInput/commandMenu/useAgentInputCommandMenu'
    );

    // `SessionView.handleAutocompleteSuggestions`, verbatim.
    const handler = (query: string, signal: AbortSignal) => getSuggestions(SESSION_ID, query, {
        kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
        signal,
        composerReferenceHost,
    });

    return await renderComposerPickerWithHandler({
        initialText,
        kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
        handler,
    });
}

/**
 * The NEW-session composer's pipeline: the same chain, wired the way
 * `useNewSessionScreenModel` wires it — no session id, the spawn target's server declared, and
 * the machine + folder the user picked. It runs the registry's real eligibility list, so
 * dropping a kind from that list stops this picker offering it.
 */
async function renderNewSessionComposerPicker(
    initialText: string,
    composerReferenceHost?: ComposerReferenceSearchHost | null,
) {
    const { getSuggestions } = await import('./suggestions');

    const handler = (query: string, signal: AbortSignal) => getSuggestions(null, query, {
        kinds: NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
        serverId: 'server-a',
        workspace: NEW_SESSION_WORKSPACE,
        signal,
        composerReferenceHost,
    });

    return await renderComposerPickerWithHandler({
        initialText,
        kinds: NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
        handler,
    });
}

async function renderComposerPickerWithHandler(args: Readonly<{
    initialText: string;
    kinds: readonly ComposerSuggestionKindId[];
    handler: ActiveSuggestionsHandler;
    handleSuggestionSelect?: (index: number) => void;
}>) {
    const { findActiveWord } = await import('./findActiveWord');
    const { useActiveSuggestions } = await import('./useActiveSuggestions');
    const { useAgentInputCommandMenu } = await import(
        '@/components/sessions/agentInput/commandMenu/useAgentInputCommandMenu'
    );
    const { initialText, kinds, handler } = args;
    const handleSuggestionSelect = args.handleSuggestionSelect ?? (() => {});

    return await renderHook(
        ({ text }: { text: string }) => {
            const activeWordState = findActiveWord(
                text,
                { start: text.length, end: text.length },
                kinds,
            );
            const activeWord = activeWordState?.activeWord ?? null;
            const [suggestions, selected, moveUp, moveDown, selectionPending] = useActiveSuggestions(
                activeWord,
                handler,
                { wrapAround: true },
            );
            return useAgentInputCommandMenu({
                suggestions,
                selected,
                selectionPending,
                activeWord,
                activeWordRange: activeWordState
                    ? { start: activeWordState.offset, end: activeWordState.endOffset }
                    : null,
                inputTextLength: text.length,
                moveUp,
                moveDown,
                handleSuggestionSelect,
            });
        },
        { initialProps: { text: initialText } },
    );
}

function labelsByGroup(items: readonly { group?: string; label: string }[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const item of items) {
        const group = item.group ?? '(none)';
        (out[group] ??= []).push(item.label);
    }
    return out;
}

describe('composer suggestion picker — host wiring', () => {
    beforeEach(() => {
        vi.useRealTimers();
        searchFilesMock.mockReset();
        searchFilesMock.mockResolvedValue([]);
        searchCommandsMock.mockReset();
        searchCommandsMock.mockResolvedValue([]);
        sessionRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerScopeMock.mockResolvedValue({});
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({});
        storageStateMock.applySessions.mockReset();
        storageStateMock.machines = {};
        storageStateMock.sessions = {
            [SESSION_ID]: {
                id: SESSION_ID,
                serverId: 'server-a',
                active: true,
                metadata: {
                    path: '/repo',
                    sessionVendorPluginCatalogV1: { vendorPlugins: [] },
                },
            },
        };
        storageStateMock.sessionListRowStateByServerId = {};
    });

    it('opens the picker with the Files section for a warm session', async () => {
        searchFilesMock.mockResolvedValue([file('README.md')]);

        const hook = await renderComposerPicker('@REA');
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.files': ['@README.md'],
        });
    });

    /**
     * The capability the `'__new_session__'` sentinel used to make impossible: it faked a
     * session so the session-addressed lookups would accept a call, and every one of them
     * then answered for no session, so `@` offered nothing at all before spawn. These two
     * cases are the only proof that `@` and `@session` reach a user who has not created the
     * session yet — the screen model's own suites never exercise its suggestion handler.
     */
    it('offers Files to the new-session composer, addressed by the picked machine and folder', async () => {
        searchFilesMock.mockResolvedValue([file('README.md')]);

        const hook = await renderNewSessionComposerPicker('@REA');
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.files': ['@README.md'],
        });
        // There is no session to resolve a workspace from, so the scope the host picked is
        // the only thing that can address the search.
        expect(searchFilesMock).toHaveBeenCalledWith(NEW_SESSION_WORKSPACE, 'REA', expect.objectContaining({
            limit: 12,
            signal: expect.any(AbortSignal),
        }));
    });

    it('offers the declared spawn server\'s Sessions to the new-session composer, excluding nothing', async () => {
        storageStateMock.sessionListRowStateByServerId = {
            'server-a': {
                [SESSION_ID]: {
                    id: SESSION_ID,
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 2_000,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: { name: 'Fix Detached Dev Stack Startup', path: '/repo' },
                },
            },
        };

        const hook = await renderNewSessionComposerPicker('@session:fix');
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.sessions': ['Fix Detached Dev Stack Startup'],
        });
    });

    it('renders a current plugin reference before the new session exists', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: true,
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            page: [{ id: 'issue-42', label: 'Issue 42' }],
        });

        const hook = await renderNewSessionComposerPicker('@issue', composerReferenceHost());
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            Issues: ['Issue 42'],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: expect.objectContaining({
                expectedGeneration: '7',
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                trigger: '@',
                query: 'issue',
            }),
            signal: expect.any(AbortSignal),
        }));
    });

    it('offers a same-server Session through the actual SessionView eligible-kind list', async () => {
        storageStateMock.sessionListRowStateByServerId = {
            'server-a': {
                cmslj08960ku1tmhrd0v4a0a7: {
                    id: 'cmslj08960ku1tmhrd0v4a0a7',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1_000,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: {
                        name: 'Fix Detached Dev Stack Startup',
                        path: '/Users/dev/projects/app',
                    },
                },
            },
        };

        const hook = await renderComposerPicker('@session:fix');
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.sessions': ['Fix Detached Dev Stack Startup'],
        });
    });

    it('renders a current reference under its declared section through the same session-composer handler', async () => {
        searchFilesMock.mockResolvedValue([file('src/issues.ts')]);
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: true,
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            page: [{ id: 'issue-42', label: 'Issue 42' }],
        });

        const hook = await renderComposerPicker('@issue', composerReferenceHost());
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.files': ['@src/issues.ts'],
            Issues: ['Issue 42'],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: expect.objectContaining({
                expectedGeneration: '7',
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                trigger: '@',
                query: 'issue',
            }),
            signal: expect.any(AbortSignal),
        }));
    });

    // Every eligible kind for `@` is slower than the deadline on a session's first
    // query: the file kind builds its index through a daemon ripgrep RPC, which
    // measured 3-26 s on a live host, and the plugin catalog is a second RPC. The
    // deadline exists so a hung kind cannot hide a HEALTHY one; treated as a hard
    // cut-off it hides everything, discards results that land moments later, and
    // leaves a picker that never opens and never retries — `getSuggestions` settles
    // once per query. `/` is unaffected because slash commands resolve locally,
    // which is exactly the asymmetry the sibling repo's users reported.
    it('still opens once a slow kind lands, when the deadline would leave nothing to show', async () => {
        const files = createDeferred<FileItem[]>();
        const catalog = createDeferred<unknown>();
        searchFilesMock.mockReturnValue(files.promise);
        sessionRpcWithServerScopeMock.mockReturnValue(catalog.promise as never);

        const { COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await import('./suggestions');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const hook = await renderComposerPicker('@REA');
        await flushHookEffects({ advanceTimersMs: COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1 });

        // Nothing has arrived yet, so there is nothing to show either way.
        expect(hook.getCurrent().commandMenuOpen).toBe(false);

        files.resolve([file('README.md')]);
        catalog.resolve({ vendorPlugins: [] });
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.files': ['@README.md'],
        });
    });

    // D-25's own guarantee, at the wiring boundary this time: the trim still happens
    // when trimming leaves something to render. Without it the hung plugin catalog
    // would hold the whole picker closed.
    it('opens with the healthy section at the deadline while another kind is still hung', async () => {
        searchFilesMock.mockResolvedValue([file('README.md')]);
        sessionRpcWithServerScopeMock.mockImplementation(() => new Promise(() => {}));
        storageStateMock.sessions[SESSION_ID]!.metadata = { path: '/repo' };

        const { COMPOSER_SUGGESTION_KIND_DEADLINE_MS } = await import('./suggestions');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const hook = await renderComposerPicker('@REA');
        await flushHookEffects({ advanceTimersMs: COMPOSER_SUGGESTION_KIND_DEADLINE_MS + 1 });

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.files': ['@README.md'],
        });
    });

    // The reported asymmetry, pinned: `/` shares the whole chain with `@` and must
    // keep working while `@`'s kinds are still resolving.
    it('opens the Commands section for a slash trigger', async () => {
        searchCommandsMock.mockResolvedValue([{ command: 'review' }]);

        const hook = await renderComposerPicker('/rev');
        await flushHookEffects();

        expect(hook.getCurrent().commandMenuOpen).toBe(true);
        expect(labelsByGroup(hook.getCurrent().items)).toEqual({
            'agentInput.suggestionGroups.commands': ['/review'],
        });
    });

    it('commits the same candidate identity after a late section settlement moves its row', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (query === '@n' ? second.promise : first.promise));
        const handleSuggestionSelect = vi.fn();
        const candidate = { kind: 'vendorPlugin', key: 'notes', text: '@notes' } as const;

        const hook = await renderComposerPickerWithHandler({
            initialText: '@',
            kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
            handler,
            handleSuggestionSelect,
        });
        first.resolve([
            { kind: 'file', key: 'README.md', text: '@README.md' },
            candidate,
        ]);
        await flushHookEffects();
        await act(async () => { hook.getCurrent().moveDown(); });
        expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.id).toBe('vendorPlugin:notes');

        await hook.rerender({ text: '@n' });
        second.resolve([
            { kind: 'file', key: 'notes-a', text: '@notes-a' },
            { kind: 'file', key: 'notes-b', text: '@notes-b' },
            candidate,
        ]);
        await flushHookEffects();
        expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.id).toBe('vendorPlugin:notes');

        hook.getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenCalledWith(2);
    });

    it('commits the same candidate after an incremental provider settlement moves its row', async () => {
        const final = createDeferred<AutocompleteSuggestion[]>();
        let publish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        const handleSuggestionSelect = vi.fn();
        const candidate = { kind: 'composerReference', key: 'issue-42', text: '@"Issue 42"' } as const;
        const handler = vi.fn((
            _query: string,
            _signal: AbortSignal,
            onUpdate?: (suggestions: AutocompleteSuggestion[]) => void,
        ) => {
            publish = onUpdate;
            return final.promise;
        });

        const hook = await renderComposerPickerWithHandler({
            initialText: '@issue',
            kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
            handler,
            handleSuggestionSelect,
        });
        await flushHookEffects();
        expect(publish).toBeTypeOf('function');
        if (!publish) throw new Error('expected incremental suggestion publisher');

        await act(async () => {
            publish?.([
                { kind: 'file', key: 'issues.ts', text: '@issues.ts' },
                candidate,
            ]);
        });
        await flushHookEffects();
        await act(async () => { hook.getCurrent().moveDown(); });
        expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.id).toBe('composerReference:issue-42');

        // Do not turn an explicit reference choice into the first File row while
        // the current provider is still settling. Enter must stay inert here.
        await act(async () => {
            publish?.([
                { kind: 'file', key: 'issue-a.ts', text: '@issue-a.ts' },
                { kind: 'file', key: 'issue-b.ts', text: '@issue-b.ts' },
            ]);
        });
        await flushHookEffects();

        expect(hook.getCurrent().selectedIndex).toBe(-1);
        hook.getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).not.toHaveBeenCalled();

        await act(async () => {
            publish?.([
                { kind: 'file', key: 'issue-a.ts', text: '@issue-a.ts' },
                { kind: 'file', key: 'issue-b.ts', text: '@issue-b.ts' },
                candidate,
            ]);
        });
        await flushHookEffects();

        expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.id).toBe('composerReference:issue-42');
        hook.getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenCalledWith(2);

        final.resolve([
            { kind: 'file', key: 'issue-a.ts', text: '@issue-a.ts' },
            { kind: 'file', key: 'issue-b.ts', text: '@issue-b.ts' },
            candidate,
        ]);
        await flushHookEffects();
    });
});
