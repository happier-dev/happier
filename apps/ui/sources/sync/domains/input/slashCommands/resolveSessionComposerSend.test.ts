import { describe, expect, it } from 'vitest';

import { resolveSessionComposerSend } from './resolveSessionComposerSend';

describe('resolveSessionComposerSend', () => {
    it('passes through normal input unchanged', () => {
        expect(resolveSessionComposerSend({ input: 'hello', executionRunsEnabled: true })).toEqual({
            kind: 'send',
            text: 'hello',
        });
    });

    it('treats // as an escape hatch that sends a slash command through unchanged', () => {
        expect(resolveSessionComposerSend({ input: '//h.review do it', executionRunsEnabled: true })).toEqual({
            kind: 'send',
            text: '/h.review do it',
        });
    });

    it('returns noop for empty // escape', () => {
        expect(resolveSessionComposerSend({ input: '//', executionRunsEnabled: true })).toEqual({ kind: 'noop' });
        expect(resolveSessionComposerSend({ input: '   //   ', executionRunsEnabled: true })).toEqual({ kind: 'noop' });
    });

    it('intercepts /clear as a client-only clear action', () => {
        expect(resolveSessionComposerSend({ input: '/clear', executionRunsEnabled: true })).toEqual({
            kind: 'client.clear_input',
        });
    });

    it('intercepts /h.review into a review.start action when enabled', () => {
        expect(resolveSessionComposerSend({ input: '/h.review review this', executionRunsEnabled: true })).toEqual({
            kind: 'action',
            actionId: 'review.start',
            rest: 'review this',
        });
    });

    it('intercepts /h.voice.reset as a client-only action', () => {
        expect(resolveSessionComposerSend({ input: '/h.voice.reset', executionRunsEnabled: true })).toEqual({
            kind: 'action',
            actionId: 'ui.voice_global.reset',
            rest: '',
        });
    });

    it('intercepts /h.runs as a client-only action', () => {
        expect(resolveSessionComposerSend({ input: '/h.runs', executionRunsEnabled: true })).toEqual({
            kind: 'action',
            actionId: 'execution.run.list',
            rest: '',
        });
    });

    it('does not intercept /h.review when disabled (passes through as a normal message)', () => {
        expect(resolveSessionComposerSend({ input: '/h.review review this', executionRunsEnabled: false })).toEqual({
            kind: 'send',
            text: '/h.review review this',
        });
    });
});
