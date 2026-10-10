import { describe, expect, it, vi } from 'vitest';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { resolveExecutionRunBackendLabel } from './resolveExecutionRunBackendLabel';

const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot',
    title: 'Account review helper', command: 'acp', args: [], createdAt: 1, updatedAt: 1 }] });

describe('resolveExecutionRunBackendLabel', () => {
    it('projects a configured Run label from the ready Account row after Settings root removal', () => {
        const catalog: AcpCatalogSnapshotV1 = { status: 'ready', revision: 3, record };
        expect(resolveExecutionRunBackendLabel({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }, catalog))
            .toBe('Account review helper');
    });

    it('projects built-in backend labels from the canonical agent display name instead of the raw id', () => {
        expect(resolveExecutionRunBackendLabel({
            kind: 'backend',
            backendId: 'codex',
        })).toBe('t:agentInput.agent.codex');
    });
    it('keeps a diagnostic configured id rather than granting an incomplete row title authority', () => {
        expect(resolveExecutionRunBackendLabel({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            { status: 'partial', reason: 'incomplete-inventory', record, diagnostics: [] }))
            .toBe('review-bot');
    });
});
