import { describe, expect, it, vi, beforeEach } from 'vitest';

const machineScmLogListSpy = vi.fn();

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmLogList: (...args: unknown[]) => machineScmLogListSpy(...args),
}));

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { ScmLogEntry } from '@happier-dev/protocol/scm';

import { searchWorkspaceCommits } from './searchWorkspaceCommits';

const SCOPE = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' } as const;

function makeEntry(sha: string): ScmLogEntry {
    return {
        sha,
        shortSha: sha.slice(0, 12),
        authorName: 'Ada Lovelace',
        authorEmail: 'ada@example.com',
        timestamp: 1_767_225_600_000,
        subject: 'feat: cache layer',
        body: 'feat: cache layer',
    };
}

describe('searchWorkspaceCommits', () => {
    beforeEach(() => {
        machineScmLogListSpy.mockReset();
    });

    it('issues the bounded query against the exact current workspace scope and reports matches', async () => {
        const controller = new AbortController();
        machineScmLogListSpy.mockResolvedValue({
            success: true,
            entries: [makeEntry('c'.repeat(40))],
            queryApplied: true,
        });

        const outcome = await searchWorkspaceCommits({
            scope: SCOPE,
            accountId: 'account-a',
            query: 'cache layer',
            limit: 20,
            signal: controller.signal,
        });

        expect(outcome).toEqual({
            status: 'matches',
            entries: [makeEntry('c'.repeat(40))],
        });
        expect(machineScmLogListSpy).toHaveBeenCalledTimes(1);
        expect(machineScmLogListSpy).toHaveBeenCalledWith(
            'm1',
            { cwd: '/repo', query: 'cache layer', limit: 20 },
            { serverId: 'server-a', accountId: 'account-a', signal: controller.signal },
        );
    });

    it('labels the bounded recent page honestly when an older daemon ignored the query', async () => {
        // Old-daemon bytes: the query field is stripped and no `queryApplied` echo exists. The
        // returned page is the recent log — never presented as query matches.
        machineScmLogListSpy.mockResolvedValue({
            success: true,
            entries: [makeEntry('a'.repeat(40)), makeEntry('b'.repeat(40))],
        });

        const outcome = await searchWorkspaceCommits({
            scope: SCOPE,
            query: 'cache layer',
            limit: 20,
        });

        expect(outcome).toEqual({
            status: 'recentOnly',
            entries: [makeEntry('a'.repeat(40)), makeEntry('b'.repeat(40))],
        });
    });

    it.each([
        ['machine is offline', SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, 'backendUnavailable', 'Machine RPC method not available'],
        ['workspace root is not a repository', SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY, 'notRepository', 'not a repository'],
        ['daemon does not implement the SCM method', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, 'unsupported', 'Method not found'],
        ['workspace root is missing', SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND, 'rootNotFound', 'root missing'],
        ['machine did not answer the read', SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED, 'unreachable', 'network'],
        ['machine read timed out', SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT, 'unreachable', 'timeout'],
        ['failure carries no recognised code', undefined, 'error', 'boom'],
    ])('fails typed when the %s', async (_title, errorCode, reason, error) => {
        machineScmLogListSpy.mockResolvedValue({ success: false, error, errorCode });

        const outcome = await searchWorkspaceCommits({
            scope: SCOPE,
            query: 'cache layer',
            limit: 20,
        });

        expect(outcome).toEqual({ status: 'unavailable', reason, message: error });
    });

    it('propagates cancellation instead of masking it as an unavailable workspace', async () => {
        const controller = new AbortController();
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
        machineScmLogListSpy.mockRejectedValue(abortError);

        await expect(searchWorkspaceCommits({
            scope: SCOPE,
            query: 'cache layer',
            limit: 20,
            signal: controller.signal,
        })).rejects.toBe(abortError);
    });

    it('suppresses a response after the captured Account lifetime retires', async () => {
        let resolveResponse!: (value: unknown) => void;
        machineScmLogListSpy.mockImplementationOnce(() => new Promise((resolve) => {
            resolveResponse = resolve;
        }));
        let current = true;
        const pending = searchWorkspaceCommits({
            scope: SCOPE,
            accountId: 'account-a',
            accountIsCurrent: () => current,
            query: 'private',
        });
        await vi.waitFor(() => expect(machineScmLogListSpy).toHaveBeenCalledTimes(1));

        current = false;
        resolveResponse({ success: true, entries: [makeEntry('d'.repeat(40))], queryApplied: true });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('refuses to search without an exact workspace scope and never falls back to an arbitrary workspace', async () => {
        for (const missing of [
            null,
            { serverId: '', machineId: 'm1', rootPath: '/repo' },
            { serverId: 'server-a', machineId: '', rootPath: '/repo' },
            { serverId: 'server-a', machineId: 'm1', rootPath: '   ' },
        ]) {
            const outcome = await searchWorkspaceCommits({
                scope: missing as typeof SCOPE | null,
                query: 'cache layer',
                limit: 20,
            });

            expect(outcome).toEqual({
                status: 'unavailable',
                reason: 'noWorkspaceScope',
            });
        }
        expect(machineScmLogListSpy).not.toHaveBeenCalled();
    });
});
