import { AZ_DEP_ID } from '@happier-dev/protocol/installables';

import type { Capability } from '../service';
import { getAzDepStatus } from '../deps/az';

export const azDepCapability: Capability = {
  descriptor: {
    id: AZ_DEP_ID,
    kind: 'dep',
    title: 'Azure CLI',
  },
  detect: async ({ request }) => {
    const includeLatestVersion = Boolean((request.params ?? {}).includeLatestVersion);
    const onlyIfInstalled = Boolean((request.params ?? {}).onlyIfInstalled);
    return getAzDepStatus({ includeLatestVersion, onlyIfInstalled });
  },
};
