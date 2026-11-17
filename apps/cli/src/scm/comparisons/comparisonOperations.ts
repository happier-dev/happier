import { AsyncLocalStorage } from 'node:async_hooks';

import type * as comparison from './captureScmComparison';
import type { executeScmCommitPlanAction } from '../commitPlans/executeScmCommitPlanAction';

/** The admitted repository's execution port. Account-owned evidence stays in the host. */
export type ScmComparisonOperations = Readonly<{
  capture: typeof comparison.captureScmComparison;
  read: typeof comparison.readCapturedScmComparison;
  index: typeof comparison.readCapturedScmComparisonIndex;
  page: typeof comparison.readCapturedScmComparisonPage;
  file: typeof comparison.readCapturedScmComparisonFile;
  investigate: typeof comparison.prepareCapturedScmComparisonInvestigation;
  delete: typeof comparison.deleteCapturedScmComparison;
  commitPlan: typeof executeScmCommitPlanAction;
}>;

const operations = new AsyncLocalStorage<ScmComparisonOperations>();

export function runWithScmComparisonOperations<T>(selected: ScmComparisonOperations, effect: () => T): T {
  return operations.run(selected, effect);
}

export function readScmComparisonOperations(): ScmComparisonOperations | undefined {
  return operations.getStore();
}
