import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { coderabbitReviewDescriptor } from './descriptor.js';
import { createCodeRabbitReviewExecutionProfile } from './profile.js';

describe('CodeRabbit review descriptor', () => {
  it('declares review execution capability without session capability', () => {
    expect(coderabbitReviewDescriptor.id).toBe('coderabbit');
    expect(coderabbitReviewDescriptor.capabilities.session.supported).toBe(false);
    expect(coderabbitReviewDescriptor.capabilities.executionRun.supported).toBe(true);
    expect(coderabbitReviewDescriptor.capabilities.executionRun.review.directCommentWrite).toBe(false);

    const backend = PLUGIN_MANIFEST.contributes.backends[0];
    expect(backend?.id).toBe('coderabbit');
    expect(backend?.capabilities.session.supported).toBe(false);
    expect(backend?.capabilities.executionRun.review.intents).toContain('review');
  });

  it('projects a review-only execution run profile', () => {
    expect(createCodeRabbitReviewExecutionProfile()).toMatchObject({
      id: 'coderabbit.review',
      kind: 'executionRun.profile',
      intent: 'review',
      displayKey: 'plugins.coderabbit.executionRuns.review.label',
    });
  });

  it('declares the CodeRabbit system tool used by the runtime resolver', () => {
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual(expect.objectContaining({
      toolId: 'coderabbit',
      displayName: 'CodeRabbit',
      lookupNames: ['coderabbit'],
    }));
  });
});
