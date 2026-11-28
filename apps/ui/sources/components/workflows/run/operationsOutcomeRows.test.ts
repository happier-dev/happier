import { describe, expect, it } from 'vitest';

import {
  projectOperationsRunOutcome,
  type OperationsRunOutcomeInput,
} from '@/sync/domains/workflows/operationsRunOutcome';

import { t } from '@/text';

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
    const presented = rows({ finding: { ...started, result: {
      preview: { state: 'unavailable' }, workflowInvocation: null, completedAt: null,
    } } });
    expect(presented.map((row) => row.key)).toEqual(['finding', 'recovery']);
    expect(presented[0]).toMatchObject({ session, value: t('workflows.triggers.guided.outcome.inSession') });
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

  it('says the agent finding as plain text: no Markdown emphasis or code marks reach the row', () => {
    const presented = rows({
      finding: {
        ...started,
        result: {
          preview: { state: 'available', text: 'The **failed rollback** of `cmvxxre5g` left it `running`.' },
          workflowInvocation: null,
          completedAt: 1,
        },
      },
    });
    expect(presented[0]!.value).toBe('The failed rollback of cmvxxre5g left it running.');
    // The row draws the agent's own Markdown as a preview (lists stay lists); the plain value is its one-line reading.
    expect(presented[0]!.markdown).toBe('The **failed rollback** of `cmvxxre5g` left it `running`.');
  });

  it('draws the retained full reply as the finding, keeping its plain line for the fallback', () => {
    const full = '## What failed\n\n- The **migration** timed out\n- `db push` never ran';
    const presented = rows({
      finding: {
        ...started,
        result: {
          preview: { state: 'available', text: 'What failed The migration timed out db push never ran' },
          output: { text: full, messageRef: { kind: 'session', session, messageId: 'm-1' } },
          workflowInvocation: null,
          completedAt: 1,
        },
      },
    });
    expect(presented[0]!.markdown).toBe(full);
    expect(presented[0]!.value).toBe('What failed The migration timed out db push never ran');
  });

  describe('evidence links', () => {
    const pullRequest = { title: 'Fix the migration', url: 'https://example.test/pr/12', number: 12, state: 'open' } as never;
    const operation = (id: string, kind: string, state: string, extra: object = {}) => ({
      serverId: 'srv',
      snapshot: { operationId: id, title: `Run ${id}`, state, scope: { machineId: 'm-1' }, domainRef: { kind }, ...extra },
    }) as never;
    const produced = (overrides: object) => ({
      pullRequests: [], approvals: [], operations: [], pendingOperations: [], receipts: [], ...overrides,
    });

    it('hands the finding its commands, each with title, state and exit code', () => {
      const presented = rows({ produced: produced({ operations: [
        operation('pass', 'projectCommand', 'succeeded'),
        operation('fail', 'projectCommand', 'failed', {
          domainRef: { kind: 'projectCommand', exitCode: 3 },
          error: { errorCode: 'project_command_step_failed', error: 'boom' },
        }),
      ] }) });
      expect(presented[0]!.links).toMatchObject([
        { kind: 'operation', operationId: 'pass', title: 'Run pass', detail: t('inbox.actionOperations.status.succeeded') },
        { kind: 'operation', operationId: 'fail', title: 'Run fail', tone: 'danger',
          detail: expect.stringContaining(t('localServices.actions.failure.exitCode', { code: '3' })) },
      ]);
    });

    it('lets the proposal row open the pull request it names, and lists the rest', () => {
      const proposal = rows({ produced: produced({
        pullRequests: [pullRequest],
        approvals: [{ serverId: 'srv', status: 'approved', request: { artifactId: 'appr-1' } }],
      }) }).find((row) => row.key === 'proposal')!;
      expect(proposal.opens).toMatchObject({ kind: 'pullRequest', pullRequest: { url: 'https://example.test/pr/12' } });
      expect(proposal.links.filter((link) => link !== proposal.opens)).toMatchObject([
        { kind: 'approval', artifactId: 'appr-1', detail: t('approvals.status.approved') },
      ]);
    });

    it('never says a decided request is still waiting', () => {
      const approval = (status: string) => rows({ produced: produced({
        approvals: [{ serverId: 'srv', status, request: { artifactId: 'appr-1' } }],
      }) }).find((row) => row.key === 'proposal')!;
      expect(approval('rejected').value).toBe(t('approvals.status.rejected'));
      expect(approval('open').value).toBe(t('workflows.triggers.guided.outcome.awaitingApproval'));
    });

    it('lets the applied row open the receipt it states', () => {
      const applied = rows({ produced: produced({
        receipts: [
          { serverId: 'srv', environmentId: 'env', deploymentId: 'old', state: 'failed' },
          { serverId: 'srv', environmentId: 'env', deploymentId: 'new', state: 'succeeded' },
        ],
      }) }).find((row) => row.key === 'applied')!;
      expect(applied.opens).toMatchObject({ kind: 'receipt', deploymentId: 'new' });
      expect(applied.links.filter((link) => link !== applied.opens)).toMatchObject([
        { kind: 'receipt', deploymentId: 'old' },
      ]);
    });
  });

  it('reads recovery from live health for the same Environment and target', () => {
    const presented = rows({
      subjectReceipt: { id: 'dep-1', environmentId: 'env', targetLinkId: 'link-1' } as never,
      healthServerId: 'srv',
      health: {
        healthFeed: { environmentId: 'env', status: 'ready', members: [] },
        healthAggregate: {
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
