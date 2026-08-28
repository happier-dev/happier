import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import type { RuntimeAccountIdentityEntry } from './runtimeAccountIdentityTypes';
import type { RuntimeAccountIdentityIndex } from './RuntimeAccountIdentityIndex';

export function resolveSessionsSharingProviderAccount(
  index: RuntimeAccountIdentityIndex,
  input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    providerAccountId: string;
    groupId?: string | null;
    excludeSessionId?: string | null;
    currentGroupGenerationBySessionId?: ReadonlyMap<string, number | null>;
  }>,
): RuntimeAccountIdentityEntry[] {
  return index.listByProviderAccount(input);
}
