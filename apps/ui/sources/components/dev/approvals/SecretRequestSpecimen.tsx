import * as React from 'react';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';

import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage, useArtifact } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * Dev-only specimen of an Action waiting for a declared secret input (CRED-ASK), drawn by the real
 * ApprovalDetailScreen over a stored request whose `preview.confidentialInputs` has the shape the executor
 * writes. `?variant=single` (default: a webhook signing secret) or `two` (a plugin deploy needing an API token
 * and a registry password). The settled receipts reuse the single request: `executed` (value-free success),
 * `refused` (the Home refused the signed request: the executor's typed authorization cause) and `unknown`
 * (the outcome-unknown projection). It proves composition only; Continue reaches no real Machine here, and the
 * live journey is judged on a request an agent actually made.
 */
const ARTIFACT_ID_PREFIX = 'secret-request-specimen';

/** Settled records in the shapes the executor stores (`projectApprovalExecutionOutcomeUnknownV1` for unknown). */
const SETTLED_RECEIPTS = {
  executed: { status: 'executed', execution: { ok: true, effectAttempted: true, result: { channelId: 'release-alerts' } } },
  // `externalActionHeaderRefusalFailure`: the Home did not admit the signed request, so nothing ran.
  refused: { status: 'failed', execution: { ok: false, effectAttempted: false, errorCode: 'action_failed',
    error: 'External Action authorization unavailable: not_authenticated',
    details: { authorizationRefusalReason: 'not_authenticated' },
    failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null } } },
  unknown: { status: 'outcome_unknown', execution: { ok: false, effectAttempted: true,
    errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
    details: { reasonCode: 'action_transport_unavailable' } } },
} as const;

function buildRequest(variant: string, serverId: string, accountId: string, artifactId: string) {
  const two = variant === 'two';
  const actionId = two
    ? 'action.invoke'
    : 'notifications.webhooks.signingSecret.set';
  const actionArgs = two
    ? {
        action: { pluginId: 'happier.deploy.fly', localId: 'deploy' },
        input: { app: 'harbor-ledger', region: 'ams' },
      }
    : { channelId: 'release-alerts' };
  const paths = two ? ['input.apiToken', 'input.registryPassword'] : ['secret'];
  const summary = two
    ? 'Deploy harbor-ledger to Fly'
    : 'Set the signing secret for release alerts';
  const executionOriginV1 = buildApprovalExecutionOriginV1({
    actionId,
    input: actionArgs,
    targetSessionId: null,
    context: {
      surface: 'agent',
      authority: 'account_automation',
      serverId,
      runtimeAccountId: accountId,
      actionRequestId: artifactId,
      actionCaller: { kind: 'host' },
    },
  });
  const settled = SETTLED_RECEIPTS[variant as keyof typeof SETTLED_RECEIPTS];
  return ApprovalRequestV2Schema.parse({
    v: 2,
    status: settled?.status ?? 'open',
    ...(settled ? {
      decision: { kind: 'approve', decidedAtMs: Date.now() - 45_000, authority: 'present_user' },
      execution: { ...settled.execution, executedAtMs: Date.now() - 30_000 },
    } : {}),
    createdAtMs: Date.now() - 90_000,
    updatedAtMs: Date.now() - 90_000,
    createdBy: { surface: 'agent' },
    requestedSurface: 'agent',
    actionId,
    actionArgs,
    // The executor records the Machine that will run the Action; the specimen names one.
    executionOriginV1: executionOriginV1 && { ...executionOriginV1, machineId: 'machine-specimen' },
    summary,
    preview: {
      actionId,
      actionArgs,
      summary,
      confidentialInputs: { kind: 'action_inputs', paths },
    },
  });
}

export function SecretRequestSpecimen(props: Readonly<{ variant: string }>) {
  const scope = useActiveServerAccountScope();
  // One stored request per variant, so switching variants never shows the previous one.
  const artifactId = `${ARTIFACT_ID_PREFIX}-${props.variant}`;
  const present = useArtifact(artifactId) !== null;
  // The Home's artifact sync can replace the store's rows, so the stored request is seeded again whenever it is missing.
  React.useEffect(() => {
    if (!scope || present) return;
    const request = buildRequest(
      props.variant,
      scope.serverId,
      scope.accountId,
      artifactId,
    );
    storage
      .getState()
      .updateArtifact({
        id: artifactId,
        header: buildApprovalRequestArtifactHeaderV1(request),
        title: request.summary ?? '',
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: Date.now(),
        isDecrypted: true,
      } satisfies DecryptedArtifact);
  }, [scope, present, props.variant, artifactId]);
  return present ? (
    <ApprovalDetailScreen key={artifactId} artifactId={artifactId} />
  ) : null;
}
