import { describe, expect, it } from 'vitest';

import { readCodeRabbitReviewConfigFromEnv } from './readCodeRabbitReviewConfig';

describe('readCodeRabbitReviewConfigFromEnv', () => {
  it('defaults the command to "coderabbit" when no override env var is set', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({});
    expect(cfg.command).toBe('coderabbit');
  });

  it('uses HAPPIER_CODERABBIT_REVIEW_CMD override when provided', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({ HAPPIER_CODERABBIT_REVIEW_CMD: '/tmp/coderabbit' } as any);
    expect(cfg.command).toBe('/tmp/coderabbit');
  });
});

