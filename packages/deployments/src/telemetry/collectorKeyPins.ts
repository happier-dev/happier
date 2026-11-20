import type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { TelemetryCollectorKeyPinV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import {
  readDeploymentEnvironmentArtifactV1,
  type DeploymentArtifactDocumentV1,
} from '../artifacts/deploymentArtifacts.js';

export type TelemetryCollectorKeyPinPortsV1 = Readonly<{
  /** The reader's own Home header read for these exact Environments. */
  listEnvironments(
    environmentIds: readonly string[],
  ): Promise<readonly DeploymentEnvironmentHeaderV1[]>;
  /** The reader's own Account Artifact opener, in request order; null when unavailable. */
  readArtifacts(
    artifactIds: readonly string[],
  ): Promise<readonly (DeploymentArtifactDocumentV1 | null)[]>;
}>;

/**
 * Opens each admitted Environment's private content with the reader's own
 * opener and returns its collector pin for the codec sealing owner, which
 * decides whether the Home-delivered key may be used.
 */
export async function readTelemetryCollectorKeyPinsV1(
  environmentIds: readonly string[],
  ports: TelemetryCollectorKeyPinPortsV1,
): Promise<TelemetryCollectorKeyPinV1[]> {
  const unavailable = () =>
    createActionExecuteFailureError({
      ok: false,
      errorCode: 'deployment_content_unavailable',
      error: 'deployment_content_unavailable',
      effectAttempted: false,
    });
  const headers = new Map(
    (await ports.listEnvironments(environmentIds)).map((header) => [
      header.id,
      header,
    ]),
  );
  const selected = environmentIds.map((environmentId) =>
    headers.get(environmentId),
  );
  if (selected.some((header) => !header)) throw unavailable();
  const artifacts = await ports.readArtifacts(
    selected.map((header) => header!.contentArtifactId),
  );
  return selected.map((header, index) => {
    const content = readDeploymentEnvironmentArtifactV1(
      header!,
      artifacts[index] ?? null,
    );
    if (!content.ok) throw unavailable();
    const collector = content.content.telemetryCollector;
    return { environmentId: header!.id, ...(collector ? { collector } : {}) };
  });
}
