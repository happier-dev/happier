import { expect, it } from 'vitest';
import * as events from './deploymentActionsV1.js';

it('supports kind-wide deployment receipt observation without an Environment selector', () => {
  const input = { v: 1, serverId: 'home' };
  expect(events.DeploymentReceiptEventSetupV1Schema.parse(input)).toEqual(input);
  const source = { ...input, observingSince: 10 };
  expect(events.DeploymentReceiptEventSourceConfigV1Schema.parse(source)).toEqual(source);
  expect(events.readDeploymentReceiptEventSubjectV1(source)).toBeNull();
  expect(events.DeploymentReceiptEventSetupV1Schema.safeParse({ ...input, targetLinkId: 'target' }).success).toBe(false);
  expect(events.DeploymentReceiptEventSetupV1Schema.safeParse({ ...input, previewChildren: true }).success).toBe(false);
  expect(events.DeploymentReceiptListInputV1Schema.safeParse({ serverId: 'home' }).success).toBe(false);
  const receiptAddress = { serverId: 'home', environmentId: 'environment' };
  expect(events.DeploymentReceiptListInputV1Schema.parse(receiptAddress)).toEqual(receiptAddress);
});

it('projects the exact private receipt failure phase without disclosing content', () => {
  const reference = { contentArtifactId: 'receipt', contentHeaderVersion: 2, contentBodyVersion: 3 };
  const artifact = { artifactId: 'receipt', revision: { headerVersion: 2, bodyVersion: 3 },
    header: { kind: 'deployment-receipt.v1', title: 'Private title' },
    body: JSON.stringify({ failure: { code: 'build_failed', phase: 'build' }, secret: 'never project this' }) };
  expect(events.readDeploymentReceiptEventFailureV1(reference, artifact))
    .toEqual({ ok: true, failure: { code: 'build_failed', phase: 'build' } });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, artifactId: 'other' }))
    .toMatchObject({ ok: false, error: 'deployment_conflict', failureCause: { phase: 'deployment.artifact.revision' } });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, body: '{}' }))
    .toEqual({ ok: true, failure: null });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, body: '{"failure":{"code":"bad","phase":"invented"}}' }))
    .toMatchObject({ ok: false, error: 'deployment_content_unavailable', failureCause: { phase: 'deployment.artifact.content' } });
  expect(events.DeploymentFailedEventV1Schema.safeParse({ environmentId: 'env', deploymentId: 'receipt', targetLinkId: 'link',
    receiptRevision: 2, observedAt: 10, operation: 'deploy', state: 'failed', phase: 'build', failureCode: 'build_failed', logs: 'private' }).success).toBe(false);
});
