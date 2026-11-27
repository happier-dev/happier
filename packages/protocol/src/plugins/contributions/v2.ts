import { PluginAgentContributionV2Schema } from './agentContributionV2.js';
export * from './agentContributionV2.js';
import { PluginDatabaseEngineContributionV1Schema } from './databaseEngines.js';
import { z } from '../../zodRuntimePolicy.js';
import { MachineRoleDeclarationV1Schema } from '../../machines/roles/machineRolesV1.js';
import { HealthCheckKindContributionV1Schema, validateHealthCheckKindContributionsV1 } from './healthCheckKinds.js';
import { PluginStoreKindContributionV1Schema, validatePluginStoreKindContributionsV1 } from './storeKinds.js';
export * from './storeKinds.js';
export * from './healthCheckKinds.js';
import { BackupDestinationContributionV1Schema } from './backupDestinations.js';
import { DeploymentTargetContributionV1Schema, validateDeploymentTargetContributionsV1 } from './deploymentTargets.js';
export * from './deploymentTargets.js';
export { DeploymentTargetPreparedNativeV1Schema, DeploymentTargetPreparedNativeV1ProtocolSchema,
  type DeploymentTargetPreparedNativeV1 } from './deploymentTargetRolesV1.js';
import { MachineRecipeV1Schema } from './machineRecipes.js';
import { MachineSetupPresetContributionV1Schema } from './machineSetupPresets.js';
export * from './machineSetupPresets.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginHostAccessRequestIdV2Schema } from '../_shared.js';
import { PluginCaptureSourceContributionV1Schema } from './captureSources.js';
import { PluginSecretSourceContributionV1Schema } from './secretSources.js';
import { MachineProvisionerContributionV1Schema, validateMachineProvisionerContributionsV1 } from './machineProvisioners.js';
export * from './machineProvisioners.js';
import { AccessProviderContributionV1Schema, validateAccessProviderContributionsV1 } from './accessProviders.js';
export * from './accessProviders.js';
import { PluginServiceLaunchEnvironmentContributionV1Schema } from './serviceLaunchEnvironments.js';
import { PluginProjectNativeAdapterContributionV1Schema } from './projectNativeAdapters.js';
import { PluginWorkItemsContributionV1Schema } from './workItems.js';
import { PluginSubjectKindContributionV1Schema, validatePluginSubjectKindContributionsV1 } from './subjectKinds.js';
export * from './subjectKinds.js';
import { PluginSessionInboxResourceBindingV1Schema } from './ui/sessionInbox.js';
export { PluginProjectNativeAdapterContributionV1Schema, type PluginProjectNativeAdapterContributionV1 } from './projectNativeAdapters.js';
export { PluginCaptureSourceContributionV1Schema, type PluginCaptureSourceContributionV1 } from './captureSources.js';
export { PluginSecretSourceContributionV1Schema, type PluginSecretSourceContributionV1 } from './secretSources.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginClientExecutionReferenceV1Schema } from './clientExecution.js';
import { AgentSessionModeDescriptorSchema, AgentStateRequestCoverageOptionsSchema } from './agentSessionCapabilities.js';
export { AgentSessionModeDescriptorSchema, type AgentSessionModeDescriptor } from './agentSessionCapabilities.js';
export { AgentStateRequestCoverageOptionsSchema, type AgentStateRequestCoverageOptions } from './agentSessionCapabilities.js';
import {
  PluginActionContributionV2Schema,
  PluginActionAvailabilityV2Schema,
  PluginJsonSchemaV2Schema,
} from '../actions/v2.js';
import {
  PluginNotificationCategoryContributionV2Schema,
  PluginNotificationChannelContributionV2Schema,
} from './notifications.js';
import {
  ScmHostingProviderContributionSchema,
} from './scmHostingProviders.js';
import {
  ScmBackendContributionSchema,
} from './scmBackends.js';
import {
  PluginManagedDependencyContributionV2Schema,
} from './managedDependencies.js';
import {
  PluginMcpContributesV1Schema,
} from './mcp.js';
import {
  PluginRequestInterceptorContributionV1Schema,
} from '../requestInterceptors/v1.js';
import { PluginSettingsContributionV2Schema } from './settings.js';
import {
  PluginExecutionRunProfileContributionV2Schema,
} from './executionRunProfiles.js';
import {
  PluginEventContributionV1Schema,
} from './events.js';
import {
  getPluginHookDefinitionV1,
  PluginHookIdV1Schema,
  PluginHookScopeV1Schema,
  type PluginHookScopeV1,
} from '../hooks/catalog.js';
import {
  PluginSystemToolContributionV1Schema,
} from './systemTools.js';
import {
  PluginPromptAssetContributionV1Schema,
} from './promptAssets.js';
import {
  PluginUiInstanceKeyV1Schema,
  PluginUiLaunchInputV1Schema,
} from '../ui/semanticCommands.js';
import { PluginResourceContextV1Schema } from '../ui/surfaceContext.js';
export { PluginResourceContextV1Schema, type PluginResourceContextV1 } from '../ui/surfaceContext.js';
import {
  PluginSessionHeaderActionDescriptorV1Schema,
} from './ui/sessionHeaderActions.js';
import {
  PluginTranscriptActivityContributionV1Schema,
} from './ui/transcriptActivities.js';
import {
  PluginSessionInfoSectionContributionV1Schema,
} from './ui/sessionInfoSections.js';
import {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
} from './browser/v1.js';
import {
  PLUGIN_CONTRIBUTION_FAMILY_V2,
  buildPluginContributionFamilySchemaV2,
  definePluginContributionFamilyV2,
} from './families.js';
import { ProviderContributionV1Schema } from '../../providers/contributions/v1.js';
import { VoiceModelPackContributionV1Schema } from '../../voice/modelPacks/contributionV1.js';
import { VoiceProviderContributionSchema } from './voiceProviders.js';
import { PluginUiContributionsV2Schema } from './ui/v2.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginRoleDeclarationV1Schema } from './roles.js';
import { PluginWorkflowContributionV1Schema } from './workflowDeclarationV1.js';
import { PluginInputTypeContributionV1Schema } from './inputTypes.js';
import { PluginAtmospherePictureContributionV1Schema } from './atmospherePictures.js';
import { PluginThemeContributionV1Schema } from './themes.js';
import { PluginRegistrySourceContributionV1Schema } from './registrySources.js';
import { PluginLanguageServerContributionV1Schema } from './languageServers.js';
import { PluginSkillContributionV1Schema } from './skills.js';
import { PluginBotTemplateContributionV1Schema } from './botTemplates.js';
export { PluginBotTemplateContributionV1Schema, type PluginBotTemplateContributionV1 } from './botTemplates.js';
export { PluginSkillContributionV1Schema, type PluginSkillContributionV1, projectPluginSkillDeclarationV1 } from './skills.js';
export { PluginInputTypeContributionV1Schema, type PluginInputTypeContributionV1 } from './inputTypes.js';
export { PluginAtmospherePictureContributionV1Schema, type PluginAtmospherePictureContributionV1 } from './atmospherePictures.js';
export { PluginThemeContributionV1Schema, type PluginThemeContributionV1 } from './themes.js';
export { PluginRegistrySourceContributionV1Schema, type PluginRegistrySourceContributionV1 } from './registrySources.js';
export { PluginLanguageServerContributionV1Schema, type PluginLanguageServerContributionV1 } from './languageServers.js';
import { PluginDragSourceContributionV1Schema, PluginDropTargetContributionV1Schema } from './entityDragDrop.js';
export * from './entityDragDrop.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';
import {
  PluginComposerReferenceProviderContributionV1Schema,
} from './composerReferenceProviders.js';
import {
  PluginSearchProviderContributionV1Schema,
  validatePluginSearchProviderContributionsV1,
} from './searchProviders.js';
import {
  PluginComposerAttachmentContributionV1Schema,
} from './composerAttachments.js';
import {
  PluginComposerControlContributionV1Schema,
} from './composerControls.js';
import {
  PluginComposerRegionContributionV1Schema,
} from './composerRegions.js';
import {
  PluginOpenableContentViewerContributionV1Schema,
} from '../openableContentViewerV1.js';
import {
  PluginAccountCollectionContributionV1Schema,
} from '../data/collectionContributionV1.js';
import {
  PluginDaemonDatabaseContributionV1Schema,
} from './daemonDatabases.js';
import { PluginWebhookContributionV1Schema } from './webhooks.js';
import {
  PluginContributionPointV1Schema,
  PluginTargetedContributionV1Schema,
  validateTargetedContributionEnvelopeBoundsV1,
} from './targetedContributions.js';

