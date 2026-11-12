/** The one attended answer stays private until the root child is ready. */
export function passwordFrame(answer: unknown): Buffer | null {
    if (!answer || typeof answer !== 'object' || !('password' in answer) || Object.keys(answer).length !== 1
        || typeof answer.password !== 'string' || answer.password.length === 0 || /[\r\n\0]/.test(answer.password)) return null;
    return Buffer.from(answer.password + '\n', 'utf8');
}

/** Only exact, separately named sudo prompts receive a fresh copy of the frame. */
export function createSudoPasswordResponder(frame: Buffer, administratorUsername: string) {
    let password: Buffer | null = frame;
    let administratorAnswered = false;
    let rootAnswered = false;
    return {
        get submitted() { return administratorAnswered || rootAnswered; },
        clear() { password?.fill(0); password = null; },
        async answer(line: string, write: (frame: Buffer) => Promise<void>): Promise<'denied' | 'administratorSudoToRoot' | undefined> {
            const administrator = line.includes('[happier-sudo-password:');
            const root = line.includes('[happier-sudo-root-password:');
            if (!administrator && !root) return;
            const expected = root ? `[happier-sudo-root-password:${administratorUsername}]`
                : `[happier-sudo-password:${administratorUsername}]`;
            // sudo-rs wraps the custom prompt in its PAM label; the custom
            // newline ends this line before its closing "] Password: " text.
            const expectedPrompt = line === expected || line === `[sudo: ${expected}`;
            if (!expectedPrompt || !password || (root ? rootAnswered : administratorAnswered || rootAnswered)) {
                return root ? 'administratorSudoToRoot' : 'denied';
            }
            if (root) rootAnswered = true; else administratorAnswered = true;
            // The write callback can complete after root readiness. Its own copy
            // may be cleared only after that callback, independently of custody.
            const submittedFrame = Buffer.from(password);
            try { await write(submittedFrame); }
            finally { submittedFrame.fill(0); }
        },
    };
}
