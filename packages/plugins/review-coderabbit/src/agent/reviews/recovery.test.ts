import { describe, expect, it } from 'vitest';

import { readCodeRabbitReviewConfigFromEnv } from './config.js';

describe('CodeRabbit native launch configuration', () => {
  it('preserves the request-scoped timeout and bounded retry settings consumed by the native runtime', () => {
    const config = readCodeRabbitReviewConfigFromEnv({
      HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '1200',
      HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS: '4',
      HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES: '20',
    });

    expect(config).toEqual({
      timeoutMs: 1200,
      rateLimitMaxAttempts: 4,
      maxEligibleFiles: 20,
    });
  });
});
