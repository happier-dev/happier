import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import {
    buildActionOperationLedgerSections,
    resolveActionOperationDetailContent,
    resolveActionOperationPresentation,
} from './actionOperationPresentation';

const NOW = 1_700_000_120_000;

function operation(
    operationId: string,
    state: ActionOperationSnapshotV1['state'],
    overrides: Partial<ActionOperationSnapshotV1> = {},
): ActionOperationSnapshotV1 {
    const active = state === 'accepted' || state === 'running';
    return {
        version: 1,
        operationId,
        revision: 1,
        actionId: 'session.spawn_new',
        state,
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-parent' },
        title: `Operation ${operationId}`,
        createdAt: NOW - 120_000,
        ...(state !== 'accepted' ? { startedAt: NOW - 90_000 } : null),
        ...(!active ? { settledAt: NOW - 30_000 } : null),
        ...(state === 'failed' ? { error: { errorCode: 'failed', error: 'Could not finish' } } : null),
        cancellation: 'unsupported',
        ...overrides,
    };
}

describe('action operation presentation', () => {
    it('groups active, attention, and recent operations without duplicating rows', () => {
        const running = operation('running', 'running');
        const failed = operation('failed', 'failed');
        const cancelled = operation('cancelled', 'cancelled');
        const succeeded = operation('succeeded', 'succeeded');

        const sections = buildActionOperationLedgerSections([
            succeeded,
            failed,
            running,
            cancelled,
            running,
        ]);

        expect(sections.inProgress).toEqual([running]);
        expect(sections.needsAttention).toEqual([failed]);
        expect(sections.recent).toEqual([succeeded, cancelled]);
        expect([
            ...sections.inProgress,
            ...sections.needsAttention,
            ...sections.recent,
        ].map((entry) => entry.operationId)).toEqual(['running', 'failed', 'succeeded', 'cancelled']);
    });

    it('keeps terminal truth while projecting reconnecting only onto active work', () => {
        expect(resolveActionOperationPresentation(operation('running', 'running'), 'reconnecting', NOW)).toMatchObject({
            status: 'reconnecting',
            terminal: false,
        });
        expect(resolveActionOperationPresentation(operation('failed', 'failed'), 'reconnecting', NOW)).toMatchObject({
            status: 'failed',
            terminal: true,
        });
    });

    it('moves an unavailable active projection out of In progress and into Needs attention', () => {
        const running = operation('running', 'running');
        const sections = buildActionOperationLedgerSections([running], {
            observationForOperation: () => 'status_unavailable',
        });

        expect(sections.inProgress).toEqual([]);
        expect(sections.needsAttention).toEqual([running]);
    });

    it('shows reported determinate values without inventing a percentage', () => {
        const presentation = resolveActionOperationPresentation(operation('reported', 'running', {
            progress: { kind: 'determinate', current: 3, total: 8, label: 'Copying workspace' },
        }), 'available', NOW);

        expect(presentation.status).toBe('running');
        expect(presentation.progressLabel).toBe('Copying workspace');
        expect(presentation.progressValue).toBe('3 / 8');
        expect(presentation.progressValue).not.toContain('%');
    });

    it('offers Open session only for successful fork and spawn results', () => {
        expect(resolveActionOperationPresentation(operation('fork', 'succeeded', {
            actionId: 'session.fork',
            result: { childSessionId: 'child-1' },
        }), 'available', NOW).openSessionId).toBe('child-1');
        expect(resolveActionOperationPresentation(operation('spawn', 'succeeded', {
            actionId: 'session.spawn_new',
            result: { sessionId: 'child-2' },
        }), 'available', NOW).openSessionId).toBe('child-2');
        expect(resolveActionOperationPresentation(operation('handoff', 'succeeded', {
            actionId: 'session.handoff',
            result: { sessionId: 'session-parent' },
        }), 'available', NOW).openSessionId).toBeNull();
        expect(resolveActionOperationPresentation(operation('running-fork', 'running', {
            actionId: 'session.fork',
            result: { childSessionId: 'not-terminal' },
        }), 'available', NOW).openSessionId).toBeNull();
    });

    it('exposes truthful core result and next action without leaking opaque reconciliation references', () => {
        const fork = resolveActionOperationDetailContent(operation('fork', 'succeeded', {
            actionId: 'session.fork',
            result: { ok: true, childSessionId: 'child-1' },
            domainRef: { kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay' },
        }));
        expect(fork).toMatchObject({
            resultSummary: 'child-1',
            openSessionId: 'child-1',
            warning: null,
            forkStrategy: 'replay',
        });
        expect(fork).not.toHaveProperty('recoveryReference');

        const handoff = resolveActionOperationDetailContent(operation('handoff', 'succeeded', {
            actionId: 'session.handoff',
            result: {
                handoffId: 'handoff-1',
                status: { status: 'completed' },
                warning: { code: 'source_cleanup_failed', message: 'Source is unreachable' },
            },
            domainRef: { kind: 'handoff', id: 'handoff-1' },
        }));
        expect(handoff).toMatchObject({
            resultSummary: 'handoff-1 · completed',
            openSessionId: null,
            warning: 'Source is unreachable',
        });
        expect(handoff).not.toHaveProperty('recoveryReference');
    });

    it('does not present the last in-flight phase after an operation settles', () => {
        const presentation = resolveActionOperationPresentation(operation('spawn', 'succeeded', {
            actionId: 'session.spawn_new',
            settledAt: NOW - 1_000,
            progress: { kind: 'phase', phase: 'custody_confirmed', label: 'Session custody confirmed' },
            result: { type: 'success', sessionId: 'session-1' },
        }), 'available', NOW);

        expect(presentation.progressLabel).toBeNull();
        expect(presentation.progressValue).toBeNull();
    });

    it('surfaces successful custody with failed UI setup as needs-attention without changing daemon lifecycle', () => {
        const succeeded = operation('spawn-setup', 'succeeded', {
            actionId: 'session.spawn_new',
            result: { sessionId: 'session-1' },
        });
        const presentation = resolveActionOperationPresentation(
            succeeded,
            'available',
            NOW,
            { kind: 'setup_needs_attention' },
        );
        const sections = buildActionOperationLedgerSections([succeeded], {
            localPresentationForOperation: () => ({ kind: 'setup_needs_attention' }),
        });

        expect(succeeded.state).toBe('succeeded');
        expect(presentation.status).toBe('setup_needs_attention');
        expect(sections.needsAttention).toEqual([succeeded]);
        expect(sections.recent).toEqual([]);
    });
});
