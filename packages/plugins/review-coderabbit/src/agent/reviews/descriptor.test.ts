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

    const backend = PLUGIN_MANIFEST.contributes.agents[0];
    expect(backend?.id).toBe('coderabbit');
    expect(backend?.primary).toBe('executionRuns');
    expect(backend?.capabilities.executionRuns).toEqual({ open: ['create'], checkpoint: false, stop: true });
  });

  it('projects a review-only execution run profile', () => {
    expect(createCodeRabbitReviewExecutionProfile()).toMatchObject({
      id: 'review',
      intent: 'review',
      promptAsset: 'review-prompt',
      defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
    });
  });

  it('declares the CodeRabbit system tool used by the runtime resolver', () => {
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual(expect.objectContaining({
      id: 'coderabbit-cli',
      title: 'CodeRabbit CLI',
      executableNames: ['coderabbit'],
    }));
  });

  it('discloses only launch-environment keys consumed by the native review path', () => {
    const processAccess = PLUGIN_MANIFEST.hostAccess.required.find((request) => request.id === 'coderabbit-process');

    expect(processAccess?.scope.envKeys).toEqual([
      'CODERABBIT_API_KEY',
      'HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS',
      'HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS',
      'HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES',
    ]);
  });
});