const PluginVoiceModelPackContributionV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(VoiceModelPackContributionV1Schema, { id: true }), { id: asProtocolZod(PluginContributionLocalIdSchema) })));

const PluginHookRegistrationFilterV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runtimeTargetId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  workspaceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  cwdPrefix: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  eventNames: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
}));

/**
 * The **content category** of a resource — what the bytes mean to their
 * consumer. This is the oldest of the three vocabularies that the codebase
 * loosely calls a "resource kind" and it keeps the `kind` field (§3.6.1):
 *
 * 1. `PluginResourceKindV2Schema` (here) — content category of a resource
 *    contribution, and of the `ResourceDescriptor` a read returns.
 * 2. `PluginSessionResourceTargetV1Schema.kind`
 *    (`contributions/ui/resources.ts`) — the **declarative UI target selector**
 *    vocabulary (`session` / `message` / `structuredMessage` /
 *    `sessionResource` / …). It names which part of the session model a
 *    declarative element binds to and is not a resource contribution at all;
 *    its nested `resourceKind` string is a session-resource type name.
 * 3. `PluginResourceSourceV2Schema` (below) — the **sourcing/lifecycle**
 *    discriminant of a resource contribution, and the only one that decides
 *    whether the resource can be watched.
 *
 * They are three separate vocabularies over three separate domains and are
 * deliberately never unified.
 */
