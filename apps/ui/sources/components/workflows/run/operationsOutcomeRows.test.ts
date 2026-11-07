import { describe, expect, it } from 'vitest';

import {
  projectOperationsRunOutcome,
  type OperationsRunOutcomeInput,
} from '@/sync/domains/workflows/operationsRunOutcome';

import { presentOperationsOutcomeRows } from './operationsOutcomeRows';

const subject = {
  kind: 'deploymentReceipt',
  serverId: 'srv',
  environmentId: 'env',
  deploymentId: 'dep-1',
} as const;
const session = { serverId: 'srv', sessionId: 'ses-1' };
const started = {
  kind: 'investigate',
  session,
  result: null,
} as const;

function rows(input: Partial<OperationsRunOutcomeInput>) {
  return presentOperationsOutcomeRows(
    projectOperationsRunOutcome({
      subject,
      finding: started,
      ...input,
    } as OperationsRunOutcomeInput),
  );
}

describe('presentOperationsOutcomeRows', () => {
  it('shows only the finding and recovery when nothing was proposed or applied', () => {
    const presented = rows({});
    expect(presented.map((row) => row.key)).toEqual(['finding', 'recovery']);
    expect(presented[0]).toMatchObject({ session });
    expect(presented[1]).not.toHaveProperty('tone');
    expect(presented[1]).toMatchObject({ known: false });
  });

  it('keeps a proposal and an applied effect as separate rows', () => {
    const presented = rows({
      approval: {
        kind: 'approvalRequestCreated',
        artifactId: 'appr-1',
      } as never,
      receipt: { id: 'dep-2', state: 'succeeded' } as never,
    });
    expect(presented.map((row) => row.key)).toEqual([
      'finding',
      'proposal',
      'applied',
      'recovery',
    ]);
  });

  it('takes the finding text from the ready result preview, never a guessed success', () => {
    const presented = rows({
      finding: {
        ...started,
        result: {
          preview: { state: 'available', text: 'The migration timed out.' },
          workflowInvocation: null,
          completedAt: 1,
        },
      },
    });
    expect(presented[0]).toMatchObject({ value: 'The migration timed out.' });
  });

  it('reads recovery from live health for the same Environment and target', () => {
    const presented = rows({
      subjectReceipt: { id: 'dep-1', environmentId: 'env', targetLinkId: 'link-1' } as never,
      healthServerId: 'srv',
      health: {
        environmentId: 'env',
        status: 'ready',
        members: [],
        aggregate: {
          environmentId: 'env',
          targetLinkId: 'link-1',
          status: 'down',
          n: 1,
          down: 1,
          degraded: 0,
        },
      } as never,
    });
    expect(presented.at(-1)).toMatchObject({
      key: 'recovery',
      tone: 'danger',
      known: true,
    });
  });
});
