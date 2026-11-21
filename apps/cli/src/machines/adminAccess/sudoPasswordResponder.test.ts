import { describe, expect, it } from 'vitest';
import { createSudoPasswordResponder, passwordFrame } from './sudoPasswordResponder';

// sudo-rs 0.2.13 puts the custom prompt inside its PAM prompt. The custom
// newline splits its exact native output into these two lines.
describe('native sudo password framing', () => {
    it.each(['', '[sudo: '])('refuses a different principal under native prefix %j without disclosure', async prefix => {
        let requested = false;
        const responder = createSudoPasswordResponder(async () => {
            requested = true;
            return passwordFrame({ password: 'fake-secret' });
        }, 'operator');
        let writes = 0;
        expect(await responder.answer(`${prefix}[happier-sudo-password:root]`, async () => { writes++; })).toBe('administratorSudoFromDaemon');
        expect(writes).toBe(0);
        expect(requested).toBe(false);
        responder.clear();
    });
});
