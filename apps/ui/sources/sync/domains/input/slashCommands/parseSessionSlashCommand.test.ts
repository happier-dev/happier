import { describe, expect, it } from 'vitest';

import { parseSessionSlashCommand } from './parseSessionSlashCommand';

describe('parseSessionSlashCommand', () => {
    it('returns null for non-slash input', () => {
        expect(parseSessionSlashCommand('hello')).toBeNull();
        expect(parseSessionSlashCommand('   hello')).toBeNull();
    });

    it('does not intercept /clear (it should be forwarded to the daemon as a normal message)', () => {
        expect(parseSessionSlashCommand('/clear')).toBeNull();
        expect(parseSessionSlashCommand(' /clear ')).toBeNull();
    });

    it('parses /h.review into a review.start action', () => {
        expect(parseSessionSlashCommand('/h.review review this repo')).toEqual({
            kind: 'action',
            actionId: 'review.start',
            rest: 'review this repo',
        });
    });

    it('parses /review into a review.start action', () => {
        expect(parseSessionSlashCommand('/review review this repo')).toEqual({
            kind: 'action',
            actionId: 'review.start',
            rest: 'review this repo',
        });
    });

    it('parses /h.plan and /h.delegate into their start actions when registered in the protocol action spec', () => {
        expect(parseSessionSlashCommand('/h.plan make a plan')).toEqual({
            kind: 'action',
            actionId: 'subagents.plan.start',
            rest: 'make a plan',
        });
        expect(parseSessionSlashCommand('/h.delegate do it')).toEqual({
            kind: 'action',
            actionId: 'subagents.delegate.start',
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

    it('parses /pet and /h.pet as the pet chooser action', () => {
        expect(parseSessionSlashCommand('/pet')).toEqual({ kind: 'action', actionId: 'ui.pet.choose', rest: '' });
        expect(parseSessionSlashCommand('/h.pet choose')).toEqual({ kind: 'action', actionId: 'ui.pet.choose', rest: 'choose' });
    });
});
