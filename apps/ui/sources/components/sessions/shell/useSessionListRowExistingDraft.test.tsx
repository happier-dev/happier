import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    configureSessionDraftRepository,
    getExistingSessionDraftProjection,
    resetSessionDraftRepositoryForTests,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { useSessionListRowDraftPreview, useSessionListRowExistingDraft } from './useSessionListRowExistingDraft';

const activeScope = { serverId: 'server-row-drafts', accountId: 'account-row-drafts' };
type RowProps = Readonly<{ dataActive: boolean; serverId?: string }>;

function type(text: string): void {
    writeExistingSessionDraft({ scope: activeScope, sessionId: 'session-row', patch: { text }, materializationIntent: 'userEdit' });
}

describe('useSessionListRowExistingDraft', () => {
    afterEach(() => {
        resetSessionDraftRepositoryForTests();
    });

    it('follows the row draft live, drops it when unlisted, and freezes while the surface is inactive', async () => {
        const hook = await renderHook<{ draft: ReturnType<typeof useSessionListRowExistingDraft>['draft']; preview: string }, RowProps>((props) => {
            const row = useSessionListRowExistingDraft({
                activeScope,
                serverId: props.serverId ?? activeScope.serverId,
                sessionId: 'session-row',
                dataActive: props.dataActive,
            });
            return { draft: row.draft, preview: useSessionListRowDraftPreview(row.preview) };
        }, { initialProps: { dataActive: true } });

        expect(hook.getCurrent().draft).toBeNull();
        await act(async () => { type('hello'); });
        expect(hook.getCurrent().preview).toBe('hello');
        const draft = hook.getCurrent().draft;
        expect(draft).toEqual({ hasPreview: true });
        await act(async () => { type('hello there'); });
        expect(hook.getCurrent().preview).toBe('hello there');
        // A key changes the preview text, not the row's structure: the row's draft facts keep their identity.
        expect(hook.getCurrent().draft).toBe(draft);

        await hook.rerender({ dataActive: false });
        await act(async () => { type('typed behind a pushed screen'); });
        expect(hook.getCurrent().preview).toBe('hello there');
        await hook.rerender({ dataActive: true });
        expect(hook.getCurrent().preview).toBe('typed behind a pushed screen');

        await act(async () => { type(''); });
        expect(hook.getCurrent().draft).toBeNull();

        await act(async () => { type('another Home'); });
        await hook.rerender({ dataActive: true, serverId: 'server-elsewhere' });
        expect(hook.getCurrent().draft).toBeNull();
        await hook.unmount();
    });

    it('keeps the row draft when only its sync status changes', async () => {
        configureSessionDraftRepository({ syncEnabled: false });
        type('hello');
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionListRowExistingDraft({
                activeScope, serverId: activeScope.serverId, sessionId: 'session-row', dataActive: true,
            }).draft;
        }, { initialProps: {} });
        const draft = hook.getCurrent();
        const rendersBefore = renders;
        // The next edit is the first one waiting for a remote flush: the draft turns pending.
        // The Home boundary is never reached: a local edit only marks the draft as waiting for it.
        const unreached = () => Promise.reject(new Error('no remote flush in this test'));
        configureSessionDraftRepository({ scope: activeScope, syncEnabled: true, transport: { read: unreached, list: unreached, mutate: unreached } });
        await act(async () => { type('hello!'); });
        expect(getExistingSessionDraftProjection(activeScope, 'session-row')?.status).toBe('pending');
        expect(hook.getCurrent()).toBe(draft);
        expect(renders - rendersBefore).toBe(0);
        await hook.unmount();
    });

    it('reads the current draft once for a row whose first render is inactive', async () => {
        type('drafted before the row mounted');
        const hook = await renderHook(() => {
            const row = useSessionListRowExistingDraft({
                activeScope,
                serverId: activeScope.serverId,
                sessionId: 'session-row',
                dataActive: false,
            });
            return { draft: row.draft, preview: useSessionListRowDraftPreview(row.preview) };
        }, { initialProps: {} });

        expect(hook.getCurrent().draft?.hasPreview).toBe(true);
        expect(hook.getCurrent().preview).toBe('drafted before the row mounted');
        await hook.unmount();
    });
});
