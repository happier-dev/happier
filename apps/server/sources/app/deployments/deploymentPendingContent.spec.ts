import { describe, expect, it } from 'vitest';
import { readDeploymentPendingContent } from './deploymentPendingService';

describe('deployment pending stored envelope', () => {
    it('returns typed unavailable for the unsigned development envelope', () => {
        expect(readDeploymentPendingContent({ pendingDeployContent: { t: 'encrypted', c: 'retained-ciphertext' } }))
            .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    });

    it('reads the current wrapper without treating malformed content as an absent intent', () => {
        const pendingDeploy = { t: 'encrypted' as const, c: 'retained-ciphertext' };
        expect(readDeploymentPendingContent({ pendingDeployContent: { pendingDeploy } }))
            .toEqual({ ok: true, pendingDeploy });
        expect(readDeploymentPendingContent({ pendingDeployContent: null }))
            .toEqual({ ok: true, pendingDeploy: undefined });
        expect(readDeploymentPendingContent({ pendingDeployContent: { broken: true } }))
            .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    });
});
