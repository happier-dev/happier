import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit';

import {
    persistDraftNowRef,
    renderNewSessionScreenModel,
    resetDraftPersistenceState,
    saveNewSessionDraftMock,
} from './__tests__/draftPersistenceTestEnvironment';

// Typing is the hottest interaction on this screen. The composer must stay fully controlled and
// fully live, but the live text must not be a render dependency of the ~2,000-line screen model:
// while it was, every keystroke re-executed the whole hook tree, both screen-variant prop
// builders, and the launch-intent signature.
//
// Both halves belong in one case: publishing the text without re-rendering is only correct if the
// draft that gets persisted (and submitted) still carries the text the model never saw. The heavy
// screen-model harness is also mounted once instead of twice.
describe('useNewSessionScreenModel (composer text churn)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        resetDraftPersistenceState();
    });

    it('publishes live composer text without re-rendering the model, and still persists it', async () => {
        let model: any = null;
        let renderCount = 0;

        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
            renderCount += 1;
        });

        const promptStore = model?.simpleProps?.promptStore;
        expect(promptStore?.getPrompt()).toBe('hello');

        const rendersBeforeTyping = renderCount;
        const observed: string[] = [];
        const unsubscribe = promptStore.subscribe(() => {
            observed.push(promptStore.getPrompt());
        });

        for (const next of ['hello w', 'hello wo', 'hello wor']) {
            await act(async () => {
                model?.simpleProps?.setSessionPrompt(next);
            });
        }

        unsubscribe();

        // Every keystroke reaches subscribers (the composer input stays live)...
        expect(observed).toEqual(['hello w', 'hello wo', 'hello wor']);
        expect(promptStore.getPrompt()).toBe('hello wor');
        // ...while the screen model itself never re-runs for them.
        expect(renderCount).toBe(rendersBeforeTyping);

        // ...and the draft that gets written still carries the text the model never rendered.
        saveNewSessionDraftMock.mockClear();
        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
            input: 'hello wor',
        }));
    });
});
