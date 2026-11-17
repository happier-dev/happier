import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createRenderCommitCounter, renderHook, useRenderCommitCounter } from '@/dev/testkit';
import {
    configureSessionDraftRepository, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests,
    writeNewSessionDraft, writeSessionDraftLocalSupplement,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useNewSessionDraftPresentation } from './useNewSessionDraftPresentation';
import { seedNewSessionDraftV1 } from '../newSessionDraftSeed';
import { readNewSessionDraftFromRepository, writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';

const scope = { serverId: 'qbp3-home', accountId: 'qbp3-account' };
const draftId = '00000000-0000-4000-8000-000000000003';
const address = { kind: 'newSession' as const, draftId };

describe('New Session draft presentation subscription', () => {
    beforeEach(() => {
        resetSessionDraftRepositoryForTests();
        configureSessionDraftRepository({ syncEnabled: false });
    });
    afterEach(() => resetSessionDraftRepositoryForTests());

    it('presents a host-seeded intro from the draft after an authoring edit, while ordinary drafts have no intro', async () => {
        const intro = { title: 'Create a pet', body: 'Describe your pet.', scene: 'ideas', suggestions: ['A sleepy fox'] } as const;
        expect(seedNewSessionDraftV1({ scope, createDraftId: () => draftId, seed: { intro } })).toBe(draftId);
        expect(getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState).toMatchObject({ intro });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        expect(draft).toMatchObject({ intro });
        if (!draft) throw new Error('Expected the seeded draft');
        const hook = await renderHook(() => useNewSessionDraftPresentation(scope, draftId));
        try {
            expect(hook.getCurrent()).toMatchObject({ intro });
            const editorDraft = { ...draft, selectedPath: '/another-folder' };
            delete editorDraft.intro;
            await act(async () => { writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: editorDraft }); });
            expect(hook.getCurrent()).toMatchObject({ intro });
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ intro });
        } finally { await hook.unmount(); }
        const ordinaryId = '00000000-0000-4000-8000-000000000004';
        seedNewSessionDraftV1({ scope, createDraftId: () => ordinaryId, seed: { prompt: { text: 'Ordinary draft', mode: 'replace' } } });
        const ordinary = await renderHook(() => useNewSessionDraftPresentation(scope, ordinaryId));
        try {
            expect(ordinary.getCurrent()).not.toHaveProperty('intro');
            expect(readNewSessionDraftFromRepository({ scope, draftId: ordinaryId })).not.toHaveProperty('intro');
        } finally { await ordinary.unmount(); }
    });

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
