import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import {
    getSessionDraftSnapshot,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    useNewSessionDraftHostSnapshot,
    useNewSessionDraftPromptProjection,
} from './useNewSessionDraftProjection';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

afterEach(() => {
    standardCleanup();
});

describe('useNewSessionDraftProjection', () => {
    it('keeps composer-only revisions out of the screen render graph', async () => {
        const draftId = '00000000-0000-4000-8000-000000000401';
        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useNewSessionDraftHostSnapshot(scope, draftId);
        });

        await act(async () => {
            writeNewSessionDraft({
                scope,
                draftId,
                patch: { text: 'h', authoring: { machineId: 'machine-a' } },
                materializationIntent: 'userEdit',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        const rendersAfterMaterialization = renderCount;

        await act(async () => {
            writeNewSessionDraft({
                scope,
                draftId,
                patch: { text: 'he' },
                materializationIntent: 'userEdit',
            });
            writeNewSessionDraft({
                scope,
                draftId,
                patch: { text: 'hello' },
                materializationIntent: 'userEdit',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(renderCount).toBe(rendersAfterMaterialization);
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.composer.text.value)
            .toBe('hello');

        await act(async () => {
            writeNewSessionDraft({
                scope,
                draftId,
                patch: { authoring: { machineId: 'machine-b' } },
                materializationIntent: 'userEdit',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(renderCount).toBeGreaterThan(rendersAfterMaterialization);
        expect(hook.getCurrent()?.document.target.kind).toBe('newSession');
    });

    it('stages a locally edited ephemeral prompt before adopting durable updates', async () => {
        const draftId = '00000000-0000-4000-8000-000000000402';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: { text: 'hel' },
            materializationIntent: 'userEdit',
        });
        const promptStore = createNewSessionPromptStore('hello world');
        const hook = await renderHook(() => {
            useNewSessionDraftPromptProjection({
                scope,
                draftId,
                promptStore,
                hasLocalEdit: () => true,
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(promptStore.getPrompt()).toBe('hello world');
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.composer.text.value)
            .toBe('hello world');

        await act(async () => {
            writeNewSessionDraft({
                scope,
                draftId,
                patch: { text: 'updated elsewhere' },
                materializationIntent: 'userEdit',
            });
        });
        expect(promptStore.getPrompt()).toBe('updated elsewhere');

        await hook.unmount();
    });
});
