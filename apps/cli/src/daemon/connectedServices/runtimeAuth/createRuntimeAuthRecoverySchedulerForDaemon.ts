import { join } from 'node:path';

import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryIntent,
} from './RuntimeAuthRecoveryScheduler';
import { createPredecessorCompatibleRuntimeAuthRecoveryStore } from './predecessorRuntimeAuthRecoveryStore';

type RuntimeAuthRecoverySchedulerDeps = ConstructorParameters<typeof RuntimeAuthRecoveryScheduler>[0];

export function createRuntimeAuthRecoverySchedulerForDaemon(
  input: Readonly<{ activeServerDir: string }> & Omit<RuntimeAuthRecoverySchedulerDeps, 'durableStore'>,
): RuntimeAuthRecoveryScheduler {
  const { activeServerDir, ...schedulerDeps } = input;
  const scheduler = new RuntimeAuthRecoveryScheduler({
    ...schedulerDeps,
    durableStore: createPredecessorCompatibleRuntimeAuthRecoveryStore(
      createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(
        activeServerDir,
        'connected-services',
        'runtime-auth-recovery.json',
      )),
    ),
  });
  scheduler.hydratePassive();
  return scheduler;
}