export const PluginResourceKindV2Schema = lazyZodSchema(() => z.enum(['prompt', 'skill', 'template', 'asset', 'config']));
export type PluginResourceKind = z.infer<typeof PluginResourceKindV2Schema>;
export type PluginResourceKindV2 = PluginResourceKind;

/**
 * Where a resource's bytes come from, and therefore what lifecycle it has.
 *
 * - `packaged` — a file inside the admitted immutable package generation. Its
 *   bytes cannot change within the generation, so watching it is never
 *   advertised and no runtime registration exists for it.
 * - `dynamic` — bytes produced at runtime by an exactly-registered producer.
 *   It declares identity, content category, content type and byte bounds in the
 *   manifest, is read through the same snapshot authority, and is the only kind
 *   that can emit an invalidation.
 *
 * The discriminant is named `source` rather than `kind` because `kind` already
 * means the content category above.
 */
export const PluginResourceSourceV2Schema = lazyZodSchema(() => z.enum(['packaged', 'dynamic']));
export type PluginResourceSourceV2 = z.infer<typeof PluginResourceSourceV2Schema>;

/**
 * Dynamic bytes are either generation-global or host-contextual. The scope is
 * part of the immutable declaration: consumers cannot infer it from a caller
 * or add a second resource identity at runtime.
 */
export const PluginDynamicResourceScopeV1Schema = lazyZodSchema(() => z.enum(['global', 'session', 'surface']));
export type PluginDynamicResourceScopeV1 = z.infer<typeof PluginDynamicResourceScopeV1Schema>;

/**
 * `source` is optional on the packaged arm so that every already-admitted
 * manifest — none of which names a source — keeps parsing unchanged. Absent
 * means packaged.
 */
export const PluginPackagedResourceContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  source: z.optional(z.literal('packaged')),
  kind: PluginResourceKindV2Schema,
  path: z.string().check(z.trim(), z.minLength(1)),
  digest: z.optional(z.string().check(z.trim(), z.minLength(1))),
  contentType: z.string().check(z.trim(), z.minLength(1)),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginPackagedResourceContributionV2 =
  z.infer<typeof PluginPackagedResourceContributionV2Schema>;

