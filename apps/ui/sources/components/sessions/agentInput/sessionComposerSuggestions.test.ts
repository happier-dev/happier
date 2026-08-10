import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The existing-session half of the machine+folder addressing change.
 *
 * This runs the REAL suggestion registry, dispatcher and file-search index, and mocks only two
 * genuine boundaries: the store read that says which machine and folder a session lives on, and
 * the machine RPC transport. So it fails if the session's folder stops reaching ripgrep for any
 * reason — a host that stops passing a workspace, a scope resolved from the wrong path, or a
 * regression back to session-scoped addressing (which no longer has a transport here at all).
 */

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({} as unknown)));
const readMachineControlTargetForSessionMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: (sessionId: string) => readMachineControlTargetForSessionMock(sessionId),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
    async (importOriginal) => {
        const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedMachineRpcModuleMock({
            machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params) as never,
        })(importOriginal);
    },
);

type MachineRpcCall = Readonly<{
    machineId: string;
    serverId?: string;
    method: string;
    payload: Readonly<{ args?: string[]; cwd?: string; path?: string }>;
}>;

function machineRpcCalls(): MachineRpcCall[] {
    return machineRpcWithServerScopeMock.mock.calls.map(([params]) => params as MachineRpcCall);
}

describe('resolveSessionComposerSuggestions', () => {
    beforeEach(async () => {
        machineRpcWithServerScopeMock.mockReset();
        readMachineControlTargetForSessionMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        const { fileSearchCache } = await import('@/sync/domains/input/suggestionFile');
        fileSearchCache.clearAll();

        readMachineControlTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/machine/worktree',
            agentBasePath: '/agent/worktree',
            confidence: 'reachable',
        });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-1');
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
        });
    });

    it("searches the session's own machine folder and offers its files", async () => {
        const { resolveSessionComposerSuggestions } = await import('./sessionComposerSuggestions');

        const suggestions = await resolveSessionComposerSuggestions('s1', '@REA', {
            kinds: ['file'],
            signal: new AbortController().signal,
        });

        expect(suggestions.map((suggestion) => suggestion.text)).toContain('@README.md');

        const ripgrep = machineRpcCalls().filter((call) => call.method === 'ripgrep');
        expect(ripgrep).toHaveLength(1);
        expect(ripgrep[0]).toMatchObject({ machineId: 'machine-1', serverId: 'server-1' });
        // The folder is the addressing unit. Without an explicit cwd the daemon's machine
        // handler searches its OWN working directory (HOME), so an absent cwd is not a
        // narrower search — it is a different workspace.
        expect(ripgrep[0]?.payload.cwd).toBe('/machine/worktree');
    });

    it('searches the folder the MACHINE sees, not the one the agent sees', async () => {
        const { resolveSessionComposerSuggestions } = await import('./sessionComposerSuggestions');

        await resolveSessionComposerSuggestions('s1', '@REA', {
            kinds: ['file'],
            signal: new AbortController().signal,
        });

        // A workspace-located session's agent root is rebased for the machine; a machine RPC
        // can only act on the machine's own path.
        expect(machineRpcCalls().map((call) => call.payload.cwd)).not.toContain('/agent/worktree');
    });

    it('offers no files, and asks nothing of any machine, when the session has no reachable workspace', async () => {
        readMachineControlTargetForSessionMock.mockReturnValue(null);
        const { resolveSessionComposerSuggestions } = await import('./sessionComposerSuggestions');

        const suggestions = await resolveSessionComposerSuggestions('s1', '@REA', {
            kinds: ['file'],
            signal: new AbortController().signal,
        });

        expect(suggestions).toEqual([]);
        expect(machineRpcCalls()).toEqual([]);
    });

    it('keeps each host to its own eligible kinds', async () => {
        const { resolveSessionComposerSuggestions } = await import('./sessionComposerSuggestions');

        const suggestions = await resolveSessionComposerSuggestions('s1', '@REA', {
            kinds: ['vendorPlugin'],
            signal: new AbortController().signal,
        });

        expect(suggestions).toEqual([]);
        expect(machineRpcCalls().filter((call) => call.method === 'ripgrep')).toEqual([]);
    });
});
