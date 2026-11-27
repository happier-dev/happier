import assert from 'node:assert/strict';
import { it } from 'vitest';

import { applyDeploymentPreviewHeadV1, isReadyDeploymentPreviewDomainV1, projectDeploymentPreviewStateV1 } from './deploymentPreviewProvenanceV1.js';

it('requires an active Domain on the exact preview runtime before a succeeded receipt reads as deployed', () => {
    const runtime = { id: 'runtime', environmentId: 'preview' };
    const domain = { environmentId: runtime.environmentId, targetLinkId: runtime.id, state: 'active' } as const;
    assert.equal(isReadyDeploymentPreviewDomainV1(domain, runtime), true);
    assert.equal(isReadyDeploymentPreviewDomainV1({ ...domain, state: 'warning' }, runtime), false);
    assert.equal(isReadyDeploymentPreviewDomainV1({ ...domain, targetLinkId: 'old-runtime' }, runtime), false);
    assert.equal(isReadyDeploymentPreviewDomainV1({ ...domain, deletedAtMs: 1 }, runtime), false);
    const receipt = { operation: 'deploy', state: 'succeeded' } as const;
    assert.equal(projectDeploymentPreviewStateV1(receipt, null), 'deploying');
    assert.equal(projectDeploymentPreviewStateV1(receipt, 'https://preview.example.test/'), 'ready');
});

it('hides the preview URL once the observed pull request head is newer', () => {
    const preview = { state: 'ready', servingSha: 'abcd', targetUrl: 'https://preview.example.test/' } as const;
    assert.deepEqual(applyDeploymentPreviewHeadV1(preview, 'ABCD'), { state: 'ready', targetUrl: preview.targetUrl });
    assert.deepEqual(applyDeploymentPreviewHeadV1(preview, 'abcd1'), { state: 'outdated', targetUrl: null });
});
