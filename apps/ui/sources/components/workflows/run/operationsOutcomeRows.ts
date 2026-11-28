import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

import {
  deploymentHealthFact,
  deploymentStateLabel,
} from '@/components/projects/deployments/deploymentPresentation';
import type { OperationsRunOutcome } from '@/sync/domains/workflows/operationsRunOutcome';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import {
  describeActionOperationStatusLabel,
  readProjectCommandStepExitCode,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { t } from '@/text';
import { stripMarkdown } from '@/utils/sessions/messageUtils';

/** What a link row says about the thing it opens. */
type OperationsOutcomeLinkFace = Readonly<{ title: string; detail?: string; tone?: 'danger' }>;

export type OperationsOutcomeLink = OperationsOutcomeLinkFace & (
  | Readonly<{ kind: 'pullRequest'; pullRequest: ScmPullRequestSummary }>
  | Readonly<{ kind: 'approval'; serverId: string; artifactId: string }>
  | Readonly<{ kind: 'operation'; serverId: string; machineId: string; operationId: string }>
  | Readonly<{ kind: 'receipt'; serverId: string; environmentId: string; deploymentId: string }>
);

export type OperationsOutcomeRow = Readonly<{
  key: 'finding' | 'proposal' | 'applied' | 'recovery';
  title: string;
  value: string;
  /** Finding only: the agent's full retained reply as Markdown; `value` is its plain one-line reading. */
  markdown?: string;
  tone?: 'danger' | 'attention';
  /** The Session that holds the finding, when there is one to open. */
  session?: ActionSessionAddressV1;
  /** Recovery only: whether live health actually answered for this subject. */
  known?: boolean;
  /** Addresses for the existing PR, approval, operation and receipt views; a finding's are its commands. */
  links: readonly OperationsOutcomeLink[];
  /** The one link this row's own value names, so the row opens it rather than repeating it beneath. */
  opens?: OperationsOutcomeLink;
}>;
type OutcomeContentRow = Omit<OperationsOutcomeRow, 'links' | 'opens'>;

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
        : approvalFact(outcome, approval?.artifactId),
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
  return rows.map(row => {
    const links = linksForRow(row.key, outcome);
    const opens = namedLink(row.key, links, outcome);
    return { ...row, links, ...(opens ? { opens } : {}) };
  });
}

/** A decided request never reads as still waiting; only the Artifact's own status says otherwise. */
function approvalFact(outcome: OperationsRunOutcome, artifactId: string | undefined): string {
  const status = outcome.produced.approvals.find(({ request }) => request.artifactId === artifactId)?.status;
  return status && status !== 'open'
    ? formatApprovalStatusLabel(status)
    : t('workflows.triggers.guided.outcome.awaitingApproval');
}

function namedLink(
  key: OperationsOutcomeRow['key'],
  links: readonly OperationsOutcomeLink[],
  outcome: OperationsRunOutcome,
): OperationsOutcomeLink | undefined {
  if (key === 'proposal') {
    const { pullRequest, approval } = outcome.proposal;
    return links.find(link => pullRequest
      ? link.kind === 'pullRequest' && link.pullRequest === pullRequest
      : link.kind === 'approval' && link.artifactId === approval?.artifactId);
  }
  if (key !== 'applied') return undefined;
  const { receipt, receiptReference, operation } = outcome.appliedEffect;
  const deploymentId = receipt?.id ?? receiptReference?.deploymentId;
  if (deploymentId) return links.find(link => link.kind === 'receipt' && link.deploymentId === deploymentId);
  return links.find(link => link.kind === 'operation' && (!operation || link.operationId === operation.snapshot.operationId));
}

function operationFace(snapshot: QualifiedActionOperation['snapshot']): OperationsOutcomeLinkFace {
  const status = resolveActionOperationStatus(snapshot, 'available');
  const exitCode = readProjectCommandStepExitCode(snapshot);
  return {
    title: snapshot.title,
    detail: joinHappierFacts(
      describeActionOperationStatusLabel(status.label),
      exitCode === null ? null : t('localServices.actions.failure.exitCode', { code: String(exitCode) }),
    ),
    ...(status.tone === 'danger' ? { tone: 'danger' as const } : {}),
  };
}

function linksForRow(key: OperationsOutcomeRow['key'], outcome: OperationsRunOutcome): readonly OperationsOutcomeLink[] {
  const produced = outcome.produced;
  if (key === 'proposal') return [
    ...produced.pullRequests.map(pullRequest => ({ kind: 'pullRequest' as const, pullRequest, title: pullRequest.title })),
    ...produced.approvals.map(({ serverId, request }) => ({
      kind: 'approval' as const, serverId, artifactId: request.artifactId,
      title: t('workflows.triggers.guided.outcome.proposal'), detail: approvalFact(outcome, request.artifactId),
    })),
  ];
  if (key === 'recovery') return [];
  // Command execution is the finding's evidence; every other operation is an applied effect.
  const operations = produced.operations.filter(operation => (operation.snapshot.domainRef?.kind === 'projectCommand') === (key === 'finding'));
  return [
    ...(key === 'applied' ? produced.pendingOperations.map(address => ({
      kind: 'operation' as const, ...address, title: t('workflows.triggers.guided.outcome.working'),
    })) : []),
    ...operations.map(({ serverId, snapshot }) => ({ kind: 'operation' as const, serverId,
      machineId: snapshot.scope.machineId, operationId: snapshot.operationId, ...operationFace(snapshot) })),
    ...(key === 'applied' ? produced.receipts.map(({ serverId, environmentId, deploymentId, state }) => ({
      kind: 'receipt' as const, serverId, environmentId, deploymentId,
      title: t('workflows.triggers.guided.outcome.applied'), detail: deploymentStateLabel(state),
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
      : finding.result?.completedAt != null
        ? t('workflows.triggers.guided.outcome.reported')
        // Whether the agent finished lives in its Session; this row never guesses.
        : t(session ? 'workflows.triggers.guided.outcome.inSession' : 'workflows.triggers.guided.outcome.working');
  // The preview is flattened to one line; the full reply keeps the agent's headings, lists and links.
  const markdown = finding.result?.output?.text ?? (preview?.state === 'available' ? preview.text : undefined);
  return { key: 'finding', title, value, ...(markdown ? { markdown } : {}),
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