export const MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2 = 16 * 1024 * 1024;

export const PluginDynamicResourceExecutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('target', [
  z.strictObject({ target: z.literal('daemon') }),
  z.strictObject({ target: z.literal('account'), account: PluginClientExecutionReferenceV1Schema }),
]));
export type PluginDynamicResourceExecutionV1 = z.infer<typeof PluginDynamicResourceExecutionV1Schema>;

export const PluginDynamicResourceContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  source: z.literal('dynamic'),
  kind: PluginResourceKindV2Schema,
  contentType: z.string().check(z.trim(), z.minLength(1)),
  /** Omitted legacy dynamic declarations retain their existing global bytes. */
  scope: z._default(PluginDynamicResourceScopeV1Schema, 'global'),
  /** Scope selects context; only this explicit declaration selects the host. */
  execution: z.optional(PluginDynamicResourceExecutionV1Schema),
  sessionInbox: z.optional(PluginSessionInboxResourceBindingV1Schema),
  hostAccess: z.optional(z.array(PluginHostAccessRequestIdV2Schema).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.'))),
  maxBytes: z.optional(z.number().check(z.int(), z.positive(), z.maximum(MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2))),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginDynamicResourceContributionV2 =
  z.infer<typeof PluginDynamicResourceContributionV2Schema>;

/**
 * One discriminated resource contribution family (§3.6.1): one catalog, one
 * qualified identity, one read authority, one lifecycle — with conditional
 * runtime producer registration for the dynamic arm only.
 */
export const PluginResourceContributionV2Schema = lazyZodSchema(() => z.union([
  PluginDynamicResourceContributionV2Schema,
  PluginPackagedResourceContributionV2Schema,
]));
export type PluginResourceContributionV2 = z.infer<typeof PluginResourceContributionV2Schema>;

/**
 * The single predicate every consumer uses to tell the two arms apart. Reading
 * `source === 'dynamic'` inline in a consumer would be a second decision-maker
 * for the same discrimination.
 */
export function isDynamicPluginResourceContributionV2(
  value: Readonly<Record<string, unknown>> | PluginResourceContributionV2,
): value is PluginDynamicResourceContributionV2 {
  return (value as Readonly<Record<string, unknown>>).source === 'dynamic';
}

export { PluginHookScopeV1Schema, type PluginHookScopeV1 };

export const PluginHookContributionV2Schema = lazyZodSchema(() => z.pipe(z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  on: PluginHookIdV1Schema,
  category: z.optional(HookCategoryV1Schema),
  scope: z.optional(PluginHookScopeV1Schema),
  filters: z.optional(PluginHookRegistrationFilterV1Schema),
  executionKind: z.optional(HookExecutionKindV1Schema),
  priority: z.optional(z.number().check(z.int())),
  hostAccess: z.optional(z.array(PluginHostAccessRequestIdV2Schema).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.'))),
}), z.transform((declaration) => {
  // The closed hook-id enum and catalog are checked together by catalog.test.
  const definition = getPluginHookDefinitionV1(declaration.on)!;
  return {
    ...declaration,
    category: definition.category,
    scope: definition.scope,
    executionKind: definition.executionKind,
  };
})));
export type PluginHookContributionV2 = z.infer<typeof PluginHookContributionV2Schema>;

export const BackgroundServiceContributionSchema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.optional(PluginLocalizedStringV2Schema),
  placement: z.optional(z.enum(['daemon', 'process'])),
  activation: z.optional(z.enum(['continuous', 'demand'])),
}));
export type BackgroundServiceContribution = z.infer<typeof BackgroundServiceContributionSchema>;

