import { createHash } from 'node:crypto';

import {
  ExecutionRunHostActionApprovalRequestV1Schema,
  redactBugReportSensitiveText,
  type ExecutionRunHostActionApprovalRequestV1,
  type ReviewCommentProposalV1,
} from '@happier-dev/protocol';

import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator';
import { executionRunHostActionApprovalSubjectsEqual } from './executionRunHostActionApprovalSubject';

export type ExecutionRunHostActionCurrentIntentSubject = Readonly<{
  actionId: 'reviews.comments.create';
  sessionId: string;
  runId: string;
  callId: string;
  profileId: string;
  pluginId: string;
  agentId: string;
  projectId: string;
  workspaceId: string;
  serverId: string;
  proposals: readonly ReviewCommentProposalV1[];
  subjectFingerprint: string;
}>;

export type ExecutionRunHostActionCurrentIntentResult =
  | Readonly<{ status: 'approved'; fingerprint: string }>
  | Readonly<{ status: 'rejected' | 'unavailable'; code: string }>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function proposalPreview(proposal: ReviewCommentProposalV1) {
  const startLine = proposal.anchor.kind === 'line'
    ? proposal.anchor.line
    : proposal.anchor.kind === 'range'
      ? proposal.anchor.startLine
      : undefined;
  const endLine = proposal.anchor.kind === 'line'
    ? proposal.anchor.line
    : proposal.anchor.kind === 'range'
      ? proposal.anchor.endLine
      : undefined;
  return {
    ...(proposal.findingId ? { findingId: proposal.findingId } : {}),
    pathLabel: redactBugReportSensitiveText(proposal.anchor.filePath).slice(0, 512),
    pathSha256: sha256(proposal.anchor.filePath),
    ...(startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {}),
    ...(proposal.severity ? { severity: proposal.severity } : {}),
    bodySha256: sha256(proposal.body),
    bodyPreview: redactBugReportSensitiveText(proposal.body).slice(0, 1_024),
  };
}

export function createExecutionRunHostActionCurrentIntentAdapter(deps: Readonly<{
  create: (request: ExecutionRunHostActionApprovalRequestV1) => Promise<Readonly<{ artifactId: string }>>;
  read: (artifactId: string) => Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  now?: () => number;
}>): (subject: ExecutionRunHostActionCurrentIntentSubject) => Promise<ExecutionRunHostActionCurrentIntentResult> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  return async (subject) => {
    const now = (deps.now ?? Date.now)();
    const request = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1,
      kind: 'execution_run_host_action',
      status: 'open',
      createdAtMs: now,
      updatedAtMs: now,
      createdBy: { surface: 'agent', sessionId: subject.sessionId },
      requestedSurface: 'agent',
      actionId: subject.actionId,
      sessionId: subject.sessionId,
      runId: subject.runId,
      callId: subject.callId,
      profileId: subject.profileId,
      pluginId: subject.pluginId,
      agentId: subject.agentId,
      projectId: subject.projectId,
      workspaceId: subject.workspaceId,
      serverId: subject.serverId,
      proposalCount: subject.proposals.length,
      proposalPreview: subject.proposals.slice(0, 20).map(proposalPreview),
      subjectFingerprint: subject.subjectFingerprint,
      summary: `Create ${subject.proposals.length} proposed review comment${subject.proposals.length === 1 ? '' : 's'}`,
    });
    let created: Readonly<{ artifactId: string }>;
    try {
      created = await deps.create(request);
    } catch {
      return { status: 'unavailable', code: 'execution_run_host_action_current_intent_unavailable' };
    }

    try {
      const result = await coordinator.waitForDecision({
        artifactId: created.artifactId,
        request,
        readRequest: () => deps.read(created.artifactId),
      });
      const decided = ExecutionRunHostActionApprovalRequestV1Schema.safeParse(result.request);
      if (!decided.success
        || decided.data.subjectFingerprint !== subject.subjectFingerprint
        || !executionRunHostActionApprovalSubjectsEqual(request, decided.data)) {
        return { status: 'unavailable', code: 'execution_run_host_action_current_intent_mismatch' };
      }
      return result.decision === 'approve'
        ? { status: 'approved', fingerprint: subject.subjectFingerprint }
        : { status: 'rejected', code: 'execution_run_host_action_current_intent_rejected' };
    } catch {
      return { status: 'unavailable', code: 'execution_run_host_action_current_intent_unavailable' };
    }
  };
}
