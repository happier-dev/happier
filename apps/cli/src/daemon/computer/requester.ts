import type { ApiMachineClient } from '@/api/apiMachine';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { ComputerActionContext } from './routes';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { selectHostRequesterExecutionIdentity, resolveHostRequesterAgentPlacementForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { ComputerDriverError } from './driver/managedComputerDriver';

export type ComputerRequesterHost = Readonly<{
  custodianAccountId: string | null;
  installationId: string | null;
  readHomeServerIdentityId(signal?: AbortSignal): Promise<string | null>;
  readSessionBootstrap?(sessionId: string, signal?: AbortSignal): AdmittedRequesterSessionBootstrap | undefined
    | Promise<AdmittedRequesterSessionBootstrap | undefined>;
  agentIsolation?: HostAgentIsolationLaunchContext;
  prepareNativeOperation: ApiMachineClient['prepareNativeOperation'];
}>;
export type ComputerRequesterScope = Readonly<{ kind: 'owner' }> | Readonly<{
  kind: 'personal'; key: string;
  homeServerIdentityId: string;
  identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
  placement: ReturnType<typeof resolveHostRequesterAgentPlacementForHost>;
}>;

export async function resolveComputerRequesterScope(input: Readonly<{
  machineId: string; host?: ComputerRequesterHost; context: ComputerActionContext; platform?: NodeJS.Platform;
}>): Promise<ComputerRequesterScope> {
  const { context, host } = input;
  const isUnrestricted = (admission: AdmittedRequesterSessionBootstrap['savedSecretOperationContext']['machineAdmission']) =>
    !!admission && (admission.actorAccountId === admission.custodianAccountId || admission.role === 'manage');
  const directlyUnrestricted = isUnrestricted(context.machineAdmission);
  // Personal viewer authority belongs to its verified caller. Its supplied
  // Session id cannot select another person's immutable Session birth.
  const bootstrap = context.ownDesktopOnly || directlyUnrestricted ? undefined : context.requesterSessionBootstrap
    ?? (context.defaultSessionId ? await host?.readSessionBootstrap?.(context.defaultSessionId, context.signal) : undefined);
  const admission = context.machineAdmission ?? bootstrap?.savedSecretOperationContext.machineAdmission;
  const unrestricted = directlyUnrestricted || (!context.machineAdmission && isUnrestricted(admission));
  if (unrestricted) {
    if (context.ownDesktopOnly) throw new PluginError({ code: 'access_denied', message: 'access_denied' });
    return { kind: 'owner' };
  }
  if (admission && admission.role !== 'use') throw new PluginError({ code: 'access_denied', message: 'access_denied' });
  const requesterBearing = !!(admission || bootstrap || context.ownDesktopOnly || context.sessionActionOrigin
    || context.callerInputAuthorization || context.externalActionExecutionAuthorization
    || context.requesterWorkAttributionV1 || context.authenticatedLocalRootCustody);
  // Ordinary custodian Sessions retain their existing local desktop path. All
  // routed/requester-bearing work must bind its own identity through the host.
  if (!requesterBearing) return { kind: 'owner' };
  const unavailable = (reason: string): never => { throw new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Requester desktop is unavailable', retryable: false, details: { reason } }); };
  if (!host?.custodianAccountId || !host.installationId) return unavailable('requester_authority_unavailable');
  const homeServerIdentityId = await host.readHomeServerIdentityId(context.signal);
  if (!homeServerIdentityId) return unavailable('requester_authority_unavailable');
  const identity = selectHostRequesterExecutionIdentity({
    hostHomeServerIdentityId: homeServerIdentityId, hostCustodianAccountId: host.custodianAccountId,
    hostExecutionTarget: { machineId: input.machineId, installationId: host.installationId },
    ...(bootstrap ? { sessionRequester: bootstrap.attribution,
      sessionRequesterHomeServerIdentityId: bootstrap.homeServerIdentityId ?? null,
      sessionCustodianAccountId: bootstrap.savedSecretOperationContext.machineAdmission?.custodianAccountId ?? null }
      : { actionContext: context }),
  });
  if (identity.kind === 'unknown') return unavailable(identity.reason);
  if (identity.kind === 'owner_person' || !identity.separationRequired) {
    if (context.ownDesktopOnly) throw new PluginError({ code: 'access_denied', message: 'access_denied' });
    return { kind: 'owner' };
  }
  if ((input.platform ?? process.platform) !== 'linux') throw new ComputerDriverError('computer_display_unavailable');
  return { kind: 'personal', identity, homeServerIdentityId,
    key: deriveAgentIsolationMemberIdentity({ requester: identity.requester, homeServerIdentityId }).digest,
    placement: resolveHostRequesterAgentPlacementForHost({ identity, snapshot: host.agentIsolation?.read(), platform: input.platform }),
  };
}
