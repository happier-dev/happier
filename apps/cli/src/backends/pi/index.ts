import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/pi/cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/pi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/pi/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/pi/cli/auth/piCliAuthSpec')).piCliAuthSpec,
  getConnectedServicesSpawnMaterializer: async () =>
    (await import('@/backends/pi/connectedServices/createPiConnectedServicesSpawnMaterializer'))
      .createPiConnectedServicesSpawnMaterializer(),
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/pi/preflight/piPreflightModelsProbeAdapter')).piPreflightModelsProbeAdapter,
  getAcpBackendFactory: async () => {
    const { createPiBackend } = await import('@/backends/pi/acp/backend');
    return (opts) => ({ backend: createPiBackend(opts) });
  },
  checklists,
} satisfies AgentCatalogEntry;
