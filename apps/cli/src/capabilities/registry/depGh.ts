import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { CapabilityError } from '../errors';
import type { Capability } from '../service';
import { getGhDepStatus, INSTALL_GH_CONSENT_TOKEN, installGh } from '../deps/gh';

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

    // The capability registry's invoke path is the user-confirmed install consent flow:
    // it is reachable only via an explicit `dep.gh.install` capability invocation that
    // the UI surfaces behind a consent.install descriptor gate (FD-0054).
    const result = await installGh(INSTALL_GH_CONSENT_TOKEN);
    if (!result.ok) {
      return {
        ok: false,
        error: { message: result.errorMessage, code: 'install-failed' },
        logPath: result.logPath,
      };
    }
    return { ok: true, result: { logPath: result.logPath } };
  },
};
