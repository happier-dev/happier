import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentTargetPreparationBaseV1 } from '@happier-dev/plugin-sdk';
import {
  createRailwayGraphqlClient, createRailwayProjectOperations, RAILWAY_ORIGIN, RailwayNativeError,
} from '@happier-dev/railway-api';

import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const railwayAccount = { pluginId: 'happier.machine.railway', localId: 'railway-account' } as const;

const id = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const nativeSelectorSchema = defineProtocolObject({
  projectId: id.optional(), environmentId: id.optional(), serviceId: id.optional(),
}, closed).jsonSchema;
const exactSelection = defineProtocolObject({ projectId: id, environmentId: id, serviceId: id }, closed);
export const exactSelectionSchema = exactSelection.jsonSchema;

export const pluginId = 'happier.deploy.railway-data';
export const engines = {
  postgresql: { label: 'PostgreSQL', template: 'postgres', privateVariable: 'DATABASE_URL' },
  mysql: { label: 'MySQL', template: 'mysql', privateVariable: 'MYSQL_URL' },
} as const;
export type Engine = keyof typeof engines;
export type Scope = DeploymentTargetPreparationBaseV1;
export type Selection = Readonly<{ projectId: string; environmentId: string; workspaceId?: string }>;
export type ServiceSelection = Selection & Readonly<{ serviceId: string }>;

export function railway(context: PluginAccountActionContext) {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  const fetch = createMachineProvisionerFetch({ signal: context.signal, services: { http: context.services.http } }, {
    purpose: ACCOUNT_PURPOSE, origins: [RAILWAY_ORIGIN], headerName: 'authorization',
  });
  return { project: createRailwayProjectOperations(fetch, context.signal), query: createRailwayGraphqlClient(fetch, context.signal) };
}

export function selectedService({ providerEnvironment, providerIdentity }:
  Pick<Scope, 'providerEnvironment' | 'providerIdentity'>): ServiceSelection {
  const coordinates = exactSelection.safeParse(providerEnvironment.selection);
  if (!coordinates.success || !providerIdentity || coordinates.data.projectId !== providerIdentity.providerAccountId
    || coordinates.data.serviceId !== providerIdentity.providerResourceId
    || coordinates.data.environmentId !== providerIdentity.providerEnvironment) {
    throw new PluginError({ code: 'target_mismatch' });
  }
  return coordinates.data;
}

export function readFailure(error: unknown): never {
  if (isPluginError(error)) throw error;
  if (error instanceof RailwayNativeError) {
    const { code, status } = error;
    throw new PluginError({ code: code === 'railway_invalid_response' ? 'provider_response_invalid' : code,
      failureCause: projectActionFailureCauseV1(error, 'deployment.railway.data.read', { allowUnknownErrorCode: true }),
      ...(status === undefined ? {} : { details: { httpStatus: status } }) });
  }
  throw error;
}
