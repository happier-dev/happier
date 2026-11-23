import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { resolveActionTitle } from '@/text/actionTitles';
import { readApprovalResultReceiptText } from './approvalResultInput';

function receipt(payload: Record<string, unknown>) {
  return {
    localId: 'approval-result:artifact-1',
    text: JSON.stringify({ actionId: 'browser.workspace.open', ...payload }),
    meta: {
      happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
    },
  };
}

describe('readApprovalResultReceipt', () => {
  const action = resolveActionTitle('browser.workspace.open', null);

  it('reads an approved Action that ran as approved', () => {
    expect(
      readApprovalResultReceiptText(
        receipt({
          status: 'approved',
          execution: { executedAtMs: 2, ok: true },
        }),
      ),
    ).toBe(t('message.approvalResult', { action }));
  });

  it('never reads an approved Action whose run failed as a success; its cause stays on the card', () => {
    const text = readApprovalResultReceiptText(
      receipt({
        status: 'approved',
        execution: {
          executedAtMs: 2,
          ok: false,
          errorCode: 'runtime_action_disabled',
        },
      }),
    );
    expect(text).toBe([t('approvals.status.failed'), action].join(' · '));
  });
});
