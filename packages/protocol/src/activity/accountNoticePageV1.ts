import { MachineServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';
import { WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';
import { DeploymentEnvironmentRefV1Schema } from '../deployments/deploymentActionsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import { PluginUiSubPathV1Schema } from '../plugins/ui/semanticCommands.js';

/** Shared plugin-local page routing; identity and routing fields stay closed. */
export const AccountNoticePageV1Schema = lazyZodSchema(() => z.union([PluginNoticePageV1Schema, ServiceHealthNoticePageV1Schema]));
defineStoredReadProjection(AccountNoticePageV1Schema, () => AccountNoticePageV1Schema);

export const PluginNoticePageV1Schema = lazyZodSchema(() => z.strictObject({
  pageId: z.string().check(z.minLength(1)), subPath: z.optional(PluginUiSubPathV1Schema),
}));
export const ServiceHealthNoticeMachineV1Schema = lazyZodSchema(() => z.pick(WorkspaceRefV1WriteSchema, { serverId: true, machineId: true }));
const machineServicePage = lazyZodSchema(() => z.strictObject({
  kind: z.literal('host'), page: z.literal('machine_service'),
  machine: ServiceHealthNoticeMachineV1Schema,
  service: MachineServiceIdentityV1Schema, environment: z.optional(DeploymentEnvironmentRefV1Schema),
}).check(z.refine(value => value.machine.machineId === value.service.machineId
  && (!value.environment || value.environment.environmentId === value.service.environmentId
      && value.environment.serverId === value.machine.serverId))));
export const ServiceHealthNoticePageV1Schema = lazyZodSchema(() => z.discriminatedUnion('page', [
  machineServicePage,
  z.strictObject({ kind: z.literal('host'), page: z.literal('environment'),
    environment: DeploymentEnvironmentRefV1Schema, targetLinkId: z.string().check(z.minLength(1)) }),
]));
