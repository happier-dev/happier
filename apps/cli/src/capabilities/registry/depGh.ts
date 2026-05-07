import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { getGhDepStatus, installGh } from '../deps/gh';
import { CapabilityError } from '../errors';
import type { Capability } from '../service';

export const ghDepCapability: Capability = {
  descriptor: {
    id: GH_DEP_ID,
    kind: 'dep',
    title: 'GitHub CLI',
    methods: {
      install: { title: 'Install' },
      upgrade: { title: 'Upgrade' },
    },
  },
  detect: async ({ request }) => {
    const includeLatestVersion = Boolean((request.params ?? {}).includeLatestVersion);
    const onlyIfInstalled = Boolean((request.params ?? {}).onlyIfInstalled);
    return await getGhDepStatus({ includeLatestVersion, onlyIfInstalled });
  },
  invoke: async ({ method }) => {
    if (method !== 'install' && method !== 'upgrade') {
      throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
    }

    const result = await installGh();
    if (!result.ok) {
      return { ok: false, error: { message: result.errorMessage, code: 'install-failed' }, logPath: result.logPath };
    }
    return { ok: true, result: { logPath: result.logPath } };
  },
};
