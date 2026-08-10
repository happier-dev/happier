import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { FileItem } from '@/sync/domains/input/suggestionFile';

/**
 * The composer suggestion picker, wired the way a host wires it.
 *
 * Every other suite in this folder stops at `getSuggestions`. That is exactly how
 * `@` shipped completely dead with 242 green tests: the dispatcher's unit tests
 * asserted the contract the dispatcher was written to, and nobody asked what the
 * picker did with it. This suite runs the real chain a composer runs —
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
    sessions: {} as Record<string, { id?: string; active?: boolean; metadata?: Record<string, unknown> }>,
    machines: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    getProjectForSession: vi.fn(),
    applySessions: vi.fn(),
    updateArtifact: vi.fn(),
}));

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock()();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { installStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return installStorageModuleStub({
        storage: { getState: () => storageStateMock },
    })();
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
const WORKSPACE = { machineId: 'machine-a', path: '/repo', serverId: 'server-a' } as const;

/** `SessionView.tsx`'s constant, verbatim — the session composer's eligible kinds. */
const SESSION_COMPOSER_SUGGESTION_KINDS = ['file', 'vendorPlugin', 'skill', 'slashCommand'] as const;

function file(fullPath: string): FileItem {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        fileName,
        filePath: fullPath.slice(0, fullPath.length - fileName.length),
        fullPath,
        fileType: 'file',
    } as FileItem;
}

/**
 * The session composer's suggestion pipeline, assembled from the same modules and
 * in the same order as `AgentInput` + `SessionView`.
 */
async function renderComposerPicker(initialText: string) {
    const { findActiveWord } = await import('./findActiveWord');
    const { useActiveSuggestions } = await import('./useActiveSuggestions');
    const { getSuggestions } = await import('./suggestions');
    const { useAgentInputCommandMenu } = await import(
        '@/components/sessions/agentInput/commandMenu/useAgentInputCommandMenu'
    );

    // `SessionView.handleAutocompleteSuggestions`, verbatim.
    const handler = (query: string, signal: AbortSignal) => getSuggestions(SESSION_ID, query, {
        kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
        workspace: WORKSPACE,
        signal,
    });

    return await renderHook(
        ({ text }: { text: string }) => {
            const activeWordState = findActiveWord(
                text,
                { start: text.length, end: text.length },
                SESSION_COMPOSER_SUGGESTION_KINDS,
            );
            const activeWord = activeWordState?.activeWord ?? null;
            const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(
                activeWord,
                handler,
                { wrapAround: true },
            );
            return useAgentInputCommandMenu({
                suggestions,
                selected,
                activeWord,
                activeWordRange: activeWordState
                    ? { start: activeWordState.offset, end: activeWordState.endOffset }
                    : null,
                inputTextLength: text.length,
                moveUp,
                moveDown,
                handleSuggestionSelect: React.useCallback(() => {}, []),
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
                active: true,
                metadata: {
                    path: '/repo',
                    sessionVendorPluginCatalogV1: { vendorPlugins: [] },
                },
            },
        };
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

    // THE P0. Every eligible kind for `@` is slower than the deadline on a session's
    // first query: the file kind builds its index through a daemon ripgrep RPC, which
    // measured 3-26 s on a live host, and the plugin catalog is a second RPC. The
    // deadline exists so a hung kind cannot hide a HEALTHY one; with no healthy kind
    // it hid everything, discarded results that landed moments later, and left a
    // picker that never opened and never retried. `/` was unaffected because slash
    // commands resolve locally, which is exactly the asymmetry that was reported.
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
});
