import { describe, expect, it, vi } from 'vitest';
import type { SessionPullRequestStatusResourceResultV1 } from '@happier-dev/triage-protocol/v1';
import { ProtocolActionApprovalRequestCreatedResultSchema } from '@happier-dev/plugin-sdk/protocol';

import { executeTriageSessionPullRequestOperationV1 } from './sessionPullRequestControls.js';
import { TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1 } from './sessionPullRequestStatus.js';
import { createSessionPullRequestOperationsBinding as binding, operationHead as head,
    operationOffers as operations } from './testkit/sessionPullRequestOperations.test-support.js';

function refresh(shown: ReturnType<typeof binding>, next: unknown, retired = false) {
    const previous: SessionPullRequestStatusResourceResultV1 = { kind: 'ready', sessionId: 'session-1', pullRequests: [shown] };
    const current = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode({ contentType: 'application/json', digest: 'refresh',
        bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: 'session-1', pullRequests: [next] })),
    }, retired ? undefined : previous);
    if (current.kind !== 'ready' || !current.pullRequests[0]) throw new Error('Expected canonical projected fixture');
    return current.pullRequests[0];
}

describe('shared Session PR original native operations', () => {
    it('dispatches captured original operands through the authoritative Action without rereading presentation authority', async () => {
        const shown = binding();
        const readCurrent = vi.fn(() => null);
        const executeAction = vi.fn(async () => ({ kind: 'applied' }));
        const choice = { binding: shown, readCurrent, operationId: 'merge', variantId: 'squash' };
        expect(await executeTriageSessionPullRequestOperationV1({ executeAction }, choice)).toEqual({ kind: 'applied' });
        expect(readCurrent).not.toHaveBeenCalled();
        expect(executeAction).toHaveBeenCalledOnce();
        expect(executeAction).toHaveBeenCalledWith(operations.primary.actionRef, operations.primary.variants[1]!.input, undefined);
    });

    it('requires an explicit method and forwards only the latest admitted source variant, without a read', async () => {
        const shown = binding();
        const calls: unknown[] = [];
        const outcome = { kind: 'applied', effect: 'changed' };
        const host = { async executeAction(action: unknown, input: unknown) { calls.push({ action, input }); return outcome; } };
        for (const choice of [{ operationId: 'merge' }, { operationId: 'missing' }, { operationId: 'merge', variantId: 'missing' }]) {
            await expect(executeTriageSessionPullRequestOperationV1(host, {
                binding: shown, ...choice,
            })).resolves.toEqual({ kind: 'unavailable', reason: 'operationUnavailable' });
        }
        expect(calls).toEqual([]);
        const latest = refresh(shown, binding()); // The real producer preserves an equal refresh's baseline.
        const result = await executeTriageSessionPullRequestOperationV1(host, {
            binding: shown, operationId: 'merge', variantId: 'squash',
        });
        expect(result).toBe(outcome);
        const offer = latest.nativeStatus.kind === 'current' ? latest.nativeStatus.value.operations?.primary : null;
        expect(calls).toEqual([{ action: offer?.actionRef, input: offer?.variants[1]?.input }]);
    });

    it('offers no mutation from unavailable presentation facts or a disabled original offer', async () => {
        const original = binding();
        if (original.nativeStatus.kind !== 'current') throw new Error('Expected current fixture');
        const { entry: _entry, ...withoutEntry } = original;
        const candidates = [withoutEntry,
            { ...original, nativeStatus: { ...original.nativeStatus, kind: 'stale', failure: { class: 'transient', code: 'offline' } } },
            { ...original, nativeStatus: { ...original.nativeStatus, value: { ...original.nativeStatus.value,
                operations: { ...operations, primary: { ...operations.primary, disabledReason: 'Source unavailable' } } } } },
        ];
        const executeAction = vi.fn(async () => ({ kind: 'applied' }));
        for (const candidate of candidates) {
            const shown = refresh(original, candidate);
            expect(await executeTriageSessionPullRequestOperationV1({ executeAction }, {
                binding: shown, operationId: 'merge', variantId: 'squash',
            })).toEqual({ kind: 'unavailable', reason: 'operationUnavailable' });
        }
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('does not add a known-head policy to an enabled source cancel offer', async () => {
        const original = binding();
        if (original.nativeStatus.kind !== 'current') throw new Error('Expected current fixture');
        const shown = refresh(original, { ...original, nativeStatus: { ...original.nativeStatus,
            value: { ...original.nativeStatus.value, branch: null } } });
        let effects = 0;
        expect(await executeTriageSessionPullRequestOperationV1({ async executeAction() { effects += 1; return { kind: 'applied' }; } }, {
            binding: shown, operationId: 'cancelAutoMerge',
        })).toEqual({ kind: 'applied' });
        expect(effects).toBe(1);
    });

    it('keeps approval, refusal and uncertain outcomes unchanged and never replays the direct cancel offer', async () => {
        const shown = binding();
        const approval = ProtocolActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            artifactId: 'approval-1', actionId: 'example.forge/actions/auto-merge-set' });
        for (const outcome of [approval, { kind: 'uncertain', failure: { class: 'transient', code: 'responseLost' } },
            { kind: 'refused', reason: 'head_changed' }]) {
            let effects = 0;
            const host = { async executeAction() { effects += 1; return outcome; } };
            expect(await executeTriageSessionPullRequestOperationV1(host, {
                binding: shown, operationId: 'cancelAutoMerge',
            })).toBe(outcome);
            expect(effects).toBe(1);
        }
    });

    it('honors cancelled mounted intent before the host can act', async () => {
        const shown = binding();
        const controller = new AbortController();
        controller.abort();
        let effects = 0;
        await expect(executeTriageSessionPullRequestOperationV1({ async executeAction() { effects += 1; } }, {
            binding: shown, operationId: 'cancelAutoMerge',
        }, { signal: controller.signal })).rejects.toThrow();
        expect(effects).toBe(0);
    });
});
