import { describe, expect, it } from 'vitest';

import { parseSessionSlashCommand } from './parseSessionSlashCommand';

describe('parseSessionSlashCommand', () => {
    it('returns null for non-slash input', () => {
        expect(parseSessionSlashCommand('hello')).toBeNull();
        expect(parseSessionSlashCommand('   hello')).toBeNull();
    });

    it('parses /clear as a client-only clear action', () => {
        expect(parseSessionSlashCommand('/clear')).toEqual({ kind: 'client.clear_input' });
        expect(parseSessionSlashCommand(' /clear ')).toEqual({ kind: 'client.clear_input' });
    });

    it('parses /h.review into a review.start action', () => {
        expect(parseSessionSlashCommand('/h.review review this repo')).toEqual({
            kind: 'action',
            actionId: 'review.start',
            rest: 'review this repo',
        });
    });

    it('parses /h.plan and /h.delegate into their start actions when registered in the protocol action spec', () => {
        expect(parseSessionSlashCommand('/h.plan make a plan')).toEqual({
            kind: 'action',
            actionId: 'plan.start',
            rest: 'make a plan',
        });
        expect(parseSessionSlashCommand('/h.delegate do it')).toEqual({
            kind: 'action',
            actionId: 'delegate.start',
            rest: 'do it',
        });
    });

    it('returns null for unknown /h.* tokens', () => {
        expect(parseSessionSlashCommand('/h.unknown test')).toBeNull();
    });

    it('parses /h.voice.reset as a client-only voice reset action', () => {
        expect(parseSessionSlashCommand('/h.voice.reset')).toEqual({ kind: 'action', actionId: 'ui.voice_global.reset', rest: '' });
        expect(parseSessionSlashCommand(' /h.voice.reset  ')).toEqual({ kind: 'action', actionId: 'ui.voice_global.reset', rest: '' });
    });

    it('parses /h.runs as an execution run list action', () => {
        expect(parseSessionSlashCommand('/h.runs')).toEqual({ kind: 'action', actionId: 'execution.run.list', rest: '' });
        expect(parseSessionSlashCommand(' /h.runs ')).toEqual({ kind: 'action', actionId: 'execution.run.list', rest: '' });
    });
});
