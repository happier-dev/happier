import { expect, it } from 'vitest';
import * as events from './deploymentActionsV1.js';

it('projects the exact private receipt failure phase without disclosing content', () => {
  const reference = { contentArtifactId: 'receipt', contentHeaderVersion: 2, contentBodyVersion: 3 };
  const artifact = { artifactId: 'receipt', revision: { headerVersion: 2, bodyVersion: 3 },
    header: { kind: 'deployment-receipt.v1', title: 'Private title' },
    body: JSON.stringify({ failure: { code: 'build_failed', phase: 'build' }, secret: 'never project this' }) };
  expect(events.readDeploymentReceiptEventFailureV1(reference, artifact))
    .toEqual({ ok: true, failure: { code: 'build_failed', phase: 'build' } });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, artifactId: 'other' }))
    .toEqual({ ok: false, error: 'deployment_conflict' });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, body: '{}' }))
    .toEqual({ ok: true, failure: null });
  expect(events.readDeploymentReceiptEventFailureV1(reference, { ...artifact, body: '{"failure":{"code":"bad","phase":"invented"}}' }))
    .toEqual({ ok: false, error: 'deployment_content_unavailable' });
  expect(events.DeploymentFailedEventV1Schema.safeParse({ environmentId: 'env', deploymentId: 'receipt', targetLinkId: 'link',
    receiptRevision: 2, observedAt: 10, operation: 'deploy', state: 'failed', phase: 'build', failureCode: 'build_failed', logs: 'private' }).success).toBe(false);
});
