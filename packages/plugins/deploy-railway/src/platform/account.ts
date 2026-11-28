import { projectDeploymentTargetHttpFailureV1 } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import { RAILWAY_ORIGIN, createRailwayGraphqlClient, RailwayNativeError } from '@happier-dev/railway-api';

export const railwayIdentity = { id: 'happier.deploy.railway', version: '0.0.0', displayName: 'Railway deployments' } as const;
const access = 'railway-api';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const railwayHostAccess = { required: [
  { id: access, capability: 'network', reason: 'Read linked Railway services and manage reviewed deployments.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: RAILWAY_ORIGIN }], methods: ['POST'] } },
  { id: ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the selected Railway account.',
    scope: { serviceRefs: [{ pluginId: 'happier.machine.railway', localId: 'railway-account' }],
      operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] } },
], optional: [] } as const;

export const railwayAccountAction = {
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: [access, ACCOUNT_PURPOSE], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: ACCOUNT_PURPOSE }],
} as const;

export function railwayRequest(context: PluginAccountActionContext): typeof fetch {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  return createMachineProvisionerFetch({ signal: context.signal, services: { http: context.services.http } }, {
    purpose: ACCOUNT_PURPOSE, origins: [RAILWAY_ORIGIN], headerName: 'authorization',
  });
}

export function railwayGraphql(context: PluginAccountActionContext): ReturnType<typeof createRailwayGraphqlClient> {
  return createRailwayGraphqlClient(railwayRequest(context), context.signal);
}

export function projectRailwayFailure(error: unknown, context: PluginAccountActionContext, phase: string, effectAttempted = false): never {
  context.signal.throwIfAborted();
  const classified = projectDeploymentTargetHttpFailureV1(error, effectAttempted ? 'write' : 'read', phase);
  if (isPluginError(classified)) throw classified;
  const native = error instanceof RailwayNativeError ? error : null;
  const status = native?.status;
  const graphqlCode = native?.nativeErrorCode;
  const refusal = native?.code === 'credential_unavailable' || status === 401 || status === 403
      || graphqlCode === 'FORBIDDEN' || graphqlCode === 'UNAUTHENTICATED' ? 'deployment_access_denied'
    : status === 404 ? 'deployment_unavailable'
    : graphqlCode === 'ALREADY_EXISTS' || graphqlCode === 'CONFLICT' ? 'deployment_conflict'
    : (status !== undefined && status >= 400 && status < 500 && status !== 408)
      || graphqlCode === 'PROJECT_LIMIT_REACHED' || graphqlCode === 'ENVIRONMENT_LIMIT_REACHED' ? 'provider_request_failed'
    : undefined;
  const failureCause = effectAttempted || native
    ? { ...projectActionFailureCauseV1(error, `deployment.railway.${phase}`, { allowUnknownErrorCode: native !== null }),
        ...(native?.nativeErrorCode === undefined ? {} : { nativeErrorCode: native.nativeErrorCode }) }
    : undefined;
  if (refusal) throw new PluginError({ code: refusal, retryable: false, details: { phase }, failureCause });
  if (effectAttempted) throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase }, failureCause });
  const code = native?.code === 'railway_invalid_response'
    ? 'provider_response_invalid' : 'provider_unavailable';
  throw new PluginError({ code, retryable: true, details: { phase }, ...(failureCause ? { failureCause } : {}) });
}
