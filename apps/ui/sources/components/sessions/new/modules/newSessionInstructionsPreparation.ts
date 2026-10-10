/**
 * Send could not prepare the draft's selected Instructions document before spawn, so nothing was
 * created and the draft is kept. `code` is the Prompt Library outcome (or the draft precondition).
 */
export class NewSessionInstructionsPreparationError extends Error {
    readonly code: string;
    constructor(code: string) {
        super(code);
        this.name = 'NewSessionInstructionsPreparationError';
        this.code = code;
    }
}
