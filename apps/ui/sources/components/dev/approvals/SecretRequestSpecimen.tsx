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
 * and a registry password). It proves composition only; Continue reaches no real Machine here, and the live
 * journey is judged on a request an agent actually made.
 */
const ARTIFACT_ID = 'secret-request-specimen';

function buildRequest(variant: string, serverId: string, accountId: string) {
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
      actionRequestId: ARTIFACT_ID,
      actionCaller: { kind: 'host' },
    },
  });
  return ApprovalRequestV2Schema.parse({
    v: 2,
    status: 'open',
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
  const present = useArtifact(ARTIFACT_ID) !== null;
  // The Home's artifact sync can replace the store's rows, so the stored request is seeded again whenever it is missing.
  React.useEffect(() => {
    if (!scope || present) return;
    const request = buildRequest(
      props.variant,
      scope.serverId,
      scope.accountId,
    );
    storage
      .getState()
      .updateArtifact({
        id: ARTIFACT_ID,
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
  }, [scope, present, props.variant]);
  return present ? (
    <ApprovalDetailScreen key={props.variant} artifactId={ARTIFACT_ID} />
  ) : null;
}
