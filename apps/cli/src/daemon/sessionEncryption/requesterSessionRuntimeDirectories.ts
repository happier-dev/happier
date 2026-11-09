import { join } from 'node:path';

import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';

/** Same Account-qualified native roots for runtime and exact retained-resource cleanup. */
export function resolveRequesterSessionRuntimeDirectories(input: Readonly<{
  activeServerDir: string; connectedServicesMaterializationBaseDir: string;
  attribution: Pick<RequesterWorkAttributionV1, 'accountId'>;
}>): Readonly<{ activeServerDir: string; connectedServicesMaterializationBaseDir: string }> {
  const accountPath = `account-${encodeURIComponent(input.attribution.accountId)}`;
  return { activeServerDir: join(input.activeServerDir, 'requester-accounts', accountPath),
    connectedServicesMaterializationBaseDir: join(input.connectedServicesMaterializationBaseDir, 'requester-accounts', accountPath) };
}
