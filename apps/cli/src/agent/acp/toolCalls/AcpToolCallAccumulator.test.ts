import { describe, expect, it } from 'vitest';

import { AcpToolCallAccumulator } from './AcpToolCallAccumulator';
import { createAcpToolIdentity } from './identity';
import type { AcpToolObservation } from './types';

function observation(
    revision: number,
    patch: AcpToolObservation['patch'],
    overrides: Partial<Omit<AcpToolObservation, 'patch' | 'revision'>> = {},
): AcpToolObservation {
    return {
        sessionId: 'session-1',
        turnId: 'turn-1',
        sidechainId: null,
        toolCallId: 'call-1',
        revision,
        observedAtMs: 1_000 + revision,
        source: 'tool_call_update',
        patch,
        ...overrides,
    };
}

describe('AcpToolCallAccumulator', () => {
    it('exposes immutable active snapshots scoped to one session, turn, and optional sidechain', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'pending' }, { toolCallId: 'main' }));
        accumulator.observe(observation(1, { status: 'in_progress' }, {
            toolCallId: 'child',
            sidechainId: 'child-1',
        }));
        accumulator.observe(observation(1, { status: 'pending' }, {
            sessionId: 'other-session',
            toolCallId: 'other',
        }));

        expect(accumulator.listActiveCalls({ sessionId: 'session-1', turnId: 'turn-1' }))
            .toMatchObject([{ toolCallId: 'main' }, { toolCallId: 'child' }]);
        expect(accumulator.listActiveCalls({
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: null,
        })).toMatchObject([{ toolCallId: 'main' }]);
        expect(Object.isFrozen(accumulator.listActiveCalls({
            sessionId: 'session-1',
            turnId: 'turn-1',
        }))).toBe(true);
    });

    it('merges a sparse lifecycle into one terminal call and one result', () => {
        const accumulator = new AcpToolCallAccumulator();

        expect(accumulator.observe(observation(1, { status: 'pending', title: 'Edit' }))).toMatchObject({
            kind: 'progress',
            call: { toolCallId: 'call-1', title: 'Edit', status: 'pending' },
        });
        expect(accumulator.observe(observation(2, {
            status: 'in_progress',
            rawInput: { path: '/tmp/a' },
            kind: 'edit',
        }, { semanticName: 'Edit' }))).toMatchObject({
            kind: 'progress',
            call: {
                toolCallId: 'call-1',
                toolName: 'Edit',
                title: 'Edit',
                rawInput: { path: '/tmp/a' },
                status: 'running',
            },
        });
        const terminal = accumulator.observe(observation(3, {
            status: 'completed',
            rawOutput: { changed: true },
        }));

        expect(terminal).toMatchObject({
            kind: 'terminal',
            call: {
                toolCallId: 'call-1',
                toolName: 'Edit',
                rawInput: { path: '/tmp/a' },
                status: 'completed',
            },
            result: {
                toolCallId: 'call-1',
                rawOutput: { changed: true },
                isError: false,
            },
        });
        expect(accumulator.activeSize).toBe(0);
        expect(accumulator.tombstoneSize).toBe(1);
    });

    it('supports update-before-create, terminal-only, and result-less terminalization', () => {
        const accumulator = new AcpToolCallAccumulator();

        expect(accumulator.observe(observation(1, { rawInput: { query: 'x' } }))).toMatchObject({
            kind: 'progress',
            call: { status: 'pending', rawInput: { query: 'x' } },
        });
        expect(accumulator.observe(observation(2, { status: 'completed', rawOutput: 'done' }))).toMatchObject({
            kind: 'terminal',
            result: { rawOutput: 'done' },
        });

        expect(accumulator.observe(observation(3, { status: 'completed', rawOutput: 'only' }, {
            toolCallId: 'terminal-only',
        }))).toMatchObject({ kind: 'terminal', result: { rawOutput: 'only' } });

        accumulator.observe(observation(4, { status: 'pending' }, { toolCallId: 'create-plan' }));
        const [planTerminal] = accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'cancelled',
            revision: 5,
            observedAtMs: 1_005,
        });
        expect(planTerminal).toMatchObject({
            kind: 'terminal',
            call: { toolCallId: 'create-plan', status: 'cancelled' },
            result: {
                toolCallId: 'create-plan',
                status: 'cancelled',
                isError: true,
            },
            publishResult: true,
        });
        expect((planTerminal as any).result).not.toHaveProperty('rawOutput');
        expect((planTerminal as any).result).not.toHaveProperty('error');
        expect(accumulator.activeSize).toBe(0);
    });

    it('rejects stale and duplicate observations without downgrading merged state', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(2, {
            status: 'in_progress',
            title: 'Rich title',
            rawInput: { path: 'a' },
        }, { semanticName: 'Edit' }));

        expect(accumulator.observe(observation(1, {
            status: 'pending',
            title: 'Sparse',
            rawInput: {},
        }))).toEqual({ kind: 'ignored', reason: 'stale' });
        expect(accumulator.observe(observation(3, {}))).toEqual({ kind: 'ignored', reason: 'duplicate' });
        expect(accumulator.peek(observation(4, {}).sessionId, 'turn-1', null, 'call-1')).toMatchObject({
            title: 'Rich title',
            toolName: 'Edit',
            rawInput: { path: 'a' },
            status: 'running',
        });
    });

    it('publishes only materially changed result revisions after terminal enrichment', () => {
        const accumulator = new AcpToolCallAccumulator({ tombstoneTtlMs: 100, maxTombstones: 2 });
        accumulator.observe(observation(1, { status: 'completed', rawOutput: { ok: true } }));

        expect(accumulator.observe(observation(1, { title: 'stale' }))).toEqual({ kind: 'ignored', reason: 'stale' });
        expect(accumulator.observe(observation(2, {}))).toEqual({ kind: 'ignored', reason: 'duplicate' });
        expect(accumulator.observe(observation(3, { locations: [{ path: 'a.ts', line: 2 }] }))).toMatchObject({
            kind: 'late-enrichment',
            call: { locations: [{ path: 'a.ts', line: 2 }], status: 'completed' },
            result: { rawOutput: { ok: true } },
            publishResult: false,
        });
        expect(accumulator.observe(observation(4, { rawOutput: { ok: true, detail: 'richer' } }))).toMatchObject({
            kind: 'late-enrichment',
            result: { rawOutput: { ok: true, detail: 'richer' } },
            publishResult: true,
        });
        expect(accumulator.observe(observation(5, { rawOutput: { ok: true, detail: 'richer' } })))
            .toEqual({ kind: 'ignored', reason: 'duplicate' });
        expect(accumulator.observe(observation(3, { rawOutput: { stale: true } })))
            .toEqual({ kind: 'ignored', reason: 'stale' });
        expect(accumulator.activeSize).toBe(0);
        expect(accumulator.tombstoneSize).toBe(1);
    });

    it('preserves a known semantic identity when a newer generic observation would downgrade it', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'in_progress' }, { semanticName: 'Edit' }));

        expect(accumulator.observe(observation(2, { title: 'provider enrichment' }, {
            semanticName: 'other',
        }))).toMatchObject({
            kind: 'progress',
            call: { toolName: 'Edit', title: 'provider enrichment' },
        });
    });

    it('does not let whitespace-only semantic metadata hide a source tool kind', () => {
        const accumulator = new AcpToolCallAccumulator();

        expect(accumulator.observe(observation(1, { status: 'in_progress', kind: 'edit' }, {
            semanticName: ' \t ',
        }))).toMatchObject({
            kind: 'progress',
            call: { toolName: 'edit', kind: 'edit' },
        });
    });

    it('preserves a known ACP kind when a newer generic kind would downgrade it', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'in_progress', kind: 'edit' }));

        expect(accumulator.observe(observation(2, { kind: 'other', title: 'provider enrichment' }))).toMatchObject({
            kind: 'progress',
            call: { toolName: 'edit', kind: 'edit', title: 'provider enrichment' },
        });
    });

    it('distinguishes omitted ACP fields from explicit nullable replacement clears', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, {
            status: 'in_progress',
            title: 'Editing a.ts',
            kind: 'edit',
            content: [{ type: 'content', content: { type: 'text', text: 'working' } }],
            locations: [{ path: 'a.ts', line: 1 }],
        }));

        expect(accumulator.observe(observation(2, {}))).toEqual({ kind: 'ignored', reason: 'duplicate' });
        expect(accumulator.observe(observation(3, {
            title: null,
            kind: null,
            content: null,
            locations: null,
        }))).toMatchObject({
            kind: 'progress',
            call: {
                toolName: 'other',
                status: 'running',
            },
        });
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-1')).not.toHaveProperty('title');
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-1')).not.toHaveProperty('kind');
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-1')).not.toHaveProperty('content');
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-1')).not.toHaveProperty('locations');
    });

    it('allows newer enrichment for a known tombstone after turn closure but rejects new calls for the closed turn', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'pending' }, { toolCallId: 'known' }));
        accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'cancelled',
            revision: 2,
            observedAtMs: 1_002,
        });

        expect(accumulator.observe(observation(3, { title: 'late provider task metadata' }, {
            toolCallId: 'known',
            semanticName: 'SubAgent',
        }))).toMatchObject({
            kind: 'late-enrichment',
            call: { toolCallId: 'known', toolName: 'SubAgent', title: 'late provider task metadata' },
            result: {
                toolCallId: 'known',
                toolName: 'SubAgent',
                status: 'cancelled',
                isError: true,
            },
            publishResult: false,
        });
        expect(accumulator.observe(observation(3, { status: 'in_progress' }, {
            toolCallId: 'unseen-after-close',
        }))).toEqual({ kind: 'ignored', reason: 'closed-beyond-tombstone' });
    });

    it('closes only the requested sidechain namespace while preserving sibling namespaces', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'main-call',
            sidechainId: null,
        }));
        accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'child-call',
            sidechainId: 'child-1',
        }));

        const emissions = accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: 'child-1',
            status: 'cancelled',
            revision: 2,
            observedAtMs: 1_002,
        });
        expect(emissions).toHaveLength(1);
        expect(emissions[0]).toMatchObject({ kind: 'terminal', call: { toolCallId: 'child-call' } });
        expect(accumulator.observe(observation(3, { status: 'in_progress' }, {
            toolCallId: 'main-new',
            sidechainId: null,
        }))).toMatchObject({ kind: 'progress', call: { toolCallId: 'main-new' } });
        expect(accumulator.observe(observation(3, { status: 'in_progress' }, {
            toolCallId: 'child-new',
            sidechainId: 'child-1',
        }))).toEqual({ kind: 'ignored', reason: 'closed-beyond-tombstone' });
    });

    it('uses an omitted sidechain as the all-namespace closure without crossing sessions', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'main-call',
            sidechainId: null,
        }));
        accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'child-call',
            sidechainId: 'child-1',
        }));

        expect(accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'completed',
            revision: 2,
            observedAtMs: 1_002,
        })).toHaveLength(2);
        expect(accumulator.observe(observation(3, { status: 'pending' }, {
            toolCallId: 'blocked-main',
            sidechainId: null,
        }))).toEqual({ kind: 'ignored', reason: 'closed-beyond-tombstone' });
        expect(accumulator.observe(observation(3, { status: 'pending' }, {
            toolCallId: 'blocked-child',
            sidechainId: 'child-2',
        }))).toEqual({ kind: 'ignored', reason: 'closed-beyond-tombstone' });
        expect(accumulator.observe(observation(3, { status: 'pending' }, {
            sessionId: 'session-2',
            toolCallId: 'other-session',
            sidechainId: null,
        }))).toMatchObject({ kind: 'progress', call: { sessionId: 'session-2' } });
    });

    it('lets a newer provider terminal state and richer output revise a host-terminalized tombstone', () => {
        const accumulator = new AcpToolCallAccumulator();
        accumulator.observe(observation(1, { status: 'pending' }));
        accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'cancelled',
            revision: 2,
            observedAtMs: 1_002,
        });

        expect(accumulator.observe(observation(3, {
            status: 'failed',
            error: { code: 'provider_failed' },
        }))).toMatchObject({
            kind: 'late-enrichment',
            call: { status: 'failed' },
            result: { status: 'failed', isError: true },
            publishResult: true,
        });
        expect(accumulator.observe(observation(4, {
            rawOutput: { diagnostic: 'richer' },
        }))).toMatchObject({
            kind: 'late-enrichment',
            result: { status: 'failed', rawOutput: { diagnostic: 'richer' } },
            publishResult: true,
        });
    });

    it('rejects blank identity fields without transforming exact nonblank opaque bytes', () => {
        const accumulator = new AcpToolCallAccumulator();

        expect(() => accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: ' \n\t ',
        }))).toThrow(/identit/i);
        expect(() => accumulator.observe(observation(1, { status: 'pending' }, {
            sessionId: '\t',
        }))).toThrow(/identit/i);
        expect(() => accumulator.observe(observation(1, { status: 'pending' }, {
            turnId: '\n',
        }))).toThrow(/identit/i);
        expect(() => accumulator.observe(observation(1, { status: 'pending' }, {
            sidechainId: ' \t ',
        }))).toThrow(/identit/i);

        expect(accumulator.observe(observation(2, { status: 'completed' }, {
            toolCallId: ' exact-id\n',
        }))).toMatchObject({
            kind: 'terminal',
            call: { toolCallId: ' exact-id\n' },
        });
    });

    it('rejects an invalid identity before it can prune valid lifecycle state', () => {
        const accumulator = new AcpToolCallAccumulator({ tombstoneTtlMs: 100 });
        accumulator.observe(observation(1, { status: 'completed' }, { observedAtMs: 1_000 }));

        expect(() => accumulator.observe(observation(2, { status: 'pending' }, {
            toolCallId: ' \t ',
            observedAtMs: 10_000,
        }))).toThrow(/identit/i);
        expect(accumulator.tombstoneSize).toBe(1);
    });

    it('correlates exact opaque ids while operational ids remain bounded and domain-separated', () => {
        const ids = [' id ', 'id\nnext', 'id\u0000control', `id-${'x'.repeat(100_000)}`];
        const accumulator = new AcpToolCallAccumulator();

        for (const [index, toolCallId] of ids.entries()) {
            const identity = createAcpToolIdentity({
                sessionId: 'session-1',
                turnId: 'turn-1',
                sidechainId: index % 2 === 0 ? null : 'sidechain',
                toolCallId,
            });
            expect(identity.callLocalId.length).toBeLessThanOrEqual(80);
            expect(identity.resultLocalId.length).toBeLessThanOrEqual(80);
            expect(identity.callLocalId).not.toBe(identity.resultLocalId);
            expect(identity.callLocalId).not.toContain(toolCallId);

            const terminal = accumulator.observe(observation(index + 1, {
                status: 'completed',
                rawOutput: index,
            }, {
                toolCallId,
                sidechainId: index % 2 === 0 ? null : 'sidechain',
            }));
            expect(terminal).toMatchObject({
                kind: 'terminal',
                call: { toolCallId, localId: identity.callLocalId },
                result: { localId: identity.resultLocalId },
            });
        }
    });

    it('bounds tombstones, closes turns against replay, and clears all state on reset/dispose', () => {
        const accumulator = new AcpToolCallAccumulator({ maxTombstones: 2, maxClosedTurns: 2 });
        for (let index = 0; index < 3; index += 1) {
            accumulator.observe(observation(index + 1, { status: 'completed' }, { toolCallId: `call-${index}` }));
        }
        expect(accumulator.tombstoneSize).toBe(2);
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-0')).toBeNull();
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-1')).not.toBeNull();
        expect(accumulator.peek('session-1', 'turn-1', null, 'call-2')).not.toBeNull();

        accumulator.observe(observation(10, { status: 'pending' }, { toolCallId: 'open' }));
        accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'failed',
            revision: 11,
            observedAtMs: 2_000,
        });
        expect(accumulator.observe(observation(12, { status: 'in_progress' }, { toolCallId: 'open' }))).toEqual({
            kind: 'ignored',
            reason: 'duplicate',
        });
        accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-2',
            status: 'completed',
            revision: 12,
            observedAtMs: 2_001,
        });
        accumulator.terminalizeTurn({
            sessionId: 'session-1',
            turnId: 'turn-3',
            status: 'completed',
            revision: 13,
            observedAtMs: 2_002,
        });
        expect(accumulator.closedTurnSize).toBe(2);
        expect(accumulator.observe(observation(14, { status: 'pending' }, {
            turnId: 'turn-1',
            toolCallId: 'reopened-after-bounded-close-eviction',
        }))).toMatchObject({ kind: 'progress' });

        accumulator.reset();
        expect(accumulator.activeSize).toBe(0);
        expect(accumulator.tombstoneSize).toBe(0);
        expect(accumulator.closedTurnSize).toBe(0);
        accumulator.observe(observation(13, { status: 'pending' }, { toolCallId: 'after-reset' }));
        accumulator.dispose();
        expect(accumulator.activeSize).toBe(0);
        expect(() => accumulator.observe(observation(14, { status: 'pending' }))).toThrow(/disposed/i);
    });

    it('bounds active records and expires tombstones from their newest enrichment time', () => {
        const accumulator = new AcpToolCallAccumulator({
            maxActiveRecords: 1,
            tombstoneTtlMs: 100,
        });
        accumulator.observe(observation(1, { status: 'pending' }, { toolCallId: 'active-1' }));
        expect(() => accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'active-2',
        }))).toThrow(/capacity/i);

        accumulator.reset();
        accumulator.observe(observation(1, { status: 'completed' }, {
            toolCallId: 'done',
            observedAtMs: 1_950,
        }));
        accumulator.observe(observation(2, { title: 'late' }, {
            toolCallId: 'done',
            observedAtMs: 2_000,
        }));
        accumulator.observe(observation(1, { status: 'pending' }, {
            toolCallId: 'clock-probe',
            turnId: 'turn-2',
            observedAtMs: 2_050,
        }));
        expect(accumulator.tombstoneSize).toBe(1);
        accumulator.observe(observation(2, { status: 'pending' }, {
            toolCallId: 'clock-probe',
            turnId: 'turn-2',
            observedAtMs: 2_101,
        }));
        expect(accumulator.tombstoneSize).toBe(0);
    });
});
