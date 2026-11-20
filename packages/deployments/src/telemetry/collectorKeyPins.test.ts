import { describe, expect, it } from 'vitest';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { readTelemetryCollectorKeyPinsV1 } from './export.js';

// The Home header read and the Account Artifact opener are the reader's genuine boundaries.
function environment(
  id: string,
  telemetryCollector?: {
    machineId: string;
    installationKeyFingerprint: string;
  },
) {
  const detail = createDeploymentEnvironmentDetailV1();
  const header = {
    ...detail.environment,
    id,
    contentArtifactId: `${id}-content`,
  };
  const artifact = ArtifactDocumentV1Schema.parse({
    artifactId: header.contentArtifactId,
    ownerAccountId: 'owner',
    access: 'owner',
    publicAudience: 'none',
    header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: id },
    body: JSON.stringify({
      ...detail.content,
      ...(telemetryCollector ? { telemetryCollector } : {}),
    }),
    revision: {
      headerVersion: header.contentHeaderVersion,
      bodyVersion: header.contentBodyVersion,
    },
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  return { header, artifact };
}
const pin = {
  machineId: 'collector',
  installationKeyFingerprint: 'f'.repeat(43),
};

describe('Environment collector key pins', () => {
  it('reads each admitted Environment pin from its private content, and reports an unbound one as absent', async () => {
    const rows = [environment('pinned', pin), environment('unbound')];
    const opened = new Map(
      rows.map((row) => [row.artifact.artifactId, row.artifact]),
    );
    await expect(
      readTelemetryCollectorKeyPinsV1(['pinned', 'unbound'], {
        listEnvironments: async () => rows.map((row) => row.header),
        readArtifacts: async (ids) => ids.map((id) => opened.get(id) ?? null),
      }),
    ).resolves.toEqual([
      { environmentId: 'pinned', collector: pin },
      { environmentId: 'unbound' },
    ]);
  });

  it('refuses with a typed failure when the reader cannot open an admitted Environment', async () => {
    const row = environment('pinned', pin);
    for (const ports of [
      {
        listEnvironments: async () => [],
        readArtifacts: async () => [row.artifact],
      },
      {
        listEnvironments: async () => [row.header],
        readArtifacts: async () => [null],
      },
    ]) {
      const refused = await readTelemetryCollectorKeyPinsV1(
        ['pinned'],
        ports,
      ).catch((error) => parseActionExecuteFailure(error));
      expect(refused).toMatchObject({
        ok: false,
        errorCode: 'deployment_content_unavailable',
      });
    }
  });
});
