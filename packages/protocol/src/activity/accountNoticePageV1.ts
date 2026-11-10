import { z } from '../zodRuntimePolicy.js';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import { PluginUiSubPathV1Schema } from '../plugins/ui/semanticCommands.js';
import { WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';
import { MachineServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';
import { DeploymentEnvironmentRefV1Schema } from '../deployments/deploymentActionsV1.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

/** A plugin-authored page of the owning plugin; plugins never author host routes. */
export const PluginNoticePageV1Schema = lazyZodSchema(() => z.strictObject({
  pageId: z.string().check(z.minLength(1)), subPath: z.optional(PluginUiSubPathV1Schema),
}));
export const ServiceHealthNoticeMachineV1Schema = lazyZodSchema(() => z.pick(WorkspaceRefV1WriteSchema, { serverId: true, machineId: true }));
export type ServiceHealthNoticeMachineV1 = z.infer<typeof ServiceHealthNoticeMachineV1Schema>;
export const ServiceHealthNoticeMachineV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ServiceHealthNoticeMachineV1Schema));

/** Authored routing operands; current Home, Machine and service access are re-admitted on open. */
const machineServicePage = lazyZodSchema(() => z.strictObject({
  kind: z.literal('host'), page: z.literal('machine_service'),
  machine: ServiceHealthNoticeMachineV1Schema,
  service: MachineServiceIdentityV1Schema, environment: z.optional(DeploymentEnvironmentRefV1Schema),
}).check(z.refine(value => value.machine.machineId === value.service.machineId
  && (value.service.kind === 'adopted' ? value.environment === undefined
    : !value.environment || value.environment.environmentId === value.service.environmentId
      && value.environment.serverId === value.machine.serverId))));
export const ServiceHealthNoticePageV1Schema = lazyZodSchema(() => z.discriminatedUnion('page', [
  machineServicePage,
  z.strictObject({ kind: z.literal('host'), page: z.literal('environment'),
    environment: DeploymentEnvironmentRefV1Schema, targetLinkId: z.optional(z.string().check(z.minLength(1))) }),
]));
export type ServiceHealthNoticePageV1 = z.infer<typeof ServiceHealthNoticePageV1Schema>;
export const ServiceHealthNoticePageV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ServiceHealthNoticePageV1Schema));

/** Plugin pages retain their released shape; host routing is closed independently. */
export const AccountNoticePageV1Schema = lazyZodSchema(() => z.union([PluginNoticePageV1Schema, ServiceHealthNoticePageV1Schema]));
defineStoredReadProjection(AccountNoticePageV1Schema, () => AccountNoticePageV1Schema);
