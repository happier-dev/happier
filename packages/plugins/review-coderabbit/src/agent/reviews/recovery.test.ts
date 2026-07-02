import { describe, expect, it } from 'vitest';

import { readCodeRabbitReviewConfigFromEnv } from './config.js';
import { buildCodeRabbitEnv } from './env.js';

describe('CodeRabbit recovered config and environment contracts', () => {
  it('preserves command timeout home and rate-limit environment settings', () => {
    const config = readCodeRabbitReviewConfigFromEnv({
      HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit-pro',
      HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '1200',
      HAPPIER_CODERABBIT_HOME_DIR: '/tmp/coderabbit-home',
      HAPPIER_CODERABBIT_REVIEW_RATE_LIMIT_MAX_ATTEMPTS: '4',
      HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES: '20',
    });

    expect(config).toEqual({
      command: 'coderabbit-pro',
      timeoutMs: 1200,
      homeDir: '/tmp/coderabbit-home',
      rateLimitMaxAttempts: 4,
      maxEligibleFiles: 20,
    });
  });

  it('isolates CodeRabbit config directories without overriding OS home', () => {
    const env = buildCodeRabbitEnv({
      baseEnv: { HOME: '/Users/person', USERPROFILE: 'C:\\Users\\person' },
      homeDir: '/tmp/happier-coderabbit',
    });

    expect(env.HOME).toBe('/Users/person');
    expect(env.USERPROFILE).toBe('C:\\Users\\person');
    expect(env.CODERABBIT_HOME).toBe('/tmp/happier-coderabbit/.coderabbit');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/happier-coderabbit/.config');
  });
});
