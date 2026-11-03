import { MachineAcpInventoryRequestSchema, type MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { resolveAcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { listManagedAcpInstalls } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import { commandExistsOnPath } from '@happier-dev/cli-common/process';
import { CapabilityError } from '../errors';
import type { Capability } from '../service';

/** Physical install observations for caller-owned definitions, never an Account census or launch admission. */
export function createAcpAgentInventoryCapability(input: Readonly<{
  env?: NodeJS.ProcessEnv; platform?: string; arch?: string; accountId?: string;
}> = {}): Capability {
  return { descriptor: { id: 'tool.acpAgentInventory', kind: 'tool', title: 'ACP agent installs' },
    effects: { detect: ['private_read'] },
    async detect({ request, context }) {
      const parsed = MachineAcpInventoryRequestSchema.safeParse(request.params);
      if (!parsed.success) throw new CapabilityError('Invalid ACP inventory request', 'invalid-request');
      const accountId = context.accountId ?? input.accountId;
      if (!accountId) throw new CapabilityError('ACP inventory requires an admitted Account', 'account-unavailable');
      const installs = parsed.data.definitions.some(definition => definition.launch.kind !== 'command')
        ? await listManagedAcpInstalls({ env: input.env, accountId }) : [];
      const items: MachineAgentInventoryItem[] = parsed.data.definitions.map(definition => {
        const launch = definition.launch;
        if (launch.kind === 'command') {
          return { agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title,
            installed: commandExistsOnPath(launch.command, { env: input.env }), managed: false,
            fit: resolveAcpPlatformFitV1(launch, { platform: input.platform ?? process.platform, arch: input.arch ?? process.arch }),
            version: null, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] };
        }
        const matching = installs.filter(install => install.definitionId === definition.definitionId && install.kind === launch.kind);
        const install = matching.find(install => install.version === launch.version) ?? matching[0];
        const fit = resolveAcpPlatformFitV1(launch, { platform: input.platform ?? process.platform, arch: input.arch ?? process.arch });
        return { agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title,
          installed: Boolean(install), version: install?.version ?? null, managed: Boolean(install), fit,
          latestVersion: launch.version,
          update: { supported: Boolean(install), command: null },
          signIn: { status: 'unknown', loginSupport: 'unsupported' },
          platform: fit.kind === 'cant_run' ? { supported: false, reason: 'arch' } : { supported: true },
          install: { available: fit.kind === 'can_run', mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
      });
      return { items };
    },
  };
}
