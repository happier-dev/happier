import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readManagedAgentCliInstallMetadata, removeAgentCliManagedInstallForRuntime,
  resolveAgentCliManagedInstallRootForRuntime, resolveManagedToolsRoot,
  managedAcpAccountNamespace, readManagedAcpInstallNamespace,
  uninstallManagedUvAgent,
} from '@happier-dev/cli-common/agents';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { agentRoutingIdAddressesContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { readPinnedArchiveManagedVersion, removePinnedArchiveManagedInstall } from '@/packagedRuntime/installables/sourceAdapters/pinnedArchive';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import { normalizeDaemonBackendTargetV2Input } from '@/daemon/backendTargetRouting';
import type { TrackedSession } from '@/daemon/types';
import { executeInstallCommand } from '@/capabilities/installJobs/executeInstallCommand';

export type ManagedAcpInstall = Readonly<{
  accountNamespace: string; installId: string;
  definitionId: string; title: string; kind: 'archive' | 'npm' | 'uv'; installRoot: string; version: string;
}>;

async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listManagedAcpInstalls(params: Readonly<{ env?: NodeJS.ProcessEnv; accountId?: string; accountNamespace?: string }> = {}): Promise<readonly ManagedAcpInstall[]> {
  const tools = resolveManagedToolsRoot(params.env ?? process.env);
  const namespace = params.accountId === undefined ? params.accountNamespace : managedAcpAccountNamespace(params.accountId);
  const installs: ManagedAcpInstall[] = [];
  for (const installId of await directories(tools)) {
    if (namespace && !installId.startsWith(`dep.acp.${namespace}.`)) continue;
    const metadata = await readPinnedArchiveManagedVersion({ installId, env: params.env });
    const accountNamespace = metadata?.kind === 'archive' && installId.startsWith('dep.')
      ? readManagedAcpInstallNamespace(installId.slice(4), metadata.definitionId, metadata.version) : null;
    if (accountNamespace && metadata?.kind === 'archive') {
      installs.push({ accountNamespace, installId, definitionId: metadata.definitionId, title: metadata.title, kind: 'archive', version: metadata.version, installRoot: join(tools, installId) });
    }
  }
  for (const id of await directories(join(tools, 'providers'))) {
    if (namespace && !id.startsWith(`acp.${namespace}.`)) continue;
    const runtimeSpec = { id };
    const metadata = await readManagedAgentCliInstallMetadata({ runtimeSpec, env: params.env });
    const accountNamespace = metadata && readManagedAcpInstallNamespace(id, metadata.definitionId, metadata.version);
    if (metadata && accountNamespace) installs.push({ ...metadata, accountNamespace, installId: id,
      installRoot: resolveAgentCliManagedInstallRootForRuntime(runtimeSpec, { processEnv: params.env }) });
  }
  return installs;
}

/** The daemon's actual tracked runner set owns use, including adopted and requester-Account sessions. */
export function isAgentInstallTargetInUse(target: Readonly<{ agentId: string; definitionId?: string }>, sessions: Iterable<TrackedSession>): boolean {
  for (const session of sessions) {
    const selected = session.spawnOptions?.agentTarget;
    const descriptor = session.spawnOptions?.runtimeDescriptorV1
      ?? readRuntimeDescriptorV1FromMetadata(session.happySessionMetadataFromLocalWebhook);
    const backend = normalizeDaemonBackendTargetV2Input(session.spawnOptions?.backendTarget);
    if (target.definitionId !== undefined) {
      const isConfigured = selected && isCustomAcpAgentContributionIdentityV1(selected.identity)
        || descriptor && agentRoutingIdAddressesContributionIdentityV1(descriptor.agentId, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1)
        || backend?.sourceKind === 'configured'
        || readLegacyConfiguredAcpBackendId(session.happySessionMetadataFromLocalWebhook?.flavor) !== null;
      if (!isConfigured) continue;
      const definitionId = selected?.definitionId
        ?? (typeof descriptor?.agent.definitionId === 'string' ? descriptor.agent.definitionId : undefined)
        ?? (backend?.sourceKind === 'configured' ? backend.configuredBackendId ?? backend.backendId : undefined)
        ?? readLegacyConfiguredAcpBackendId(session.happySessionMetadataFromLocalWebhook?.flavor);
      if (!definitionId || definitionId === target.definitionId) return true;
    } else if (descriptor?.agentId === target.agentId
      || selected && agentRoutingIdAddressesContributionIdentityV1(target.agentId, selected.identity)
      || resolveTrackedSessionCatalogAgentId(session) === target.agentId) return true;
  }
  return false;
}

export async function removeManagedAcpInstall(params: Readonly<{
  accountId?: string; accountNamespace?: string; version?: string; installKind?: ManagedAcpInstall['kind'];
  definitionId: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  isDefinitionInUse?: (definitionId: string) => boolean | Promise<boolean>;
}>): Promise<Readonly<{ ok: true } | { ok: false; code: 'not_managed' | 'in_use' }>> {
  params.signal?.throwIfAborted();
  if (!params.isDefinitionInUse || await params.isDefinitionInUse(params.definitionId)) return { ok: false, code: 'in_use' };
  const namespace = params.accountId ? managedAcpAccountNamespace(params.accountId) : params.accountNamespace;
  if (!namespace) return { ok: false, code: 'not_managed' };
  const installs = (await listManagedAcpInstalls({ env: params.env, accountNamespace: namespace })).filter(install =>
    install.definitionId === params.definitionId && (params.version === undefined || install.version === params.version)
    && (params.installKind === undefined || install.kind === params.installKind));
  if (!installs.length) return { ok: false, code: 'not_managed' };
  for (const install of installs) {
    params.signal?.throwIfAborted();
    if (await params.isDefinitionInUse(params.definitionId)) return { ok: false, code: 'in_use' };
    if (install.kind === 'archive') {
      await removePinnedArchiveManagedInstall({ installId: install.installId, env: params.env, signal: params.signal });
    } else {
      if (install.kind === 'uv') await uninstallManagedUvAgent({ id: install.installId }, params.env ?? process.env, params.signal, executeInstallCommand);
      await removeAgentCliManagedInstallForRuntime({ runtimeSpec: { id: install.installId },
        env: params.env, signal: params.signal });
    }
  }
  return { ok: true };
}
