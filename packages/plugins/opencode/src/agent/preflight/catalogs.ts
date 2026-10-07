import type { AgentPreflightSessionControlsProbeContextV1, AgentPreflightSessionControlsProbeInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveOpenCodeBackendMode } from '../runtime/mode.js';
import { resolveOpenCodeManagedServerDialect } from '../runtime/server/managedServerDialect.js';
import { buildOpenCodeManagedServerSpawnSpec } from '../runtime/server/spawnSpec.js';
import { createOpenCodeServerTransport } from '../runtime/server/transport.js';
import { createOpenCodeServerClient } from '../runtime/server/openCodeServerClient.js';
import { normalizeOpenCodeSkills } from '../runtime/server/skills.js';
import { resolveOpenCodeSystemToolId } from '../systemTool.js';

export function resolveOpenCodePreflightProbeVariant(input: AgentPreflightSessionControlsProbeInputV1): string {
  const backendMode = resolveOpenCodeBackendMode({ runtimeDescriptorV1: input.runtimeDescriptorV1, configuredBackendMode: input.runtimeKindOverride, accountSettings: input.accountSettings });
  return `${backendMode}|${resolveOpenCodeSystemToolId(input.accountSettings?.opencodeCliGeneration)}`;
}

export async function probeOpenCodePreflightCatalogs(context: AgentPreflightSessionControlsProbeContextV1): Promise<unknown> {
  const toolId = resolveOpenCodeSystemToolId(context.accountSettings?.opencodeCliGeneration);
  const backendMode = resolveOpenCodeBackendMode({
    runtimeDescriptorV1: context.runtimeDescriptorV1,
    configuredBackendMode: context.runtimeKindOverride,
    accountSettings: context.accountSettings,
  });
  if (backendMode === 'acp') return await context.probeDeclaredAcpCatalogs({ toolId, args: ['acp'] });
  const resolution = await resolveOpenCodeManagedServerDialect({
    exec: { systemTools: { resolve: ({ toolId }) => context.resolveDeclaredSystemTool({ toolId }) } },
    cwd: context.cwd, signal: context.signal, systemToolId: toolId, requireKnownGeneration: true,
    readVersion: () => context.runDeclaredSystemToolCommand({ toolId, args: ['--version'] }),
  });
  if (resolution.dialect === 'v2') {
    throw new Error('OpenCode V2 catalog readiness is unavailable: the native API has no read-only plugin activation barrier');
  }
  const spec = buildOpenCodeManagedServerSpawnSpec({
    id: 'opencode-preflight-catalogs', systemToolId: toolId,
    dialect: resolution.dialect, healthPath: resolution.healthPath,
    additionalEnv: { OPENCODE_DISABLE_PRUNE: '1' }, durableLog: false,
  });
  return await context.withDeclaredManagedService(spec, async (service, signal) => {
    const transport = createOpenCodeServerTransport({ managedService: service, signal });
    const client = createOpenCodeServerClient({ transport, directory: context.cwd, dialect: resolution.dialect, signal });
    const [commands, skills] = await Promise.all([
      client.appCommands({ directory: context.cwd }), client.appSkills({ directory: context.cwd }),
    ]);
    return { commands, skills: normalizeOpenCodeSkills(skills) };
  });
}
