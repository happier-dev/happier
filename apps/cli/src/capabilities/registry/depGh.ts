import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { CapabilityError } from '../errors';
import type { Capability } from '../service';
import { getGhDepStatus } from '../deps/gh';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';

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
    return getGhDepStatus({ includeLatestVersion, onlyIfInstalled });
  },
  invoke: async ({ method }) => {
    if (method !== 'install' && method !== 'upgrade') {
      throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
    }

    // This capability invocation is the user-confirmed consent boundary; the shared
    // source adapter remains the sole owner of GitHub-release installation mechanics.
    const result = await (await getRuntimeInstallableAdapter('gh')).installOrUpgrade();
    if (!result.ok) {
      return {
        ok: false,
        error: { message: result.errorMessage, code: 'install-failed' },
        ...(result.logPath ? { logPath: result.logPath } : {}),
      };
    }
    return { ok: true, result: { logPath: result.logPath } };
  },
};
