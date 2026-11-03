import type { PresentCreatedNewSessionResult } from './presentCreatedNewSession';

export type CreatedNewSessionCompletionStage = 'follow_up' | 'presentation' | 'draft_clear';

export class CreatedNewSessionCompletionError extends Error {
    constructor(
        readonly stage: CreatedNewSessionCompletionStage,
        readonly originalError: unknown,
    ) {
        super(originalError instanceof Error ? originalError.message : `created_new_session_${stage}_failed`);
        this.name = 'CreatedNewSessionCompletionError';
    }
}

/**
 * Target-independent completion owner after canonical Session creation.
 * It preserves checkpoints across retry so an accepted prompt/upload is never
 * repeated merely because destination presentation or revision-safe clearing
 * was temporarily unavailable.
 */
export function createCreatedNewSessionCompletion(input: Readonly<{
    followUp?: () => Promise<void>;
    present: () => Promise<PresentCreatedNewSessionResult>;
    clearCapturedDraft?: () => Promise<void>;
}>): Readonly<{
    followUp: () => Promise<void>;
    present: () => Promise<'opened'>;
    clearCapturedDraft: () => Promise<void>;
    complete: () => Promise<'opened'>;
}> {
    let followUpComplete = input.followUp === undefined;
    let presentationComplete = false;
    let draftClearComplete = input.clearCapturedDraft === undefined;

    const followUp = async (): Promise<void> => {
        if (followUpComplete || !input.followUp) return;
        await input.followUp();
        followUpComplete = true;
    };
    const present = async (): Promise<'opened'> => {
        if (presentationComplete) return 'opened';
        try {
            const result = await input.present();
            if (result !== 'opened') throw new Error(`created_new_session_presentation_${result}`);
            presentationComplete = true;
            return 'opened';
        } catch (error) {
            throw new CreatedNewSessionCompletionError('presentation', error);
        }
    };
    const clearCapturedDraft = async (): Promise<void> => {
        if (draftClearComplete || !input.clearCapturedDraft) return;
        await input.clearCapturedDraft();
        draftClearComplete = true;
    };
    const complete = async (): Promise<'opened'> => {
        try {
            await followUp();
        } catch (error) {
            throw new CreatedNewSessionCompletionError('follow_up', error);
        }
        await present();
        try {
            await clearCapturedDraft();
        } catch (error) {
            throw new CreatedNewSessionCompletionError('draft_clear', error);
        }
        return 'opened';
    };
    return { followUp, present, clearCapturedDraft, complete };
}
