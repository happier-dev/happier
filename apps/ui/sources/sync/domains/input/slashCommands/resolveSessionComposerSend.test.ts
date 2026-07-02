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

    it('intercepts /goal complete as a client-side goal status command', () => {
        expect(resolveSessionComposerSend({ input: '/goal complete', executionRunsEnabled: true })).toEqual({
            kind: 'goal',
            command: 'complete',
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

    it('preserves insert-on-send behavior for configured template tokens', () => {
        const resolved = resolveSessionComposerSend({
            input: '/foo',
            executionRunsEnabled: true,
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 't1',
                        token: '/foo',
                        title: 'Foo template',
                        target: { kind: 'doc', artifactId: 'a1' },
                        behavior: 'insert_on_send',
                        allowArgs: false,
                        availableIn: 'global',
                    },
                ],
            },
        });

        expect(resolved).toMatchObject({
            kind: 'template',
            invocationId: 't1',
            behavior: 'insert_on_send',
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

    it('expands built-in prompt tokens before user template invocations', () => {
        const resolved = resolveSessionComposerSend({
            input: '/happier-diagnose daemon is stuck',
            executionRunsEnabled: true,
            promptInvocationsV1: {
                v: 1,
                entries: [
                    {
                        id: 't1',
                        token: '/happier-diagnose',
                        title: 'Shadow template',
                        target: { kind: 'doc', artifactId: 'a1' },
                        behavior: 'insert',
                        allowArgs: true,
                        availableIn: 'global',
                    },
                ],
            },
        });

        expect(resolved.kind).toBe('send');
        expect(resolved.kind === 'send' ? resolved.text : '').toContain('# Happier Diagnose');
        expect(resolved.kind === 'send' ? resolved.text : '').toContain('daemon is stuck');
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
});