export {
  CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
  CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1,
  ConnectedAccountDirectExportContractV1Schema,
  PluginConnectedAccountAccessOnlyExportV1Schema,
  type ConnectedAccountDirectExportContractV1,
  type PluginConnectedAccountAccessOnlyExportV1,
  PluginConnectedAccountDirectExportV2Schema,
  PluginConnectedAccountAuthenticationModeV2Schema,
  PluginConnectedAccountAuthenticationV2Schema,
  PluginConnectedAccountConfigurationFieldV2Schema,
  PluginConnectedAccountConfigurationV2Schema,
  PluginConnectedAccountDescriptorContributionV2Schema,
  type PluginConnectedAccountDirectExportV2,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountAuthenticationV2,
  type PluginConnectedAccountConfigurationFieldV2,
  type PluginConnectedAccountConfigurationV2,
  type PluginConnectedAccountDescriptorContributionV2,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';

export type PluginCoreContributionFamiliesV2 = readonly [
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.agents, typeof PluginAgentContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.providers, typeof ProviderContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.machineProvisioners, typeof MachineProvisionerContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.accessProviders, typeof AccessProviderContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.deploymentTargets, typeof DeploymentTargetContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.healthCheckKinds, typeof HealthCheckKindContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.storeKinds, typeof PluginStoreKindContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.machineRecipes, typeof MachineRecipeV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.machineSetupPresets, typeof MachineSetupPresetContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.actions, typeof PluginActionContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.resources, typeof PluginResourceContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.subjectKinds, typeof PluginSubjectKindContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.inputTypes, typeof PluginInputTypeContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.atmospherePictures, typeof PluginAtmospherePictureContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.themes, typeof PluginThemeContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.registrySources, typeof PluginRegistrySourceContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.backupDestinations, typeof BackupDestinationContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.languageServers, typeof PluginLanguageServerContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.skills, typeof PluginSkillContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.botTemplates, typeof PluginBotTemplateContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.dragSources, typeof PluginDragSourceContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.workItems, typeof PluginWorkItemsContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.dropTargets, typeof PluginDropTargetContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.transcriptActivities, typeof PluginTranscriptActivityContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.sessionInfoSections, typeof PluginSessionInfoSectionContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.sessionHeaderActions, typeof PluginSessionHeaderActionDescriptorV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.browserTargets, typeof PluginBrowserTargetContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.browserActions, typeof PluginBrowserActionContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.settings, typeof PluginSettingsContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.events, typeof PluginEventContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.executionRunProfiles, typeof PluginExecutionRunProfileContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.roles, typeof PluginRoleDeclarationV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.workflows, typeof PluginWorkflowContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.notifications, typeof PluginNotificationCategoryContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.notificationChannels, typeof PluginNotificationChannelContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.scmHostingProviders, typeof ScmHostingProviderContributionSchema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.scmBackends, typeof ScmBackendContributionSchema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.connectedAccountDescriptors, typeof PluginConnectedAccountDescriptorContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.managedDependencies, typeof PluginManagedDependencyContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.systemTools, typeof PluginSystemToolContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.promptAssets, typeof PluginPromptAssetContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.hooks, typeof PluginHookContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.requestInterceptors, typeof PluginRequestInterceptorContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.voiceModelPacks, typeof PluginVoiceModelPackContributionV2Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.voiceProviders, typeof VoiceProviderContributionSchema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.backgroundServices, typeof BackgroundServiceContributionSchema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.machineRoles, typeof MachineRoleDeclarationV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.captureSources, typeof PluginCaptureSourceContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.secretSources, typeof PluginSecretSourceContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.serviceLaunchEnvironments, typeof PluginServiceLaunchEnvironmentContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.databaseEngines, typeof PluginDatabaseEngineContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.projectNativeAdapters, typeof PluginProjectNativeAdapterContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.daemonDatabases, typeof PluginDaemonDatabaseContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.composerReferences, typeof PluginComposerReferenceProviderContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.searchProviders, typeof PluginSearchProviderContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.composerAttachments, typeof PluginComposerAttachmentContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.composerControls, typeof PluginComposerControlContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.composerRegions, typeof PluginComposerRegionContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.openableContentViewers, typeof PluginOpenableContentViewerContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.accountCollections, typeof PluginAccountCollectionContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.webhooks, typeof PluginWebhookContributionV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.pluginContributionPoints, typeof PluginContributionPointV1Schema>,
  import('./families.js').PluginContributionFamilyDescriptorV2<typeof PLUGIN_CONTRIBUTION_FAMILY_V2.targetedPluginContributions, typeof PluginTargetedContributionV1Schema>,
];

export const PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2: PluginCoreContributionFamiliesV2 = [
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.agents, schema: PluginAgentContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.providers, schema: ProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.machineProvisioners, schema: MachineProvisionerContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.accessProviders, schema: AccessProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.deploymentTargets, schema: DeploymentTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.healthCheckKinds, schema: HealthCheckKindContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.storeKinds, schema: PluginStoreKindContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.machineRecipes, schema: MachineRecipeV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.machineSetupPresets, schema: MachineSetupPresetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.actions, schema: PluginActionContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.resources, schema: PluginResourceContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.subjectKinds, schema: PluginSubjectKindContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.inputTypes, schema: PluginInputTypeContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.atmospherePictures, schema: PluginAtmospherePictureContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.themes, schema: PluginThemeContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.registrySources, schema: PluginRegistrySourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.backupDestinations, schema: BackupDestinationContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.languageServers, schema: PluginLanguageServerContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.skills, schema: PluginSkillContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.botTemplates, schema: PluginBotTemplateContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.dragSources, schema: PluginDragSourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.workItems, schema: PluginWorkItemsContributionV1Schema, maxItems: 1 }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.dropTargets, schema: PluginDropTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.transcriptActivities, schema: PluginTranscriptActivityContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.sessionInfoSections, schema: PluginSessionInfoSectionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.sessionHeaderActions, schema: PluginSessionHeaderActionDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.browserTargets, schema: PluginBrowserTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.browserActions, schema: PluginBrowserActionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.settings, schema: PluginSettingsContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.events, schema: PluginEventContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.executionRunProfiles, schema: PluginExecutionRunProfileContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.roles, schema: PluginRoleDeclarationV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.workflows, schema: PluginWorkflowContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.notifications, schema: PluginNotificationCategoryContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.notificationChannels, schema: PluginNotificationChannelContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.scmHostingProviders, schema: ScmHostingProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.scmBackends, schema: ScmBackendContributionSchema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.connectedAccountDescriptors, schema: PluginConnectedAccountDescriptorContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.managedDependencies, schema: PluginManagedDependencyContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.systemTools, schema: PluginSystemToolContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.promptAssets, schema: PluginPromptAssetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.hooks, schema: PluginHookContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.requestInterceptors, schema: PluginRequestInterceptorContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.voiceModelPacks, schema: PluginVoiceModelPackContributionV2Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.voiceProviders, schema: VoiceProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.backgroundServices, schema: BackgroundServiceContributionSchema }),
  // Machine roles (OWNER-RULINGS 2026-11-12): the same declaration shape as the core role catalog.
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.machineRoles, schema: MachineRoleDeclarationV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.captureSources, schema: PluginCaptureSourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.secretSources, schema: PluginSecretSourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.serviceLaunchEnvironments, schema: PluginServiceLaunchEnvironmentContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.databaseEngines, schema: PluginDatabaseEngineContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.projectNativeAdapters, schema: PluginProjectNativeAdapterContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.daemonDatabases, schema: PluginDaemonDatabaseContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerReferences, schema: PluginComposerReferenceProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.searchProviders, schema: PluginSearchProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerAttachments, schema: PluginComposerAttachmentContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerControls, schema: PluginComposerControlContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerRegions, schema: PluginComposerRegionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.openableContentViewers, schema: PluginOpenableContentViewerContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.accountCollections, schema: PluginAccountCollectionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.webhooks, schema: PluginWebhookContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.pluginContributionPoints, schema: PluginContributionPointV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.targetedPluginContributions, schema: PluginTargetedContributionV1Schema }),
] as const;

