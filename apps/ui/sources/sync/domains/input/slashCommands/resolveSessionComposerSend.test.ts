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

    it('does not intercept /clear (it should be forwarded to the daemon as a normal message)', () => {
        expect(resolveSessionComposerSend({ input: '/clear', executionRunsEnabled: true })).toEqual({
            kind: 'send',
            text: '/clear',
        });
    });

    it('intercepts configured template tokens', () => {
        const resolved = resolveSessionComposerSend({
            input: '/foo bar',
            executionRunsEnabled: true,
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 't1',
                        token: '/foo',
                        title: 'Foo template',
                        target: { kind: 'doc', artifactId: 'a1' },
                        behavior: 'insert',
                        allowArgs: true,
                        availableIn: 'global',
                    },
                ],
            },
        });

        expect(resolved).toEqual({
            kind: 'template',
            invocationId: 't1',
            token: '/foo',
            title: 'Foo template',
            targetArtifactId: 'a1',
            behavior: 'insert',
            allowArgs: true,
            rest: 'bar',
        });
    });

    it('does not intercept templates with args when allowArgs=false', () => {
        const resolved = resolveSessionComposerSend({
            input: '/foo bar',
            executionRunsEnabled: true,
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 't1',
                        token: '/foo',
                        title: 'Foo template',
                        target: { kind: 'doc', artifactId: 'a1' },
                        behavior: 'insert',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                ],
            },
        });

        expect(resolved).toEqual({
            kind: 'send',
            text: '/foo bar',
        });
    });

    it('intercepts /h.review into a review.start action when enabled', () => {
        expect(resolveSessionComposerSend({ input: '/h.review review this', executionRunsEnabled: true })).toEqual({
            kind: 'action',
            actionId: 'review.start',
            rest: 'review this',
        });
    });

    it('intercepts /review into a review.start action when enabled', () => {
        expect(resolveSessionComposerSend({ input: '/review review this', executionRunsEnabled: true })).toEqual({
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

    it('intercepts /pet as a client-only action regardless of execution-run enablement', () => {
        expect(resolveSessionComposerSend({ input: '/pet', executionRunsEnabled: false })).toEqual({
            kind: 'action',
            actionId: 'ui.pet.choose',
            rest: '',
        });
    });

    it('does not intercept /h.review when disabled (passes through as a normal message)', () => {
        expect(resolveSessionComposerSend({ input: '/h.review review this', executionRunsEnabled: false })).toEqual({
            kind: 'send',
            text: '/h.review review this',
        });
    });

    it('does not intercept /review when disabled (passes through as a normal message)', () => {
        expect(resolveSessionComposerSend({ input: '/review review this', executionRunsEnabled: false })).toEqual({
            kind: 'send',
            text: '/review review this',
        });
    });

    it('expands /happier-diagnose to the built-in skill body and sends it', () => {
        const resolved = resolveSessionComposerSend({ input: '/happier-diagnose', executionRunsEnabled: true });
        expect(resolved.kind).toBe('send');
        if (resolved.kind === 'send') {
            // Body is the verbatim SKILL.md. Sanity-check a couple of distinctive lines.
            expect(resolved.text).toContain('name: happier-diagnose');
            expect(resolved.text).toContain('# Happier Diagnose');
            // Should not be the literal slash token.
            expect(resolved.text).not.toBe('/happier-diagnose');
        }
    });

    it('appends /happier-diagnose arguments after the body (allowArgs: true)', () => {
        const resolved = resolveSessionComposerSend({
            input: '/happier-diagnose sess_abcdef123456',
            executionRunsEnabled: true,
        });
        expect(resolved.kind).toBe('send');
        if (resolved.kind === 'send') {
            expect(resolved.text).toContain('# Happier Diagnose');
            expect(resolved.text.endsWith('sess_abcdef123456')).toBe(true);
        }
    });

    it('built-in /happier-diagnose takes precedence over a user template with the same token', () => {
        const resolved = resolveSessionComposerSend({
            input: '/happier-diagnose',
            executionRunsEnabled: true,
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 'shadow',
                        token: '/happier-diagnose',
                        title: 'User shadow',
                        target: { kind: 'doc', artifactId: 'shadow-artifact' },
                        behavior: 'insert',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                ],
            },
        });
        expect(resolved.kind).toBe('send');
    });

    it('built-in expansion is bypassed by the // escape hatch', () => {
        expect(resolveSessionComposerSend({ input: '//happier-diagnose', executionRunsEnabled: true })).toEqual({
            kind: 'send',
            text: '/happier-diagnose',
        });
    });

    it('built-in tokens are case-insensitive', () => {
        const resolved = resolveSessionComposerSend({ input: '/Happier-Diagnose', executionRunsEnabled: true });
        expect(resolved.kind).toBe('send');
        if (resolved.kind === 'send') {
            expect(resolved.text).toContain('# Happier Diagnose');
        }
    });
});
