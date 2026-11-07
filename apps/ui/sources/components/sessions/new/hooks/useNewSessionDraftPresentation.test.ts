import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createRenderCommitCounter, renderHook, useRenderCommitCounter } from '@/dev/testkit';
import {
    configureSessionDraftRepository, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests,
    writeNewSessionDraft, writeSessionDraftLocalSupplement,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useNewSessionDraftPresentation } from './useNewSessionDraftPresentation';

const scope = { serverId: 'qbp3-home', accountId: 'qbp3-account' };
const draftId = '00000000-0000-4000-8000-000000000003';
const address = { kind: 'newSession' as const, draftId };

describe('New Session draft presentation subscription', () => {
    beforeEach(() => {
        resetSessionDraftRepositoryForTests();
        configureSessionDraftRepository({ syncEnabled: false });
    });
    afterEach(() => resetSessionDraftRepositoryForTests());

    it('keeps 22 real repository edits in the editor while observing launch custody', async () => {
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'seeded', patch: { text: '' } });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useNewSessionDraftPresentation(scope, draftId);
        });
        const presentation = hook.getCurrent();
        counter.reset();
        const text = 'qbp1 performance probe';
        for (let index = 1; index <= text.length; index++) {
            await act(async () => {
                writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: text.slice(0, index) } });
            });
        }
        expect(getSessionDraftSnapshot(scope, address)?.revision).toBeGreaterThan(20);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(presentation);
        await act(async () => {
            writeSessionDraftLocalSupplement({ scope, address, patch: { launchUserAttemptId: 'own-launch-attempt' } });
        });
        expect(hook.getCurrent()?.launchUserAttemptId).toBe('own-launch-attempt');
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        await hook.unmount();
    });

    it('names the item a draft was opened from, and only an item, not pasted media', async () => {
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'seeded', patch: { text: '', attachments: [
            { v: 1, instanceId: 'pasted', presentation: { label: 'screenshot.png' }, content: { kind: 'staged' } },
            { v: 1, instanceId: 'entry', presentation: { label: 'Keep the accepted checkout' } },
        ] as never } });
        const hook = await renderHook(() => useNewSessionDraftPresentation(scope, draftId));
        expect(hook.getCurrent()?.subjectLabel).toBe('Keep the accepted checkout');
        await act(async () => {
            writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { attachments: [] as never } });
        });
        expect(hook.getCurrent()?.subjectLabel).toBeNull();
        await hook.unmount();
    });

    it('observes first materialization and retires the previous Account selection', async () => {
        const hook = await renderHook(({ selectedScope }) => useNewSessionDraftPresentation(selectedScope, draftId), { initialProps: { selectedScope: scope } });
        expect(hook.getCurrent()).toBeNull();
        await act(async () => {
            writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: 'first edit' } });
        });
        expect(hook.getCurrent()?.materialized).toBe(true);
        await hook.rerender({ selectedScope: { ...scope, accountId: 'another-account' } });
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });
});
