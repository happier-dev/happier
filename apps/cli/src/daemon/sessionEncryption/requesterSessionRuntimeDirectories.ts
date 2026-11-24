import { basename, dirname, join } from 'node:path';

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

/** The materialized store a base sits in: a requester base is this layout's `requester-accounts/account-*` below it. */
export function resolveMaterializedStoreRoot(connectedServicesMaterializationBaseDir: string): string {
  const namespace = dirname(connectedServicesMaterializationBaseDir);
  return basename(namespace) === 'requester-accounts' && basename(connectedServicesMaterializationBaseDir).startsWith('account-')
    ? dirname(namespace) : connectedServicesMaterializationBaseDir;
}
