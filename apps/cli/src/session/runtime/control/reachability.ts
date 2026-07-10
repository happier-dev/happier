import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';

import { createMaterializedStateReachabilityDelegate } from './materializedStateReachability';

export function createSessionRuntimeControlReachability() {
  return createMaterializedStateReachabilityDelegate(canResumeFromMaterializedState);
}
