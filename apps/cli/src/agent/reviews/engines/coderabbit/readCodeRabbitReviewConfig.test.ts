import { describe, expect, it } from 'vitest';

import { readCodeRabbitReviewConfigFromEnv } from './readCodeRabbitReviewConfig';

describe('readCodeRabbitReviewConfigFromEnv', () => {
  it('defaults the command to "coderabbit" and leaves timeout unset when no override env var is set', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({});
    expect(cfg.command).toBe('coderabbit');
    expect(cfg.timeoutMs).toBeNull();
    expect(cfg.maxEligibleFiles).toBe(300);
  });

  it('uses HAPPIER_CODERABBIT_REVIEW_CMD override when provided', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({ HAPPIER_CODERABBIT_REVIEW_CMD: '/tmp/coderabbit' } as any);
    expect(cfg.command).toBe('/tmp/coderabbit');
  });

  it('uses HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES override when provided', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({
      HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES: '42',
    } as any);
    expect(cfg.maxEligibleFiles).toBe(42);
  });

  it('uses HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS override when provided', () => {
    const cfg = readCodeRabbitReviewConfigFromEnv({
      HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '180000',
    } as any);
    expect(cfg.timeoutMs).toBe(180000);
  });
});
