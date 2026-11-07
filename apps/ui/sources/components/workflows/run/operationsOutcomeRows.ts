import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

import {
  deploymentHealthFact,
  deploymentStateLabel,
} from '@/components/projects/deployments/deploymentPresentation';
import type { OperationsRunOutcome } from '@/sync/domains/workflows/operationsRunOutcome';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import { t } from '@/text';
import { stripMarkdown } from '@/utils/sessions/messageUtils';

export type OperationsOutcomeLink =
  | Readonly<{ kind: 'pullRequest'; pullRequest: ScmPullRequestSummary }>
  | Readonly<{ kind: 'approval'; serverId: string; artifactId: string }>
  | Readonly<{ kind: 'operation'; serverId: string; machineId: string; operationId: string }>
  | Readonly<{ kind: 'receipt'; serverId: string; environmentId: string; deploymentId: string }>;

export type OperationsOutcomeRow = Readonly<{
  key: 'finding' | 'proposal' | 'applied' | 'recovery';
  title: string;
  value: string;
  /** Finding only: the agent's own Markdown, drawn as a preview; `value` is its plain one-line reading. */
  markdown?: string;
  tone?: 'danger' | 'attention';
  /** The Session that holds the finding, when there is one to open. */
  session?: ActionSessionAddressV1;
  /** Recovery only: whether live health actually answered for this subject. */
  known?: boolean;
  /** Addresses for the existing PR, approval, operation and receipt views. */
  links: readonly OperationsOutcomeLink[];
  /** Actual command snapshots (title, state and projectCommand.exitCode), never parsed test claims. */
  executions: readonly QualifiedActionOperation[];
}>;
type OutcomeContentRow = Omit<OperationsOutcomeRow, 'links' | 'executions'>;

/**
 * D3: what a run found, what it proposes, what it changed and whether the subject recovered, as
 * distinct rows. Proposal and applied effect appear only when their owners supplied them; recovery
 * always speaks, because "not known" is itself the honest answer.
 */
export function presentOperationsOutcomeRows(
  outcome: OperationsRunOutcome,
): readonly OperationsOutcomeRow[] {
  const rows: OutcomeContentRow[] = [findingRow(outcome.finding)];
  const { pullRequest, approval } = outcome.proposal;
  if (pullRequest || approval) {
    rows.push({
      key: 'proposal',
      title: t('workflows.triggers.guided.outcome.proposal'),
      value: pullRequest
        ? pullRequest.title
        : t('workflows.triggers.guided.outcome.awaitingApproval'),
    });
  }
  const { operation, receipt, receiptReference } = outcome.appliedEffect;
  if (operation || receipt || receiptReference || outcome.produced.pendingOperations.length > 0) {
    rows.push({
      key: 'applied',
      title: t('workflows.triggers.guided.outcome.applied'),
      value: receipt || receiptReference
        ? deploymentStateLabel((receipt ?? receiptReference)!.state)
        : t(operation ? 'workflows.triggers.guided.outcome.actionRan' : 'workflows.triggers.guided.outcome.working'),
    });
  }
  rows.push(recoveryRow(outcome.recovery));
  const executions = outcome.produced.operations.filter(operation => operation.snapshot.domainRef?.kind === 'projectCommand');
  return rows.map(row => ({ ...row,
    executions: row.key === 'finding' ? executions : [],
    links: linksForRow(row.key, outcome),
  }));
}

function linksForRow(key: OperationsOutcomeRow['key'], outcome: OperationsRunOutcome): readonly OperationsOutcomeLink[] {
  const produced = outcome.produced;
  if (key === 'proposal') return [
    ...produced.pullRequests.map(pullRequest => ({ kind: 'pullRequest' as const, pullRequest })),
    ...produced.approvals.map(({ serverId, request }) => ({ kind: 'approval' as const, serverId, artifactId: request.artifactId })),
  ];
  if (key === 'recovery') return [];
  const operations = produced.operations.filter(operation => (operation.snapshot.domainRef?.kind === 'projectCommand') === (key === 'finding'));
  return [
    ...(key === 'applied' ? produced.pendingOperations.map(address => ({ kind: 'operation' as const, ...address })) : []),
    ...operations.map(({ serverId, snapshot }) => ({ kind: 'operation' as const, serverId,
      machineId: snapshot.scope.machineId, operationId: snapshot.operationId })),
    ...(key === 'applied' ? produced.receipts.map(({ serverId, environmentId, deploymentId }) => ({
      kind: 'receipt' as const, serverId, environmentId, deploymentId,
    })) : []),
  ];
}

function findingRow(
  finding: OperationsRunOutcome['finding'],
): OutcomeContentRow {
  const title = t('workflows.triggers.guided.outcome.finding');
  if (finding.kind === 'workflow') {
    return {
      key: 'finding',
      title,
      value: t(
        finding.result
          ? 'workflows.triggers.guided.outcome.reported'
          : 'workflows.triggers.guided.outcome.working',
      ),
    };
  }
  const session = finding.session;
  const preview = finding.result?.preview;
  const value =
    // The agent writes Markdown; a one-line row says it as plain text, the same projection message previews use.
    preview?.state === 'available'
      ? stripMarkdown(preview.text)
      : finding.result
        ? t('workflows.triggers.guided.outcome.reported')
        // Whether the agent finished lives in its Session; this row never guesses.
        : t(session ? 'workflows.triggers.guided.outcome.inSession' : 'workflows.triggers.guided.outcome.working');
  return { key: 'finding', title, value, ...(preview?.state === 'available' ? { markdown: preview.text } : {}),
    ...(session ? { session } : {}) };
}

function recoveryRow(
  recovery: OperationsRunOutcome['recovery'],
): OutcomeContentRow {
  const title = t('workflows.triggers.guided.outcome.recovery');
  if (recovery.kind === 'unavailable')
    return {
      key: 'recovery',
      title,
      value: t('workflows.triggers.guided.outcome.healthUnknown'),
      known: false,
    };
  if (recovery.coverage === 'loading')
    return {
      key: 'recovery',
      title,
      value: t('workflows.triggers.guided.outcome.healthChecking'),
      known: false,
    };
  if (recovery.kind === 'observed') {
    const fact = deploymentHealthFact(recovery.health);
    return {
      key: 'recovery',
      title,
      value: fact.value,
      known: true,
      ...(fact.tone ? { tone: fact.tone } : {}),
    };
  }
  const service = recovery.health;
  if (service.expectedDown === 'stop')
    return {
      key: 'recovery',
      title,
      value: t('workflows.triggers.guided.outcome.stopped'),
      known: true,
    };
  const fact = deploymentHealthFact({
    status: service.state,
    n: 1,
    down: service.state === 'down' ? 1 : 0,
    degraded: service.state === 'degraded' ? 1 : 0,
  });
  return {
    key: 'recovery',
    title,
    value: fact.value,
    known: true,
    ...(fact.tone ? { tone: fact.tone } : {}),
  };
}
