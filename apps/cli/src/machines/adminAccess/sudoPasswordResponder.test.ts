import { describe, expect, it } from 'vitest';
import { createSudoPasswordResponder, passwordFrame } from './sudoPasswordResponder';

// sudo-rs 0.2.13 puts the custom prompt inside its PAM prompt. The custom
// newline splits its exact native output into these two lines.
describe('native sudo password framing', () => {
    it.each(['', '[sudo: '])('authenticates both expected principals with native prefix %j', async prefix => {
        const responder = createSudoPasswordResponder(passwordFrame({ password: 'fake-secret' })!, 'operator');
        const frames: string[] = [];
        const write = async (frame: Buffer) => { frames.push(frame.toString('utf8')); };
        for (const marker of ['happier-sudo-password', 'happier-sudo-root-password']) {
            expect(await responder.answer(`${prefix}[${marker}:operator]`, write)).toBeUndefined();
            if (prefix) expect(await responder.answer('] Password: ', write)).toBeUndefined();
        }
        responder.clear();
        expect(frames).toEqual(['fake-secret\n', 'fake-secret\n']);
    });

    it.each(['', '[sudo: '])('refuses a different principal under native prefix %j without disclosure', async prefix => {
        const responder = createSudoPasswordResponder(passwordFrame({ password: 'fake-secret' })!, 'operator');
        let writes = 0;
        expect(await responder.answer(`${prefix}[happier-sudo-password:root]`, async () => { writes++; })).toBe('denied');
        expect(writes).toBe(0);
        responder.clear();
    });
});
