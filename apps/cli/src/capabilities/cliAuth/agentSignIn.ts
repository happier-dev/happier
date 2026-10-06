import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { AgentSignInPrepareRequest, AgentSignInPrepareResponse, AgentSignInStatusResponse } from '@happier-dev/protocol';
import { readAgentCatalogSnapshot, readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resolveAgentCliLaunchSpecForRuntime } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { detectNativeAgentCliAuthStatus } from './detectNativeAgentCliAuthStatus';

/** Manifest order is recommendation order; no host-maintained Agent/service table. */
export function getAgentSignInServices(agentId: string) {
  const registry = readCurrentContributionRegistry();
  return resolveCatalogAgentConnectedAccountServiceIds(agentId).flatMap((serviceId) => {
    const identity = parseQualifiedPluginContributionKey(serviceId);
    const descriptor = registry.connectedAccountDescriptorsById?.get(serviceId)?.definition;
    if (!identity || !descriptor) return [];
    return [{ serviceId, service: identity, modeId: descriptor.authentication.defaultModeId,
      title: typeof descriptor.title === 'string' ? descriptor.title : identity.localId }];
  });
}

/** Fresh native facts, using exactly the same admitted probe as the inventory. */
export async function probeAgentSignInStatus(agentId: string): Promise<AgentSignInStatusResponse> {
  const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(agentId);
  const launch = agent?.runtimeSpec ? resolveAgentCliLaunchSpecForRuntime(agent.runtimeSpec) : null;
  const auth = launch ? await detectNativeAgentCliAuthStatus({ agentId, resolvedPath: launch.resolvedPath }) : null;
  return {
    status: auth?.state === 'logged_in' ? 'signedIn' : auth?.state === 'logged_out' ? 'signedOut' : 'unknown',
    accountLabel: auth?.accountLabel ?? null,
    checkedAt: auth?.checkedAt ?? Date.now(),
    nativeLogin: agent?.cliMetadata?.auth.support ?? 'unsupported',
    connectedServices: getAgentSignInServices(agentId).map(({ serviceId, title }) => ({ serviceId, title })),
  };
}

/** Resolve intent only. Existing terminal/connect owners execute the returned operation. */
export function prepareAgentSignIn(request: AgentSignInPrepareRequest): AgentSignInPrepareResponse {
  const services = getAgentSignInServices(request.agentId);
  const method = request.method ?? (services.length > 0 ? 'connected' : 'native');
  if (method === 'connected') {
    const requestedService = request.serviceId
      ? readBuiltInLegacyConnectedAccountServiceKeyIngress(request.serviceId) : null;
    const selected = request.serviceId
      ? services.find((service) => service.serviceId === requestedService) : services[0];
    if (!selected) return { ok: false, errorCode: 'connected_service_unsupported', error: 'connected_service_unsupported' };
    return { method, command: { operation: 'beginConnect', service: selected.service, modeId: selected.modeId } };
  }
  const auth = readAgentCatalogSnapshot().agentDefinitionsById.get(request.agentId)?.cliMetadata?.auth;
  const launchId = request.launchId ?? 'primary';
  if (auth?.support !== 'login_terminal' || !auth.loginLaunches.some((launch) => launch.kind === launchId)) {
    return { ok: false, errorCode: 'agent_login_unsupported', error: 'agent_login_unsupported' };
  }
  return { method,
    launch: { kind: 'agent_login', agentId: request.agentId, launchId } };
}
