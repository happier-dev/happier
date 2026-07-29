import { describe, expect, it } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { presentExternalSessionOperationShell } from './externalSessionOperationShellPresentation';

function createProgress(input: Readonly<{
    plan: 'materialize' | 'takeover';
    status: ExternalSessionOperationSharedPresentationV1['status'];
}>): ExternalSessionOperationSharedPresentationV1 {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 1,
        kind: input.plan === 'materialize'
            ? 'materialize'
            : 'takeover_persisted',
        status: input.status,
        phase: 'validating',
    });
}

describe('presentExternalSessionOperationShell', () => {
    it.each([
        ['materialize', 'externalSessions.operationComposerImporting'],
        ['takeover', 'externalSessions.operationComposerTakingOver'],
    ] as const)('disables the composer with plan-specific text for active %s progress', (plan, placeholderKey) => {
        expect(presentExternalSessionOperationShell(createProgress({
            plan,
            status: 'running',
        }))).toEqual({
            running: true,
            blocksNewOperation: true,
            composerPlaceholderKey: placeholderKey,
        });
    });

    it.each([
        'cancelled',
        'completed',
        'discarded',
    ] as const)('allows a fresh operation after durable terminal %s progress', (status) => {
        expect(presentExternalSessionOperationShell(createProgress({
            plan: 'materialize',
            status,
        }))).toEqual({
            running: false,
            blocksNewOperation: false,
            composerPlaceholderKey: null,
        });
    });

    it.each([
        'awaiting_user_resume',
        'failed',
        'reconciliation_required',
    ] as const)('keeps durable recovery progress as the sole operation action owner for %s', (status) => {
        expect(presentExternalSessionOperationShell(createProgress({
            plan: 'materialize',
            status,
        }))).toEqual({
            running: false,
            blocksNewOperation: true,
            composerPlaceholderKey: null,
        });
    });

    it('keeps the composer disabled while cancellation is still pending', () => {
        expect(presentExternalSessionOperationShell(createProgress({
            plan: 'takeover',
            status: 'cancel_requested',
        }))).toEqual({
            running: true,
            blocksNewOperation: true,
            composerPlaceholderKey: 'externalSessions.operationComposerTakingOver',
        });
    });
});
