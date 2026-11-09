import { describe, expect, it, vi } from 'vitest';

import { createSubmittedDraftLaunchPublication } from './newSessionLaunchPublication';

describe('createSubmittedDraftLaunchPublication', () => {
    it('delivers launch progress to the submitted draft and never to a draft the host renewed into', () => {
        let shownDraftId: string | null = 'submitted-draft';
        const publishAttempt = vi.fn();
        const publishAttemptId = vi.fn();
        const publication = createSubmittedDraftLaunchPublication({
            submittedDraftId: 'submitted-draft',
            readShownDraftId: () => shownDraftId,
            publishAttempt,
            publishAttemptId,
        });

        publication.attempt({ attemptId: 'a1' });
        publication.attemptId('a1');
        expect(publishAttempt).toHaveBeenCalledTimes(1);
        expect(publishAttemptId).toHaveBeenCalledTimes(1);
        expect(publication.isSubmittedDraftShown()).toBe(true);

        // A docked host renews its composer at hand-off; the launch keeps running.
        shownDraftId = 'fresh-draft';
        publication.attempt(null);
        publication.attempt({ attemptId: 'a1' });
        publication.attemptId(null);
        expect(publishAttempt).toHaveBeenCalledTimes(1);
        expect(publishAttemptId).toHaveBeenCalledTimes(1);
        expect(publication.isSubmittedDraftShown()).toBe(false);

        // Returning to the submitted draft resumes its own progress.
        shownDraftId = 'submitted-draft';
        publication.attempt(null);
        expect(publishAttempt).toHaveBeenLastCalledWith(null);
    });
});