const PluginContributesV2BaseSchema: ReturnType<typeof buildPluginContributionFamilySchemaV2<PluginCoreContributionFamiliesV2>> = lazyZodSchema(() => buildPluginContributionFamilySchemaV2(
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
));

type PluginContributesV2ExtendedShape = z.core.util.Extend<
  (typeof PluginContributesV2BaseSchema)['shape'],
  {
    mcp: typeof PluginMcpContributesV1Schema;
    ui: typeof PluginUiContributionsV2Schema;
  }
>;

function createPluginContributesV2SchemaWithoutDefault(): z.ZodMiniObject<
  PluginContributesV2ExtendedShape,
  (typeof PluginContributesV2BaseSchema)['_zod']['config']
> {
  return lazyZodSchema(() => z.extend(PluginContributesV2BaseSchema, {
  mcp: PluginMcpContributesV1Schema,
  ui: PluginUiContributionsV2Schema,
}).check(z.superRefine((value, ctx) => {
  const providerIds = new Set<string>();
  value.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: 'Duplicate provider contribution id' });
    }
    providerIds.add(provider.id);
  });
  value.resources.forEach((resource, index) => {
    if (!isDynamicPluginResourceContributionV2(resource) || !resource.sessionInbox) return;
    const detail = value.resources.find(candidate => candidate.id === resource.sessionInbox!.detailResourceId);
    if (resource.scope !== 'surface' || resource.contentType !== 'application/json'
      || !detail || !isDynamicPluginResourceContributionV2(detail)
      || detail.scope !== 'session' || detail.contentType !== 'application/json') {
      ctx.addIssue({ code: 'custom', path: ['resources', index, 'sessionInbox'],
        message: 'A Session Inbox index requires surface scope and a declared Session-scoped JSON detail Resource.' });
    }
  });
  if (value.accountCollections.length > 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountCollections'],
      message: 'At most 32 account collection contributions are allowed.',
    });
  }
  value.webhooks.forEach((webhook, index) => {
    if ('delivery' in webhook) return;
    const handlerAction = webhook.handlerAction;
    const action = value.actions.find((candidate) => candidate.id === handlerAction.localId);
    if (!action) {
      ctx.addIssue({
        code: 'custom',
        path: ['webhooks', index, 'handlerAction', 'localId'],
        message: 'Webhook handlerAction must reference a declared same-plugin Action',
      });
    } else if (!action.surfaces.includes('plugin')) {
      ctx.addIssue({
        code: 'custom',
        path: ['webhooks', index, 'handlerAction', 'localId'],
        message: 'Webhook handlerAction must declare the plugin surface',
      });
    }
  });
  validatePluginSubjectKindContributionsV1(value, ctx);
  validatePluginSearchProviderContributionsV1(value, ctx);
  validateMachineProvisionerContributionsV1(value, ctx);
  validateAccessProviderContributionsV1(value, ctx);
  validateDeploymentTargetContributionsV1(value, ctx);
  validateHealthCheckKindContributionsV1(value, ctx);
  validatePluginStoreKindContributionsV1(value, ctx);
  validateTargetedContributionEnvelopeBoundsV1(value, ctx);
})));
}
type PluginContributesV2ShapeDefinition = ReturnType<typeof createPluginContributesV2SchemaWithoutDefault>['shape'];
export interface PluginContributesV2Shape extends PluginContributesV2ShapeDefinition {}
const PluginContributesV2SchemaWithoutDefault: z.ZodMiniObject<PluginContributesV2Shape> =
  lazyZodSchema(createPluginContributesV2SchemaWithoutDefault);

