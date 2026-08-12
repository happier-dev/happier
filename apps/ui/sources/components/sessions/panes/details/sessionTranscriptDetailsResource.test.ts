import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/sessions/terminal/embeddedTerminalDocking', () => ({
    createSessionDetailsTerminalTab: () => ({ key: 'terminal', kind: 'terminal', title: 'Terminal', resource: { kind: 'terminal' } }),
    SESSION_DETAILS_TERMINAL_TAB_KEY: 'terminal',
}));

const { createSessionTranscriptDetailsTab } = await import('./sessionDetailsTabBuilders');
const {
    isSessionTranscriptDetailsResource,
    resolveSessionTranscriptDetailsTabKey,
} = await import('./sessionTranscriptDetailsResource');

/**
 * The invalid states this resource exists to make unrepresentable.
 *
 * The alternative shape — `{ sessionId, sidechainId?: string }` — cannot distinguish "the main
 * transcript", "not loaded yet" and "a bug", and a host reading it has to guess. The guard below is
 * what makes that guess impossible at the panel boundary: a scope that is not one of the two
 * spellings `TranscriptJumpScope` allows is refused, not coerced.
 */
describe('session transcript details resource', () => {
    it('accepts both scopes the shared jump vocabulary defines', () => {
        expect(isSessionTranscriptDetailsResource({
            kind: 'transcript',
            scope: { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' },
        })).toBe(true);
        expect(isSessionTranscriptDetailsResource({
            kind: 'transcript',
            scope: { kind: 'main', sessionId: 's1' },
        })).toBe(true);
    });

    it('refuses every shape that would leave a host guessing', () => {
        const cases: readonly (readonly [string, unknown])[] = [
            ['another resource kind', { kind: 'subagent', subagentId: 'sub_1' }],
            ['no scope at all', { kind: 'transcript' }],
            // The optional-field shape this type was chosen to prevent: it looks like a sidechain
            // scope, but nothing says whether the missing id means "main" or "not yet".
            ['an untagged scope with an optional id', { kind: 'transcript', scope: { sessionId: 's1' } }],
            ['a sidechain scope with no sidechain', { kind: 'transcript', scope: { kind: 'sidechain', sessionId: 's1' } }],
            ['a blank sidechain id', { kind: 'transcript', scope: { kind: 'sidechain', sessionId: 's1', sidechainId: '  ' } }],
            ['a blank session id', { kind: 'transcript', scope: { kind: 'sidechain', sessionId: '', sidechainId: 'wf/a1' } }],
            ['an unknown scope kind', { kind: 'transcript', scope: { kind: 'thread', sessionId: 's1' } }],
            ['nothing', null],
        ];

        for (const [label, value] of cases) {
            expect(isSessionTranscriptDetailsResource(value), label).toBe(false);
        }
    });

    it('keys a tab by what it opens, so re-opening reuses the tab instead of stacking', () => {
        const scope = { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' } as const;
        const first = createSessionTranscriptDetailsTab({ scope, title: 'Reviewer' });
        const again = createSessionTranscriptDetailsTab({ scope, title: 'Reviewer' });

        expect(first.key).toBe(again.key);
        expect(first.key).toBe(resolveSessionTranscriptDetailsTabKey(scope));
        expect(first).toMatchObject({
            kind: 'transcript',
            title: 'Reviewer',
            resource: { kind: 'transcript', scope, title: 'Reviewer' },
        });
        expect(isSessionTranscriptDetailsResource(first.resource)).toBe(true);
    });

    it('names an unnamed agent rather than shipping a blank tab label', () => {
        const tab = createSessionTranscriptDetailsTab({
            scope: { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' },
            title: '   ',
        });

        expect(tab.title).toBe('session.agentActivity.untitled');
        expect(tab.resource.title).toBeUndefined();
    });

    it('does not collide two sidechains of one session onto one tab', () => {
        const a = createSessionTranscriptDetailsTab({
            scope: { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' },
        });
        const b = createSessionTranscriptDetailsTab({
            scope: { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a2' },
        });

        expect(a.key).not.toBe(b.key);
    });
});
