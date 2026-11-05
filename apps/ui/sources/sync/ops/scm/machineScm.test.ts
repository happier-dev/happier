import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/sync/domains/settings/settings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { SCM_OPERATION_ERROR_CODES, SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { createHash } from 'node:crypto';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let serverId: string;
function setScmSettings(fixture: Readonly<{ settings: Partial<Settings> }>) {
    storage.setState({ settings: { ...storage.getState().settings, ...fixture.settings } });
}

type MachineScmTestCall = (machineId: string, request: Record<string, unknown>) => Promise<unknown>;

// The in-place confirmation is the only mocked boundary; the Action executor and policy stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));


describe('machineScm', () => {
    beforeEach(async () => {
        await harness.reset();
        serverId = await harness.addHome({ name: 'SCM Home', serverUrl: 'https://scm.example', accountId: 'account-b',
            serverIdentityId: 'srv_scm', currentAccount: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-b' };
        storage.setState({ settingsScope: scope, profileScope: scope });
        // Ordinary no-explicit-Home facades consume the applied Account runtime,
        // not merely the device's persisted Home selection.
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    });
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        standardCleanup();
    });

    it('keeps blame alignment failures and validates commit indexes at the Machine transport boundary', async () => {
        const { machineScmBlameFile } = await import('../machineScmBlame');
        const request = { cwd: '/repo', path: 'file', expectedHash: '1'.repeat(64) };
        machineRpcWithServerScopeMock.mockResolvedValue({ success: false, errorCode: 'stale_file' });
        expect(await machineScmBlameFile('machine', request)).toEqual({ success: false, errorCode: 'stale_file' });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine', method: 'scm.blame.file', payload: { ...request, outcomeVersion: 1 },
        }));
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, ranges: [{ startLine: 1, lineCount: 1, commitIndex: 0 }], commits: [] });
        expect(await machineScmBlameFile('machine', request)).toMatchObject({
            success: false, errorCode: 'COMMAND_FAILED', actionErrorCode: 'invalid_action_output',
        });
    });

    it('delivers exact revision bytes through the scoped SCM read and rejects altered content', async () => {
        const { fetchWorkspaceFileAtRevision } = await import('@/scm/files/fetchWorkspaceFileAtRevision');
        const bytes = Buffer.from([0, 255, 128, 13, 10]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const response = { success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256 };
        machineRpcWithServerScopeMock.mockResolvedValue(response);
        const request = { scope: { serverId, machineId: 'machine-1', rootPath: '/repo' }, path: 'picture.png',
            selector: { blobId: 'a'.repeat(40) }, maxBytes: 16 * 1024 * 1024 };
        const read = await fetchWorkspaceFileAtRevision(request);
        expect(read).toEqual({ success: true, bytes: new Uint8Array(bytes), sizeBytes: bytes.length, sha256 });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1', serverId, method: RPC_METHODS.SCM_FILE_READ,
            payload: expect.objectContaining({ cwd: '/repo', path: request.path, selector: request.selector, maxBytes: request.maxBytes }),
        }));
        machineRpcWithServerScopeMock.mockResolvedValue({ ...response, contentBase64: Buffer.from([0, 254, 128, 13, 10]).toString('base64') });
        expect(await fetchWorkspaceFileAtRevision(request)).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: false, errorCode: 'not_found' });
        expect(await fetchWorkspaceFileAtRevision(request)).toEqual({ success: false, errorCode: 'not_found' });
    });

    it('turns a revision read into the shared preview source and clears it when the selection changes', async () => {
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        // Load the real CLI fixture under Vitest's importer-aware aliases, without
        // rooting the CLI program in the UI TypeScript compiler's alias space.
        const scmHarnessSource = '../../../../../cli/src/scm/rpc/__tests__/testRpcHarness';
        const { createTestGitRpcManager, runGit } = await vi.importActual<{
            createTestGitRpcManager(input: Readonly<{ workingDirectory: string }>): {
                call(method: string, request: unknown): Promise<unknown>;
            };
            runGit(cwd: string, args: string[]): string;
        }>(scmHarnessSource);
        const { Platform } = await import('react-native');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const { useFileAtRevisionPreview } = await import('@/components/ui/media/useFileAtRevisionPreview');
        const previousPlatform = Platform.OS;
        const bytes = Buffer.from([0, 255, 128, 13, 10]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const root = await mkdtemp(join(tmpdir(), 'happier-revision-preview-'));
        try {
            runGit(root, ['init']);
            runGit(root, ['config', 'user.name', 'Revision Preview']);
            runGit(root, ['config', 'user.email', 'revision-preview@example.test']);
            await writeFile(join(root, 'committed.png'), bytes);
            await writeFile(join(root, 'archive.zip'), bytes);
            runGit(root, ['add', '--', 'committed.png', 'archive.zip']);
            runGit(root, ['commit', '-m', 'preview']);
            const blobId = runGit(root, ['rev-parse', 'HEAD:committed.png']);
            await writeFile(join(root, 'committed.png'), Buffer.from([1, 2, 3]));
            const rpc = createTestGitRpcManager({ workingDirectory: root });
            // Replace only the encrypted network transport, not the Action/backend/preview owners.
            machineRpcWithServerScopeMock.mockImplementation(({ method, payload }) => rpc.call(method, payload));
            setScmSettings({ settings: { filesImagePreviewMaxBytes: 1024, filesImagePreviewCacheMaxEntries: 0 } });
            const input: Parameters<typeof useFileAtRevisionPreview>[0] = {
                enabled: true, scope: { serverId, machineId: 'machine-preview', rootPath: root },
                path: 'committed.png', selector: { blobId }, mimeType: 'image/png',
            };
            Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
            const hook = await renderHook(props => useFileAtRevisionPreview(props), { initialProps: input });
            try {
                await vi.waitFor(async () => {
                    await flushHookEffects();
                    expect(hook.getCurrent().status).toBe('loaded');
                });
                const loaded = hook.getCurrent();
                if (loaded.status !== 'loaded') throw new Error('Expected committed preview');
                expect(loaded.sha256).toBe(sha256);
                expect(new Uint8Array(await (await fetch(loaded.uri)).arrayBuffer())).toEqual(new Uint8Array(bytes));
                await hook.rerender({ ...input, path: 'removed.png', selector: { side: 'before', area: 'both' } });
                await vi.waitFor(async () => {
                    await flushHookEffects();
                    expect(hook.getCurrent()).toMatchObject({ status: 'error', uri: null, errorCode: 'not_found' });
                });
                // A successful revision read must not erase the materializer's unsupported verdict.
                await hook.rerender({ ...input, path: 'archive.zip', mimeType: 'application/zip' });
                await vi.waitFor(async () => {
                    await flushHookEffects();
                    expect(hook.getCurrent()).toMatchObject({ status: 'error', uri: null, errorCode: 'unsupported' });
                });
            } finally {
                await hook.unmount();
            }
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs SCM status snapshot through server-scoped machine RPC with the requested cwd and backend preference', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        const response = await machineScmStatusSnapshot('machine-1', {
            cwd: '/repo',
        });

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: {
                cwd: '/repo',
                outcomeVersion: 1,
                operationStateVersion: 1,
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
            timeoutMs: undefined,
        }));
    });

    it('keeps an internal read failure distinct from an unavailable RPC method and display copy', async () => {
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockRejectedValue(
            new TypeError("Cannot read properties of undefined (reading 'emit')"),
        );

        const { machineScmStatusSnapshot } = await import('./machineScm');
        const response = await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(response).toEqual({
            success: false,
            error: 'Source control command failed. Refresh repository status and try again.',
            errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
            diagnosticDetail: "TypeError: Cannot read properties of undefined (reading 'emit')",
        });
        expect(response.error).not.toContain('emit');
    });

    it('forwards a projected packed backend preference through the canonical SCM request', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                cwd: '/repo',
                outcomeVersion: 1,
                operationStateVersion: 1,
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'acme.scm/stacked',
                },
            },
        }));
    });

    it('keeps qualified first-party preferences compatible with legacy CLI backend ids', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
                scmGitRepoPreferredBackendQualifiedId: 'happier.scm.backend.git/git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { cwd: '/repo', outcomeVersion: 1, operationStateVersion: 1 },
        }));
    });

    it('threads a caller AbortSignal through machineScmLogList into the machine RPC', async () => {
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, entries: [] });
        const controller = new AbortController();

        const { machineScmLogList } = await import('./machineScm');
        const response = await machineScmLogList(
            'machine-1',
            { cwd: '/repo', limit: 20, query: 'fix login' },
            { serverId: serverId, accountId: 'account-b', signal: controller.signal },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_LOG_LIST,
            serverId: serverId,
            accountId: 'account-b',
            signal: controller.signal,
            payload: expect.objectContaining({ cwd: '/repo', query: 'fix login' }),
        }));
    });

    it.each([RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE])(
        'preserves %s refusals through strict SCM read facades without retrying', async (code) => {
            const { machineScmHistoryEntries, machineScmLogList } = await import('./machineScm');
            const reads = [
                () => machineScmHistoryEntries('machine-1', { cwd: '/repo', folder: '', paths: ['file.ts'] }),
                () => machineScmLogList('machine-1', { cwd: '/repo', limit: 20 }),
            ];
            for (const read of reads) {
                // The scoped RPC boundary rejects a reserved-code ACK; also exercise
                // Action refusal ACKs, which carry their code in a resolved envelope.
                for (const rejectedAck of [true, false]) {
                    machineRpcWithServerScopeMock.mockReset();
                    if (rejectedAck) {
                        machineRpcWithServerScopeMock.mockRejectedValue(Object.assign(new Error('Read refused'), { rpcErrorCode: code }));
                    } else {
                        machineRpcWithServerScopeMock.mockResolvedValue({ ok: false, errorCode: code, error: 'Read refused' });
                    }
                    const result = await read();
                    expect(result).toMatchObject({ success: false, actionErrorCode: code,
                        errorCode: rejectedAck ? SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE : SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED });
                    if (rejectedAck) expect(result).toHaveProperty('diagnosticDetail', 'Error: Read refused');
                    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
                }
            }
        },
    );

    it('parses scm.log.list through the canonical closed response schema', async () => {
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            entries: [],
            queryApplied: true,
            authoritativeScope: 'all-refs',
        });

        const { machineScmLogList } = await import('./machineScm');
        await expect(machineScmLogList(
            'machine-1',
            { cwd: '/repo', query: 'fix login' },
        )).rejects.toMatchObject({
            issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['authoritativeScope'] })],
        });
    });

    it('rethrows transport failure as cancellation instead of backend-unavailable when the caller aborted', async () => {
        // A cancelled commit search must reach the search adapter as an abort so the section can
        // discard it silently — not as BACKEND_UNAVAILABLE, which would render offline truth for
        // a query the user simply left.
        setScmSettings({ settings: {} });
        const controller = new AbortController();
        const transportError = new Error('socket closed');
        machineRpcWithServerScopeMock.mockImplementation(async () => {
            controller.abort();
            throw transportError;
        });

        const { machineScmLogList } = await import('./machineScm');
        await expect(machineScmLogList(
            'machine-1',
            { cwd: '/repo', query: 'fix login' },
            { serverId: serverId, signal: controller.signal },
        )).rejects.toBe(transportError);
    });

    it('maps unavailable machine-rpc failures to the standard backend unavailable SCM response', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { machineScmBranchList } = await import('./machineScm');
        const response = await machineScmBranchList('machine-1', {
            cwd: '/repo',
            includeRemotes: true,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('routes worktree create, remove, and prune through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmWorktreeCreate, machineScmWorktreePrune, machineScmWorktreeRemove } = await import('./machineScm');
        const createResponse = await machineScmWorktreeCreate('machine-1', {
            cwd: '/repo',
            displayName: 'feature-auth',
            baseRef: 'main',
        });
        const removeResponse = await machineScmWorktreeRemove('machine-1', {
            cwd: '/repo',
            worktreePath: '/repo/.dev/worktree/feature-auth',
            confirmed: true,
            authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
        });
        const pruneResponse = await machineScmWorktreePrune('machine-1', {
            cwd: '/repo',
        });

        expect(createResponse.success, JSON.stringify(createResponse)).toBe(true);
        expect(removeResponse.success, JSON.stringify(removeResponse)).toBe(true);
        expect(pruneResponse.success, JSON.stringify(pruneResponse)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_CREATE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    displayName: 'feature-auth',
                    baseRef: 'main',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_REMOVE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    worktreePath: '/repo/.dev/worktree/feature-auth',
                    confirmed: true,
                    authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_PRUNE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                },
                timeoutMs: undefined,
            }),
        );
    });

    it('passes the requested server scope through worktree creation RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmWorktreeCreate } = await import('./machineScm');
        const response = await machineScmWorktreeCreate(
            'machine-1',
            {
                cwd: '/repo',
                displayName: 'feature-auth',
            },
            { serverId: serverId },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_WORKTREE_CREATE,
            serverId: resolveServerProfileScopeIdForIdentifier(serverId),
            payload: expect.objectContaining({
                cwd: '/repo',
                displayName: 'feature-auth',
            }),
        }));
    });

    it('passes the requested server scope through non-worktree machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmBranchCreate } = await import('./machineScm');
        const response = await machineScmBranchCreate(
            'machine-1',
            {
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            },
            { serverId: serverId },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_BRANCH_CREATE,
            serverId: resolveServerProfileScopeIdForIdentifier(serverId),
            payload: expect.objectContaining({
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            }),
        }));
    });

    it('routes remote management and branch integration through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const module = await import('./machineScm');
        const machineScmRemoteAdd = (module as unknown as {
            machineScmRemoteAdd: MachineScmTestCall;
        }).machineScmRemoteAdd;
        const machineScmRemoteSetUrl = (module as unknown as {
            machineScmRemoteSetUrl: MachineScmTestCall;
        }).machineScmRemoteSetUrl;
        const machineScmBranchMerge = (module as unknown as {
            machineScmBranchMerge: MachineScmTestCall;
        }).machineScmBranchMerge;
        const machineScmBranchOperationAbort = (module as unknown as {
            machineScmBranchOperationAbort: MachineScmTestCall;
        }).machineScmBranchOperationAbort;

        await machineScmRemoteAdd('machine-1', {
            cwd: '/repo',
            name: 'origin',
            fetchUrl: '/tmp/remote.git',
        });
        await machineScmRemoteSetUrl('machine-1', {
            cwd: '/repo',
            name: 'origin',
            pushUrl: null,
        });
        await machineScmBranchMerge('machine-1', {
            cwd: '/repo',
            sourceRef: 'feature',
        });
        await machineScmBranchOperationAbort('machine-1', {
            cwd: '/repo',
            operation: 'merge',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_REMOTE_ADD,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    name: 'origin',
                    fetchUrl: '/tmp/remote.git',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_REMOTE_SET_URL,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    name: 'origin',
                    pushUrl: null,
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_BRANCH_MERGE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    sourceRef: 'feature',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    operation: 'merge',
                },
                timeoutMs: undefined,
            }),
        );
    });

    it('passes the SCM diff-commit timeout through the canonical machine RPC wrapper', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            diff: '',
        });

        const { machineScmDiffCommit } = await import('./machineScm');
        await machineScmDiffCommit('machine-1', {
            cwd: '/repo',
            commit: 'abc123',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_DIFF_COMMIT,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                commit: 'abc123',
            },
            timeoutMs: 120_000,
        }));
    });

    it('routes remove index-lock through the canonical machine SCM RPC', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            removed: true,
            reason: 'removed',
            lockPath: '/repo/.git/index.lock',
        });

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                confirmed: true,
                confirmationToken: 'remove-stale-index-lock',
            },
            timeoutMs: undefined,
        }));
    });

    it('maps remove index-lock missing machine RPC to feature unsupported response', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
    });

    it('routes pull-request read and compose operations through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ success: true, pullRequests: [] })
            .mockResolvedValueOnce({ success: true, pullRequest: null })
            .mockResolvedValueOnce({ success: true, nextAction: { kind: 'none' } });

        const module = await import('./machineScm');
        await module.machineScmPullRequestList('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
            state: 'open',
        });
        await module.machineScmPullRequestGet('machine-1', {
            cwd: '/repo',
            prReference: { number: 42 },
        });
        await module.machineScmPullRequestOpenCompose('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_LIST,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_GET,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                prReference: { number: 42 },
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        }));
    });

    it('routes pull-request open-or-reuse and repository provisioning through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ success: true, reused: true, nextAction: { kind: 'none' } })
            .mockResolvedValueOnce({ success: true, alreadyInitialized: false })
            .mockResolvedValueOnce({ success: true, auth: { state: 'authenticated', profileKind: 'provider_cli' }, defaultRepositoryName: 'repo', targets: [] })
            .mockResolvedValueOnce({ success: true, pushed: true,
                repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    nameWithOwner: 'acme/repo', webUrl: 'https://github.com/acme/repo', visibility: 'private' },
                remote: { name: 'origin', fetchUrl: 'https://github.com/acme/repo.git', pushUrl: 'https://github.com/acme/repo.git' },
            });

        const module = await import('./machineScm');
        expect(module.machineScmPullRequestOpenOrReuse).toBeTypeOf('function');
        expect(module.machineScmRepositoryInit).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryDescribePublishTargets).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryPublish).toBeTypeOf('function');

        await module.machineScmPullRequestOpenOrReuse('machine-1', {
            cwd: '/repo',
            base: 'trunk',
            head: 'feature/pr-cache',
        });
        await module.machineScmRepositoryInit('machine-1', {
            cwd: '/repo',
        });
        await module.machineScmHostingRepositoryDescribePublishTargets('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
        });
        await module.machineScmHostingRepositoryPublish('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
            owner: 'acme',
            repositoryName: 'repo',
            visibility: 'private',
            remoteName: 'origin',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'trunk',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_REPOSITORY_INIT,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                providerKind: 'github',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                providerKind: 'github',
                owner: 'acme',
                repositoryName: 'repo',
                visibility: 'private',
                remoteName: 'origin',
            },
            timeoutMs: undefined,
        }));
    });
});
