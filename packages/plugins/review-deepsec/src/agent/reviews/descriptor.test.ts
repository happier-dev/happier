import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { deepsecReviewDescriptor } from './descriptor.js';
import { createDeepSecReviewExecutionProfile } from './profile.js';

describe('DeepSec review descriptor', () => {
  it('declares review capability with security audit modes without session capability', () => {
    expect(deepsecReviewDescriptor.id).toBe('deepsec');
    expect(deepsecReviewDescriptor.capabilities.session.supported).toBe(false);
    expect(deepsecReviewDescriptor.capabilities.executionRun.review.intents).toEqual(['review']);
    expect(deepsecReviewDescriptor.capabilities.executionRun.review.modes).toEqual([
      'repository_security_audit',
      'change_scoped_review',
    ]);
    expect(deepsecReviewDescriptor.capabilities.executionRun.review.costClass).toBe('expensive');

    const backend = PLUGIN_MANIFEST.contributes.agents[0];
    expect(backend?.id).toBe('deepsec');
    expect(backend?.primary).toBe('executionRuns');
    expect(backend?.capabilities.executionRuns).toEqual({ open: ['create'], checkpoint: false, stop: true });
  });

  it('projects review and security execution run profiles', () => {
    expect(createDeepSecReviewExecutionProfile('review')).toMatchObject({
      id: 'review',
      intent: 'review',
      promptAsset: 'review-prompt',
    });
    expect(createDeepSecReviewExecutionProfile('repository_security_audit')).toMatchObject({
      id: 'repository-security-audit',
      intent: 'review',
      promptAsset: 'repository-security-audit-prompt',
    });
  });

  it('declares the DeepSec system tool used by the runtime resolver', () => {
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual(expect.objectContaining({
      id: 'deepsec-cli',
      title: 'DeepSec CLI',
      executableNames: ['deepsec'],
    }));
  });

  it('declares the gateway key environment permission consumed by readiness checks', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      capability: 'environment',
      scope: { keys: ['AI_GATEWAY_API_KEY'] },
    }));
  });
});