export const PluginContributesV2Schema: z.ZodMiniDefault<typeof PluginContributesV2SchemaWithoutDefault> = lazyZodSchema(() => z._default(PluginContributesV2SchemaWithoutDefault, PluginContributesV2SchemaWithoutDefault.parse({})));
export type PluginContributesV2 = z.infer<typeof PluginContributesV2Schema>;

export {
  PluginContributionPointProtocolV1Schema,
  PluginContributionPointV1Schema,
  PluginTargetedContributionOperationInputV1Schema,
  PluginTargetedContributionOperationRequirementsV1Schema,
  PluginTargetedContributionOperationV1Schema,
  PluginTargetedContributionSurfacePresentationV1Schema,
  PluginTargetedContributionSurfaceV1Schema,
  PluginTargetedContributionProtocolV1Schema,
  PluginTargetedContributionTargetV1Schema,
  PluginTargetedContributionV1Schema,
  rehydratePluginContributionPointSemanticsV1,
  type PluginContributionPointProtocolV1,
  type PluginContributionPointV1,
  type PluginTargetedContributionOperationInputV1,
  type PluginTargetedContributionOperationRequirementsV1,
  type PluginTargetedContributionOperationV1,
  type PluginTargetedContributionSurfacePresentationV1,
  type PluginTargetedContributionSurfaceV1,
  type PluginTargetedContributionProtocolV1,
  type PluginTargetedContributionTargetV1,
  type PluginTargetedContributionV1,
  type RehydratedPluginContributionPointOperationV1,
  type RehydratedPluginContributionPointSemanticsV1,
  type RehydratedPluginContributionPointSurfaceV1,
} from './targetedContributions.js';
export {
  PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH,
  PluginUiRendererChainBindingV1Schema,
  type PluginUiRendererChainBindingV1,
} from './ui/rendererChainBinding.js';

