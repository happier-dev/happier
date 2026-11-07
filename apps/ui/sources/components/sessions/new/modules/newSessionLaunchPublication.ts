/**
 * A launch's progress belongs to the draft its Send submitted. A host that renews its composer at
 * hand-off (the docked composer, once the Session is presented at commit) keeps this launch running
 * after another draft is on screen; its later outcome must never be published onto that draft.
 * The submitted draft's persisted recovery is written by draft identity, not through these callbacks.
 */
export function createSubmittedDraftLaunchPublication<TAttempt>(params: Readonly<{
    submittedDraftId: string | null;
    readShownDraftId: () => string | null;
    publishAttempt: (attempt: TAttempt | null) => void;
    publishAttemptId: (userAttemptId: string | null) => void;
}>) {
    const isSubmittedDraftShown = () => params.readShownDraftId() === params.submittedDraftId;
    return {
        isSubmittedDraftShown,
        attempt(attempt: TAttempt | null): void {
            if (isSubmittedDraftShown()) params.publishAttempt(attempt);
        },
        attemptId(userAttemptId: string | null): void {
            if (isSubmittedDraftShown()) params.publishAttemptId(userAttemptId);
        },
    };
}
