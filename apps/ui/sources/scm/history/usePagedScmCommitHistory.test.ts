import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ScmLogEntry } from '@happier-dev/protocol/scm';

import { renderHook } from '@/dev/testkit';

import { usePagedScmCommitHistory } from './usePagedScmCommitHistory';

const entry: ScmLogEntry = {
    sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'Author', authorEmail: '',
    timestamp: 1, subject: 'Recovered history', body: '',
};

describe('usePagedScmCommitHistory failure recovery', () => {
    it.each(['unsuccessful response', 'destroyed stream'] as const)('settles a failed first read (%s) and recovers through the existing loader', async (failure) => {
        // loadPage is the RPC boundary; the paging, failure state and retry path remain real.
        const loadPage = vi.fn<Parameters<typeof usePagedScmCommitHistory>[0]['loadPage']>()
            .mockResolvedValue({ success: true, entries: [entry] });
        if (failure === 'destroyed stream') loadPage.mockRejectedValueOnce(Object.assign(new Error('Stream destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
        else loadPage.mockResolvedValueOnce({ success: false });
        const hook = await renderHook(() => usePagedScmCommitHistory({ enabled: true, historyIdentity: 'repo', loadPage }));
        try {
            await act(async () => { await expect(hook.getCurrent().loadCommitHistory({ reset: true })).resolves.toBeUndefined(); });
            expect(hook.getCurrent().historyLoading).toBe(false);
            expect(hook.getCurrent().historyError).toBe(true);
            expect(hook.getCurrent().historyEntries).toEqual([]);
            await act(async () => { await hook.getCurrent().loadCommitHistory({ reset: true }); });
            expect(hook.getCurrent().historyError).toBe(false);
            expect(hook.getCurrent().historyEntries).toEqual([entry]);
        } finally { await hook.unmount(); }
    });

    it('keeps loaded commits visible on a refresh failure and clears the failure for a different history identity', async () => {
        const loadPage = vi.fn<Parameters<typeof usePagedScmCommitHistory>[0]['loadPage']>()
            .mockResolvedValueOnce({ success: true, entries: [entry] })
            .mockResolvedValue({ success: false });
        const hook = await renderHook(({ historyIdentity }) => usePagedScmCommitHistory({ enabled: true, historyIdentity, loadPage }), {
            initialProps: { historyIdentity: 'repo-a' },
        });
        try {
            await act(async () => { await hook.getCurrent().loadCommitHistory({ reset: true }); });
            await act(async () => { await hook.getCurrent().loadCommitHistory({ reset: true }); });
            expect(hook.getCurrent().historyError).toBe(true);
            expect(hook.getCurrent().historyEntries).toEqual([entry]);
            await hook.rerender({ historyIdentity: 'repo-b' });
            expect(hook.getCurrent().historyError).toBe(false);
            expect(hook.getCurrent().historyEntries).toEqual([]);
        } finally { await hook.unmount(); }
    });
});
