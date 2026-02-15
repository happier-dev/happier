import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

import { CodeRabbitReviewBackend } from './CodeRabbitReviewBackend.js';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return new CodeRabbitReviewBackend({ cwd: opts.cwd, start: opts.start ?? undefined });
};