export {
  VoiceProviderContributionSchema,
  type VoiceProviderContribution,
  VoiceProviderAccountOperationKindV1Schema,
  type VoiceProviderAccountOperationKindV1,
} from './voiceProviders.js';

export {
  PluginSystemToolContributionV1Schema,
  type PluginSystemToolContributionV1,
} from './systemTools.js';

export {
  PluginPromptAssetContributionV1Schema,
  type PluginPromptAssetContributionV1,
} from './promptAssets.js';
export { PluginRoleDeclarationV1Schema, type PluginRoleDeclarationV1 } from './roles.js';
export { PluginWorkflowContributionV1Schema, type PluginWorkflowContributionV1 } from './workflowDeclarationV1.js';
export {
  PluginWebhookContributionV1Schema,
  PluginWebhookVerifierV1Schema,
  type PluginWebhookContributionV1,
  type PluginWebhookVerifierV1,
} from './webhooks.js';

export {
  PluginUiTranslationsContributionV1Schema,
  type PluginUiTranslationsContributionV1,
} from './ui/i18n.js';
export {
  PluginSessionHeaderActionDescriptorV1Schema,
  type PluginSessionHeaderActionDescriptorV1,
} from './ui/sessionHeaderActions.js';
export {
  PluginSurfaceAppTargetV1Schema,
  PluginSurfaceBrowserTargetV1Schema,
  PluginSurfaceProjectTargetV1Schema,
  PluginSurfaceSessionTargetV1Schema,
  PluginSurfaceTargetV1Schema,
  type PluginSurfaceTargetV1,
} from './ui/surfaceTargets.js';
export {
  PluginHostedWebContributionV1Schema,
  type PluginHostedWebContributionV1,
} from './ui/hostedWeb.js';
export {
  PluginHostedWebCspPolicyV1Schema,
  PluginHostedWebOriginV1Schema,
  PluginHostedWebSecurityPolicyV1Schema,
  buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
  type PluginHostedWebCspPolicyV1,
  type PluginHostedWebOriginV1,
  type PluginHostedWebSecurityPolicyV1,
} from './ui/hostedWebSecurity.js';
export {
  PluginTranscriptActivityContributionV1Schema,
  type PluginTranscriptActivityContributionV1,
} from './ui/transcriptActivities.js';
export {
  PluginSessionInfoSectionContributionV1Schema,
  type PluginSessionInfoSectionContributionV1,
} from './ui/sessionInfoSections.js';
export {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
  type PluginBrowserActionContributionV1,
  type PluginBrowserTargetContributionV1,
} from './browser/v1.js';
