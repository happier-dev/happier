import { describe, expect, it } from 'vitest';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import {
  ARTIFACT_HTML_BUNDLE_MIME_V1,
  artifactHtmlBundleFromBodyV1,
} from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import {
  readArtifactPublicNetworkResource,
  writeArtifactNetworkPolicy,
} from './artifactPublicNetworkPreparation';

const scope = { serverId: 'home', accountId: 'owner' };

function openHtml(requestedCapabilities: Record<string, unknown>) {
  const bundle = {
    ...artifactHtmlBundleFromBodyV1('<h1>Release status</h1>'),
    requestedCapabilities,
  };
  const opened = ArtifactActionOutputSchemasV1['artifact.get'].parse({
    artifact: {
      artifactId: 'release-status',
      ownerAccountId: 'owner',
      access: 'owner',
      publicAudience: 'none',
      header: {
        kind: 'html',
        title: 'Release status',
        mime: ARTIFACT_HTML_BUNDLE_MIME_V1,
      },
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      revision: { headerVersion: 2, bodyVersion: 3 },
      body: JSON.stringify(bundle),
    },
  }).artifact!;
  return opened;
}

/** The `artifact.update` Action boundary: records the payload and acknowledges it. */
function recordUpdates() {
  const payloads: Array<
    Readonly<{
      artifactId: string;
      expectedRevision: unknown;
      header: Record<string, unknown>;
      body: string;
    }>
  > = [];
  const request = async (_actionId: 'artifact.update', payload: unknown) => {
    payloads.push(payload as (typeof payloads)[number]);
    return {
      artifactId: 'release-status',
      revision: { headerVersion: 3, bodyVersion: 4 },
    };
  };
  return { payloads, request };
}

describe('the artifact network writer', () => {
  it('saves exact sites for a saved HTML page on its opened revision, keeping its other capabilities', async () => {
    const opened = openHtml({ network: 'open', hostMethods: ['notify'] });
    const resource = await readArtifactPublicNetworkResource({ opened, scope });
    expect(resource.policy).toEqual({ network: 'open', networkOrigins: [] });
    const updates = recordUpdates();
    const written = await writeArtifactNetworkPolicy({
      opened,
      resource,
      request: updates.request,
      isCurrent: () => true,
      policy: {
        network: 'origins',
        networkOrigins: ['https://status.example.com'],
      },
    });
    expect(written).toEqual({
      kind: 'ready',
      policy: {
        network: 'origins',
        networkOrigins: ['https://status.example.com'],
      },
    });
    expect(updates.payloads).toHaveLength(1);
    expect(updates.payloads[0]).toMatchObject({
      artifactId: 'release-status',
      expectedRevision: { headerVersion: 2, bodyVersion: 3 },
    });
    const saved = JSON.parse(updates.payloads[0]!.body);
    // Exact sites are the alternative to an explicit network value, never both.
    expect(saved.requestedCapabilities).toEqual({
      hostMethods: ['notify'],
      networkOrigins: ['https://status.example.com'],
    });
  });

  it('turns the saved document network off through its explicit Network editor writer', async () => {
    const opened = openHtml({ networkOrigins: ['https://status.example.com'] });
    const resource = await readArtifactPublicNetworkResource({ opened, scope });
    const updates = recordUpdates();
    await writeArtifactNetworkPolicy({
      opened,
      resource,
      request: updates.request,
      isCurrent: () => true,
      policy: { network: 'none', networkOrigins: [] },
    });
    expect(JSON.parse(updates.payloads[0]!.body).requestedCapabilities).toEqual(
      { network: 'none' },
    );
  });
});
