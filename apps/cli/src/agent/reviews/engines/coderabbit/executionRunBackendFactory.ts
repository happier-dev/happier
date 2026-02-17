import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

import { CodeRabbitReviewBackend } from './CodeRabbitReviewBackend.js';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  const mergedEnv = opts.isolation?.env ? { ...process.env, ...opts.isolation.env } : undefined;
  return new CodeRabbitReviewBackend({ cwd: opts.cwd, env: mergedEnv, start: opts.start ?? undefined });
};
