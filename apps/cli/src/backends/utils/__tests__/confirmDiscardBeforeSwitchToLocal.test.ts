import { describe, expect, it } from 'vitest';

import { confirmDiscardBeforeSwitchToLocal } from '../confirmDiscardBeforeSwitchToLocal';

function createIo(answer: string, writes?: string[]) {
  return {
    isTty: true,
    write: (chunk: string) => {
      writes?.push(chunk);
    },
    question: async () => answer,
  };
}

describe('confirmDiscardBeforeSwitchToLocal', () => {
    it('does not prompt when there is nothing to discard in TTY mode', async () => {
        let prompted = 0;
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 0,
            queuedPreview: [],
            pendingCount: 0,
            pendingPreview: [],
            io: {
                isTty: true,
                write: () => { },
                question: async () => {
                    prompted += 1;
                    return 'n';
                },
            },
        });
        expect(ok).toBe(true);
        expect(prompted).toBe(0);
    });

    it('fails closed without TTY when discarding would lose messages', async () => {
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 1,
            queuedPreview: ['hello'],
            pendingCount: 0,
            pendingPreview: [],
            io: {
                isTty: false,
                write: () => { },
                question: async () => 'y',
            },
        });
        expect(ok).toBe(false);
    });

    it('allows switching without TTY when there is nothing to discard', async () => {
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 0,
            queuedPreview: [],
            pendingCount: 0,
            pendingPreview: [],
            io: {
                isTty: false,
                write: () => { },
                question: async () => 'n',
            },
        });
        expect(ok).toBe(true);
    });

    it('returns true when the user confirms discard', async () => {
        const writes: string[] = [];
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 2,
            queuedPreview: ['one', 'two'],
            pendingCount: 1,
            pendingPreview: ['p1'],
            io: {
                isTty: true,
                write: (s: string) => writes.push(s),
                question: async () => 'y',
            },
        });
        expect(ok).toBe(true);
        expect(writes.join('')).toContain('Pending UI messages (1)');
        expect(writes.join('')).toContain('Queued remote messages (2)');
    });

    it('returns false when the user declines discard', async () => {
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 1,
            queuedPreview: ['hello'],
            pendingCount: 0,
            pendingPreview: [],
            io: {
                isTty: true,
                write: () => { },
                question: async () => 'no',
            },
        });
        expect(ok).toBe(false);
    });

    it.each([
        { answer: 'y', expected: true },
        { answer: 'Y', expected: true },
        { answer: ' yes ', expected: true },
        { answer: 'YES', expected: true },
        { answer: '', expected: false },
        { answer: '   ', expected: false },
        { answer: 'yep', expected: false },
    ])('handles confirmation response "$answer"', async ({ answer, expected }) => {
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 1,
            queuedPreview: ['queued message'],
            pendingCount: 1,
            pendingPreview: ['pending message'],
            io: createIo(answer),
        });
        expect(ok).toBe(expected);
    });

    it('renders only first three non-empty preview lines per section', async () => {
        const writes: string[] = [];
        const ok = await confirmDiscardBeforeSwitchToLocal({
            queuedCount: 5,
            queuedPreview: ['first', '', '  ', 'second', 'third', 'fourth'],
            pendingCount: 3,
            pendingPreview: ['p1', ' ', 'p2', 'p3'],
            io: createIo('y', writes),
        });

        const output = writes.join('');
        expect(ok).toBe(true);
        expect(output).toContain('Pending UI messages (3)');
        expect(output).toContain('Queued remote messages (5)');
        expect(output).toContain('1. p1');
        expect(output).toContain('2. p2');
        expect(output).toContain('3. p3');
        expect(output).toContain('1. first');
        expect(output).toContain('2. second');
        expect(output).toContain('3. third');
        expect(output).not.toContain('fourth');
    });
});
