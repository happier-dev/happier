import type { Capability } from '@/capabilities/service';
import { CapabilityError } from '@/capabilities/errors';

/**
 * Agy sessions no longer use the pinned `agy_acp_server`, but released clients (0.2.21 and earlier)
 * still detect and prewarm it for every Agy new session. Report it as satisfied and accept install
 * as a no-op so those clients neither block nor show an error. Remove once they are unsupported.
 */
export const retiredAgyAcpServerCapability: Capability = {
  descriptor: {
    id: 'dep.agy-acp-server',
    kind: 'dep',
    title: 'Agy ACP server (no longer required)',
    methods: {
      install: { title: 'Install' },
      upgrade: { title: 'Upgrade' },
    },
  },
  detect: async () => ({
    installed: true,
    installDir: null,
    binPath: null,
    installedVersion: null,
    sourceKind: 'pinned_archive',
    lastInstallLogPath: null,
    lastBackgroundUpdateCheckAtMs: null,
  }),
  invoke: async ({ method }) => {
    if (method !== 'install' && method !== 'upgrade') {
      throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
    }
    return { ok: true, result: {} };
  },
};
