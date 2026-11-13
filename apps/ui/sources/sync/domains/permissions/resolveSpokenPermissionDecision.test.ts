import { describe, expect, it } from 'vitest';

import { resolveSpokenPermissionDecision } from './resolveSpokenPermissionDecision';

describe('spoken permission interpretation', () => {
    it.each([
        ['YES ALLOW THE COMMAND', 'approved'],
        ["NO, DON'T ALLOW THE COMMAND", 'denied'],
        ['Yes, approve this command please.', 'approved'],
        ['Please do not approve this command.', 'denied'],
        ['NO BUT', 'denied'],
        ["No, don't run it", 'denied'],
        ['NO DO NOT RUN IT I', 'denied'],
        ['Please do not run the command.', 'denied'],
        ['NO DO NOT RUN IT I CHANGED MY MIND ALLOW IT', null],
        ["Yes, don't run it", null],
        ['NO BUT ALLOW IT', null],
        ["Yes, don't allow the command.", null],
        ['No, allow the command.', null],
        ['Should I allow the command?', null],
        ['', null],
    ] as const)('interprets %j as %s', (text, expected) => {
        expect(resolveSpokenPermissionDecision(text, { yes: 'Yes', no: 'No' })).toBe(expected);
    });

    it('retains localized plain answers', () => {
        const labels = { yes: 'Oui', no: 'Non' };
        expect(resolveSpokenPermissionDecision('OUI!', labels)).toBe('approved');
        expect(resolveSpokenPermissionDecision('Non.', labels)).toBe('denied');
    });
});
