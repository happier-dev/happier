import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { assertReviewedDeploymentSource } from './reviewedSource';

describe('reviewed deployment intent', () => {
    it('refuses a prepared service selection that widens or replaces the authored subset', () => {
        const content = createDeploymentReceiptDetailV1().content;
        const intent = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', services: ['db'] };
        expect(() => assertReviewedDeploymentSource({ intent, content })).toThrow(expect.objectContaining({ code: 'target_mismatch' }));
        expect(() => assertReviewedDeploymentSource({ intent, content: { ...content, services: ['app', 'db'] } })).toThrow();
        expect(() => assertReviewedDeploymentSource({ intent, content: { ...content, services: ['db'] } })).not.toThrow();
        expect(() => assertReviewedDeploymentSource({ intent: { ...intent, services: undefined }, content: { ...content, services: ['db'] } })).toThrow();
    });
    it('keeps an explicit failure policy bound to the candidate through review and execution', () => {
        const content = createDeploymentReceiptDetailV1().content;
        const intent = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', onFailure: 'keepPartial' as const };
        expect(() => assertReviewedDeploymentSource({ intent, content: { ...content, onFailure: 'rollbackAll' } }))
            .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
        expect(() => assertReviewedDeploymentSource({ intent, content: { ...content, onFailure: 'keepPartial' } })).not.toThrow();
        expect(() => assertReviewedDeploymentSource({ intent: { ...intent, onFailure: undefined }, content })).not.toThrow();
    });
});
