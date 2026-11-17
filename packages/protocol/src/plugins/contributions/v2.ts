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
import { isPortableRelativePath } from '../../filesystem/portablePathSegment.js';
import { AcpRegistryAgentV1Schema } from '../../registries/registryItemsV1.js';
import { PluginAgentAcpStderrRulesV2Schema } from './agentAcpStderrRules.js';
import { PluginAgentAcpPermissionModeArgvMappingV2Schema, PluginAgentAcpPermissionModeMappingV2Schema } from './agentAcpPermissionModeMapping.js';
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
import {
  AgentSessionModeDescriptorSchema,
  AgentStateRequestCoverageOptionsSchema,
  PluginAgentSessionCompactionCapabilityV2Schema,
  type PluginAgentSessionCompactionCapabilityV2,
  type AgentSessionCompactionCapability,
  type AgentSessionCompactionIdleCapability,
  PluginAgentSessionCapabilitiesV2Schema,
  type PluginAgentSessionCapabilitiesV2,
} from './agentSessionCapabilities.js';
export { AgentSessionModeDescriptorSchema, type AgentSessionModeDescriptor } from './agentSessionCapabilities.js';
export { AgentStateRequestCoverageOptionsSchema, type AgentStateRequestCoverageOptions } from './agentSessionCapabilities.js';
import {
  PluginActionContributionV2Schema,
  PluginActionAvailabilityV2Schema,
  PluginJsonSchemaV2Schema,
} from '../actions/v2.js';
import {
  AgentUiBehaviorDeclarationV1Schema,
  AgentUiIdentityColorV1Schema,
  AgentUiComponentsDeclarationV1Schema,
  AgentUiMessageDeclarationV1Schema,
  AgentUiSessionDeclarationV1Schema,
} from './agentUiGrammar.js';
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
import {
  PluginSettingsContributionV2Schema,
  PluginSettingFieldIdV2Schema,
} from './settings.js';
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
import { AgentProviderRequirementsV1Schema } from '../../providers/compatibility/v1.js';
import { VoiceModelPackContributionV1Schema } from '../../voice/modelPacks/contributionV1.js';
import { VoiceProviderContributionSchema } from './voiceProviders.js';
import { PluginAgentAcpTransportSchema } from './agentAcpTransport.js';
import { PluginAgentCliMetadataSchema } from './agentCliMetadata.js';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from '../contributionLimits.js';
import {
  PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../backendDefinitionV1.js';
import { findAgentResumeOnlyExternalSourceContractIssue } from './agentResumeOnlySources.js';
import { PluginUiContributionsV2Schema } from './ui/v2.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
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
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { ConnectedAccountPurposeDeclarationsV1Schema } from '../../connect/connectedAccountPurposes.js';
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
  MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1,
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
import {
  AgentSessionStartupInstructionsIdV1Schema,
  AgentSessionStartupInstructionsTextV1Schema,
} from '../../runtime/agentSessionStartupInstructionsV1.js';

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

const PluginAgentAcpPermissionModeArgvV2Schema = lazyZodSchema(() => z.strictObject({
  flag: z.string().check(z.trim(), z.minLength(1)),
  map: PluginAgentAcpPermissionModeArgvMappingV2Schema,
}));

const PluginAgentAcpPlatformValueV2Schema = lazyZodSchema(() => z.strictObject({
  posix: z.string().check(z.trim(), z.minLength(1)),
  win32: z.string().check(z.trim(), z.minLength(1)),
}));

const PluginAgentAcpPlatformSegmentsV2Schema = lazyZodSchema(() => z.strictObject({
  posix: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
  win32: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
}));

/**
 * An Agent whose CLI reads MCP servers only from its own config file cannot
 * receive them through `session/new`. This declaration lets the host deliver
 * them natively: it materializes a session-private config root that links the
 * user's real provider config, writes the merged server map into it, and
 * points the provider's config-root variable at that root for one launch.
 *
 * The declaration is data-only on purpose: a Session opened by the
 * out-of-process Session runner reconstructs its runtime from the attested
 * manifest alone and never loads plugin code.
 */
const PluginAgentAcpNativeSessionMcpConfigV2Schema = lazyZodSchema(() => z.strictObject({
  /** Environment variable naming the provider's config root. */
  configRootEnvKey: PluginAgentAcpPlatformValueV2Schema,
  /** Config root relative to the user's home directory when that variable is unset. */
  homeRelativeConfigRoot: PluginAgentAcpPlatformSegmentsV2Schema,
  /** Provider directory inside the config root that holds the MCP config file. */
  directory: z.string().check(z.trim(), z.minLength(1)),
  /** MCP config file name inside that directory. */
  fileName: z.string().check(z.trim(), z.minLength(1)),
  /** Key of the JSON object holding the server map. */
  serversKey: z.string().check(z.trim(), z.minLength(1)),
  /** Constant fields merged into every host-generated server entry. */
  serverEntryConstants: z.optional(z.record(z.string().check(z.trim(), z.minLength(1)), z.string())),
  /**
   * Workspace-relative provider config files that would shadow a session
   * server. A shadowing project entry fails the launch instead of silently
   * replacing a Happier tool server.
   */
  projectShadowPaths: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1))),
}));
export type PluginAgentAcpNativeSessionMcpConfigV2 =
  z.infer<typeof PluginAgentAcpNativeSessionMcpConfigV2Schema>;

const PluginAgentAcpModelSuffixOptionValueV2Schema = lazyZodSchema(() => z.strictObject({
  value: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  /** Words a provider model name may use for this value, when they differ from `name`. */
  modelNameWords: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1))),
}));

const PluginAgentAcpModelTrailingOptionValueV2Schema = lazyZodSchema(() => z.strictObject({
  /** Provider-native id segment appended after the primary suffix option value. */
  segment: z.string().check(z.trim(), z.minLength(1)),
  /** Stable option value reported to Happier clients. */
  value: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  /** Words a provider model name may use for this value, when they differ from `name`. */
  modelNameWords: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1))),
}));

const PluginAgentAcpModelTrailingOptionV2Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  /** Option value represented by the absence of a trailing provider id segment. */
  defaultValue: z.strictObject({
    value: z.string().check(z.trim(), z.minLength(1)),
    name: z.string().check(z.trim(), z.minLength(1)),
  }),
  values: z.array(PluginAgentAcpModelTrailingOptionValueV2Schema).check(z.minLength(1), z.superRefine((values, context) => {
      if (new Set(values.map((entry) => entry.segment)).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Trailing option segments must be unique.' });
      }
      if (new Set(values.map((entry) => entry.value)).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Trailing option values must be unique.' });
      }
    })),
}).check(z.superRefine((option, context) => {
  if (option.values.some((entry) => entry.value === option.defaultValue.value)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultValue', 'value'],
      message: 'The default trailing option value must differ from segment-backed values.',
    });
  }
})));

/**
 * Providers that advertise one model per option value encode that value in the
 * model id (`<model>-high`, `<model>-high-fast`). This declaration lets the
 * host present one model plus a canonical option instead of a combinatorial
 * model list, and to expand a selection back to the advertised id.
 */
// Keep concrete identity for the public Manifest's shared JSON Schema references.
const PluginAgentAcpModelSuffixOptionV2Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  values: z.array(PluginAgentAcpModelSuffixOptionValueV2Schema).check(z.minLength(2), z.refine((values) => new Set(values.map((entry) => entry.value)).size === values.length, 'Option values must be unique.')),
  /** Id segments that may follow the option segment, such as a speed tier. */
  trailingSegments: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1))),
  /**
   * Optionally projects a complete matrix of trailing provider segments as a second model option.
   * Incomplete matrices retain their separate provider models.
   */
  trailingOption: z.optional(PluginAgentAcpModelTrailingOptionV2Schema),
  /** Words a provider model name may place after the value word, such as `Thinking`. */
  modelNameFillerWords: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1))),
}).check(z.superRefine((option, context) => {
  if (option.trailingSegments && option.trailingOption) {
    context.addIssue({
      code: 'custom',
      path: ['trailingOption'],
      message: 'Use either trailingSegments or trailingOption, not both.',
    });
  }
  if (option.trailingOption?.id === option.id) {
    context.addIssue({
      code: 'custom',
      path: ['trailingOption', 'id'],
      message: 'Primary and trailing option ids must differ.',
    });
  }
})));
export type PluginAgentAcpModelSuffixOptionV2 =
  z.infer<typeof PluginAgentAcpModelSuffixOptionV2Schema>;

/**
 * Data-only behavior the host ACP composer can apply without invoking plugin
 * code. Dynamic ACP behavior remains a custom Agent runtime responsibility.
 */
export const PluginAgentAcpSkillsSessionDeliveryV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('env_path_list'), envKey: z.string().check(z.minLength(1)),
    separator: z.enum([',', 'path_delimiter']), value: z.enum(['skills_root', 'plugin_root']),
  }),
  z.strictObject({
    kind: z.literal('defaults_file_env'), envKey: z.string().check(z.minLength(1)),
    directoriesKeyPath: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
    disabledKeyPath: z.optional(z.array(z.string().check(z.minLength(1))).check(z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('native_config_skills_dir'),
    subdirectory: z.string().check(z.minLength(1), z.refine(value => !value.includes('/') && isPortableRelativePath(value), 'Native skills subdirectories must be portable path segments.')),
  }),
]));
export type PluginAgentAcpSkillsSessionDeliveryV2 = z.infer<typeof PluginAgentAcpSkillsSessionDeliveryV2Schema>;

const PluginAgentAcpMcpInputPolicyV2Schema = lazyZodSchema(() => z.strictObject({
  policy: z.enum(['pass_through', 'drop']),
  nativeSessionConfig: z.optional(PluginAgentAcpNativeSessionMcpConfigV2Schema),
}));
export type PluginAgentAcpMcpInputPolicyV2 = z.infer<typeof PluginAgentAcpMcpInputPolicyV2Schema>;

export const PluginAgentAcpDefinitionV2Schema = lazyZodSchema(() => z.strictObject({
  auth: z.optional(z.strictObject({
    methodId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    setupFailure: z.optional(z.strictObject({
      requestErrorCode: z.number().check(z.int()),
      dataReason: z.string().check(z.minLength(1)),
    })),
  })),
  modelConfigOptionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  stderrRules: z.optional(PluginAgentAcpStderrRulesV2Schema),
  mcp: z.optional(PluginAgentAcpMcpInputPolicyV2Schema),
  skills: z.optional(z.strictObject({ sessionDelivery: PluginAgentAcpSkillsSessionDeliveryV2Schema })),
  models: z.optional(z.strictObject({
    suffixOption: PluginAgentAcpModelSuffixOptionV2Schema,
  })),
  usageLimitDiagnostic: z.optional(z.strictObject({
    pattern: z.string().check(z.minLength(1), z.refine(value => {
      try { new RegExp(value, 'u'); return true; } catch { return false; }
    }, 'Diagnostic patterns must be valid Unicode regular expressions.')),
    connectedAccountService: asProtocolZod(PluginContributionIdentityV1Schema),
  })),
  permissionModeMapping: z.optional(PluginAgentAcpPermissionModeMappingV2Schema),
  permissionModeArgv: z.optional(PluginAgentAcpPermissionModeArgvV2Schema),
}).check(z.refine((value) => (
    value.auth !== undefined
    || value.modelConfigOptionId !== undefined
    || value.stderrRules !== undefined
    || value.mcp !== undefined
    || value.skills !== undefined
    || value.models !== undefined
    || value.usageLimitDiagnostic !== undefined
    || value.permissionModeMapping !== undefined
    || value.permissionModeArgv !== undefined
  ), 'ACP definitions must declare at least one behavior.'), z.refine((value) => value.mcp?.nativeSessionConfig === undefined || value.mcp.policy === 'drop', {
    path: ['mcp'],
    message: 'Native session MCP config delivery requires the `drop` input policy.',
  }), z.refine((value) => value.skills?.sessionDelivery.kind !== 'native_config_skills_dir' || value.mcp?.nativeSessionConfig !== undefined, {
    path: ['skills', 'sessionDelivery'], message: 'Native skills directory delivery requires a native session config root.',
  })));
export type PluginAgentAcpDefinitionV2 = z.infer<typeof PluginAgentAcpDefinitionV2Schema>;

export const PluginAgentRuntimeAcpV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('acp'),
  transport: PluginAgentAcpTransportSchema,
  definition: z.optional(PluginAgentAcpDefinitionV2Schema),
}));
export type PluginAgentRuntimeAcpV2 = z.infer<typeof PluginAgentRuntimeAcpV2Schema>;

export const PluginAgentRuntimeCustomV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('custom'),
  /** Static native permission facts also apply when a custom factory owns launch. */
  permissionModeMapping: z.optional(PluginAgentAcpPermissionModeMappingV2Schema),
}));
export type PluginAgentRuntimeCustomV2 = z.infer<typeof PluginAgentRuntimeCustomV2Schema>;

export const PluginAgentRuntimeV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginAgentRuntimeAcpV2Schema,
  PluginAgentRuntimeCustomV2Schema,
]));
export type PluginAgentRuntimeV2 = z.infer<typeof PluginAgentRuntimeV2Schema>;

// The Agent Session capability vocabulary is owned by the focused contribution
// module so small runtime contracts can consume it without importing this
// aggregate manifest. It is re-exported here unchanged for manifest consumers.
export {
  PluginAgentSessionCompactionCapabilityV2Schema,
  type PluginAgentSessionCompactionCapabilityV2,
  type AgentSessionCompactionCapability,
  type AgentSessionCompactionIdleCapability,
  PluginAgentSessionCapabilitiesV2Schema,
  type PluginAgentSessionCapabilitiesV2,
};

export const PluginAgentExecutionRunCapabilitiesV2Schema = lazyZodSchema(() => z.strictObject({
  open: z.array(z.enum(['create', 'resume', 'fork'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')), checkpoint: z.boolean(), stop: z.boolean(),
}));
export type PluginAgentExecutionRunCapabilitiesV2 = z.infer<typeof PluginAgentExecutionRunCapabilitiesV2Schema>;

export const PluginAgentCapabilitySurfaceV2Schema = lazyZodSchema(() => z.enum(['terminal', 'externalSessions']));
export type PluginAgentCapabilitySurfaceV2 = z.infer<typeof PluginAgentCapabilitySurfaceV2Schema>;

export const PluginAgentCapabilitySurfacesV2Schema = lazyZodSchema(() => z.array(PluginAgentCapabilitySurfaceV2Schema).check(z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')));
export type PluginAgentCapabilitySurfacesV2 = z.infer<typeof PluginAgentCapabilitySurfacesV2Schema>;

/**
 * The one public declaration of how this Agent receives contributed Happier
 * tools. Absence deliberately means no delivery: the host must not infer a
 * channel from an Agent id, runtime kind, or the presence of tool declarations.
 */
export const PluginAgentToolsDeliveryV2Schema = lazyZodSchema(() => z.enum([
  'native_mcp',
  'native_extension',
  'shell_bridge',
]));
export type PluginAgentToolsDeliveryV2 = z.infer<typeof PluginAgentToolsDeliveryV2Schema>;
/** Resolved host value; an absent manifest declaration is unsupported. */
export type AgentToolsDelivery = PluginAgentToolsDeliveryV2 | 'unsupported';

export function agentReceivesUserMcpServersV1(
  delivery: AgentToolsDelivery | undefined,
): boolean {
  return delivery === 'native_mcp' || delivery === 'native_extension';
}

export const PluginAgentToolsCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  delivery: PluginAgentToolsDeliveryV2Schema,
  mcpToolControl: z.optional(z.strictObject({ off: z.enum(['hidden', 'blocked']), approval: z.enum(['native', 'host']) })),
  mcpToolLoading: z.optional(z.enum(['every_turn', 'on_demand'])),
  /** Native transcript call id in MCP request _meta; absent means no native correlation. */
  mcpToolCallIdMetaKey: z.optional(z.string().check(z.minLength(1))),
}));
export type PluginAgentToolsCapabilityV2 = z.infer<typeof PluginAgentToolsCapabilityV2Schema>;

/** Session-private skill delivery and the Agent's declared native discovery roots. */
export const PluginAgentSkillsCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  delivery: z.enum(['session_dir', 'none']),
  /** Use the daemon's real-file layout when the Agent's plugin scanner rejects symlinks. */
  materialization: z.optional(z.literal('copy')),
  nativeDisable: z.enum(['supported', 'unsupported']),
  liveReload: z.enum(['supported', 'unsupported']),
  usageEvidence: z.optional(z.enum(['reported', 'none'])),
  nativeRoots: z.optional(z.strictObject({
    user: z.optional(z.array(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
    project: z.optional(z.array(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
    plugin: z.optional(z.array(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
  })),
}));
export type PluginAgentSkillsCapabilityV2 = z.infer<typeof PluginAgentSkillsCapabilityV2Schema>;

/** Prompted structured JSON consumed by the host's strict output normalizers. */
export const PluginAgentStructuredOutputCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  formats: z.tuple([z.literal('json')]),
}));
export type PluginAgentStructuredOutputCapabilityV2 = z.infer<typeof PluginAgentStructuredOutputCapabilityV2Schema>;

/** Public support/consent facts; native-home paths remain in the Agent runtime descriptor. */
const PluginAgentProviderStateSharingCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  config: z.strictObject({
    supported: z.boolean(),
    modes: z.array(z.enum(['linked', 'copied', 'isolated'])),
    unavailableReason: z.optional(z.enum(['not_implemented', 'dynamic_diagnostics_required'])),
  }),
  state: z.strictObject({
    supported: z.boolean(),
    modes: z.array(z.enum(['isolated', 'shared'])),
    sharedStatePrivacyRiskAcknowledgementRequired: z.optional(z.boolean()),
    unavailableReason: z.optional(z.enum(['not_implemented', 'dynamic_diagnostics_required'])),
  }),
}));

const PluginAgentCommonCapabilitiesV2Shape = {
  surfaces: z.optional(PluginAgentCapabilitySurfacesV2Schema),
  tools: z.optional(PluginAgentToolsCapabilityV2Schema),
  skills: z.optional(PluginAgentSkillsCapabilityV2Schema),
  structuredOutput: z.optional(PluginAgentStructuredOutputCapabilityV2Schema),
  nativeSandbox: z.optional(z.strictObject({ off: z.literal(true) })),
  providerStateSharing: z.optional(PluginAgentProviderStateSharingCapabilityV2Schema),
};
const PluginAgentCapabilitiesV2Shape = {
  ...PluginAgentCommonCapabilitiesV2Shape,
  sessions: z.optional(PluginAgentSessionCapabilitiesV2Schema),
  executionRuns: z.optional(PluginAgentExecutionRunCapabilitiesV2Schema),
};

/**
 * The normalized lifecycle declaration is the one capability contract shared
 * by manifest parsing and the daemon projection. Consumers never reconstruct
 * this shape from Agent presentation metadata.
 */
export const PluginAgentCapabilitiesV2Schema = lazyZodSchema(() => z.strictObject(PluginAgentCapabilitiesV2Shape).check(z.refine((value) => (
      value.surfaces !== undefined
      || value.sessions !== undefined
      || value.executionRuns !== undefined
      || value.tools !== undefined
    ), 'At least one Agent capability declaration is required.')));
export type PluginAgentCapabilitiesV2 = z.infer<typeof PluginAgentCapabilitiesV2Schema>;

export const PluginAgentVendorResumeSupportV2Schema = lazyZodSchema(() => z.enum(['supported', 'unsupported', 'experimental']));
export type PluginAgentVendorResumeSupportV2 = z.infer<typeof PluginAgentVendorResumeSupportV2Schema>;

export const AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES = 2_048;

const PluginAgentCodingPromptBehaviorBlockV1Schema = lazyZodSchema(() => z.strictObject({
  id: AgentSessionStartupInstructionsIdV1Schema,
  text: AgentSessionStartupInstructionsTextV1Schema.check(z.refine((value) => new TextEncoder().encode(value).byteLength <= AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES, 'Coding prompt block exceeds the UTF-8 byte limit')),
  when: z.optional(z.enum(['disableTodos'])),
}));

const PluginAgentCodingPromptBehaviorV1Schema = lazyZodSchema(() => z.strictObject({
  blocks: z.array(PluginAgentCodingPromptBehaviorBlockV1Schema).check(z.minLength(1)),
}));

const PluginAgentResumeChecklistV1Schema = lazyZodSchema(() => z.strictObject({
  includeLoginStatus: z.literal(true),
}));

/**
 * The client UI-behavior declaration an Agent contributes: the data-only
 * `plugin.ui.v1` surface (permission-footer handling, transcript storage modes,
 * composer/new-session facts, declarative component slots).
 *
 * The grammar is owned by `./agentUiGrammar.js` and is the SAME language a
 * bundled Agent authors, so an installed Agent reaches the client's behavior
 * projection with the same vocabulary and the same authoring feedback. Without
 * this field an installed Agent has no runtime channel to that projection at
 * all and is degraded to the neutral unknown behavior.
 *
 * The client still owns the one fail-closed interpreter; this schema refuses a
 * malformed declaration where it is authored instead of letting it reach that
 * interpreter and silently no-op.
 */
export const PluginAgentUiBehaviorContributionV2Schema = lazyZodSchema(() => z.strictObject({
  identityColor: z.optional(AgentUiIdentityColorV1Schema),
  behavior: z.optional(AgentUiBehaviorDeclarationV1Schema),
  session: z.optional(AgentUiSessionDeclarationV1Schema),
  message: z.optional(AgentUiMessageDeclarationV1Schema),
  components: z.optional(AgentUiComponentsDeclarationV1Schema),
}));
export type PluginAgentUiBehaviorContributionV2 = z.infer<typeof PluginAgentUiBehaviorContributionV2Schema>;
export type { AgentUiConditionV1 } from './agentUiGrammar.js';
export { AgentUiProjectedDeclarationV1Schema, type AgentUiProjectedDeclarationV1 } from './agentUiGrammar.js';

/**
 * Declarative Agent catalog-entry facts.
 *
 * Bundled Agents carry these facts in the host's own Agent tables; a contributed
 * Agent has no such table, so the manifest is where it declares them. The host
 * projects this block through the single Agent catalog-entry hook owner, so a
 * contributed Agent and a bundled one reach the same catalog contract.
 */
export const PluginAgentCatalogV2Schema = lazyZodSchema(() => z.strictObject({
  /** ACP Registry identities for this Agent; discovery only, never runtime routing. */
  acpRegistryIds: z.optional(z.array(AcpRegistryAgentV1Schema.shape.id)),
  /**
   * Native (vendor-owned) Session resume. Absent means the host infers the level
   * from the declared `capabilities.sessions.open` list, which cannot express
   * `experimental`.
   */
  vendorResume: z.optional(z.strictObject({
    support: PluginAgentVendorResumeSupportV2Schema,
  })),
  /**
   * Binds this Agent's own CLI to a system tool the same plugin declares, so
   * `exec.systemTools.resolve({ toolId })` reaches the canonical Agent CLI
   * launch resolution — managed install, source preference and JavaScript-file
   * override included — instead of a bare executable-name lookup. The host
   * resolves the launch from this Agent's declared `cli` metadata, so the
   * binding requires that block and a matching `systemTools` declaration.
   */
  agentCliSystemTool: z.optional(z.strictObject({
    toolId: asProtocolZod(PluginContributionLocalIdSchema),
  })),
  /** Ordered data-only blocks the canonical coding prompt composer may include. */
  codingPromptBehavior: z.optional(PluginAgentCodingPromptBehaviorV1Schema),
  /** The only Agent-specific resume-checklist policy currently supported by the host. */
  resumeChecklist: z.optional(PluginAgentResumeChecklistV1Schema),
}).check(z.refine((value) => (
    value.acpRegistryIds !== undefined
    || value.vendorResume !== undefined
    || value.agentCliSystemTool !== undefined
    || value.codingPromptBehavior !== undefined
    || value.resumeChecklist !== undefined
  ), 'At least one Agent catalog declaration is required.')));
export type PluginAgentCatalogV2 = z.infer<typeof PluginAgentCatalogV2Schema>;

const PluginAgentDisplayV2Shape = {
  id: asProtocolZod(PluginContributionLocalIdSchema), title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
  connectedAccounts: z.optional(ConnectedAccountPurposeDeclarationsV1Schema),
  providerRequirements: z.optional(AgentProviderRequirementsV1Schema),
  sessionModeDescriptor: z.optional(AgentSessionModeDescriptorSchema),
  requestCoverage: z.optional(AgentStateRequestCoverageOptionsSchema),
  accountSettings: z.optional(z.strictObject({
    settingLocalIds: z.array(PluginSettingFieldIdV2Schema).check(z.minLength(1)),
  })),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  surfaces: z.optional(z.strictObject({
    externalSession: z.strictObject({
      sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema).check(z.minLength(1), z.maxLength(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION)),
      externalLinkedTakeover: z.optional(z.strictObject({
        writerSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
      })),
    }),
  })),
  cli: z.optional(PluginAgentCliMetadataSchema),
  catalog: z.optional(PluginAgentCatalogV2Schema),
  ui: z.optional(PluginAgentUiBehaviorContributionV2Schema),
};
const PluginAgentSessionCapabilitiesShape = {
  ...PluginAgentCommonCapabilitiesV2Shape,
  sessions: PluginAgentSessionCapabilitiesV2Schema,
};
const PluginAgentSessionPrimaryShape = {
  primary: z.literal('sessions'),
  // A Session-capable Agent registers only its native Session runtime: the
  // host derives the finite Execution Run projection from Session facts, so a
  // Session-primary declaration may not carry an `executionRuns` block and
  // this strict shape rejects one.
  capabilities: z.strictObject(PluginAgentSessionCapabilitiesShape),
};
const PluginAgentExecutionPrimaryShape = {
  primary: z.literal('executionRuns'),
  capabilities: z.strictObject({
    ...PluginAgentCommonCapabilitiesV2Shape,
    executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema,
  }),
};
const PluginAgentPrimaryContributionV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeAcpV2Schema, ...PluginAgentSessionPrimaryShape }),
  z.strictObject({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentSessionPrimaryShape }),
  z.strictObject({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentExecutionPrimaryShape }),
]));
const PluginAgentExternalSessionsAuxiliaryV2Schema = lazyZodSchema(() => z.strictObject({
  ...PluginAgentDisplayV2Shape,
  capabilities: z.strictObject({
    surfaces: PluginAgentCapabilitySurfacesV2Schema.check(z.refine((values) => values.includes('externalSessions'), 'An auxiliary-only Agent must declare the externalSessions surface.')),
    providerStateSharing: z.optional(PluginAgentProviderStateSharingCapabilityV2Schema),
  }),
}));

// Keep concrete identity for the public Manifest's shared JSON Schema references.
export const PluginAgentContributionV2Schema = lazyZodSchema(() => z.union([
  PluginAgentPrimaryContributionV2Schema,
  PluginAgentExternalSessionsAuxiliaryV2Schema,
]).check(z.superRefine((value, ctx) => {
  if ('runtime' in value && value.runtime.kind === 'acp') {
    const declaresSessionDirectory = value.capabilities.skills?.delivery === 'session_dir';
    const hasSessionDelivery = value.runtime.definition?.skills?.sessionDelivery !== undefined;
    if (declaresSessionDirectory !== hasSessionDelivery) {
      ctx.addIssue({
        code: 'custom', path: ['capabilities', 'skills'],
        message: 'ACP session-directory skills delivery requires both the capability and its delivery declaration.',
      });
    }
  }
  const declaresExternalSessions = value.capabilities.surfaces?.includes('externalSessions') === true;
  const hasExternalSessionDescriptor = value.surfaces?.externalSession !== undefined;
  if (declaresExternalSessions && !hasExternalSessionDescriptor) {
    ctx.addIssue({
      code: 'custom',
      path: ['surfaces', 'externalSession'],
      message: 'The externalSessions capability requires an externalSession source descriptor.',
    });
  }
  if (hasExternalSessionDescriptor && !declaresExternalSessions) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'surfaces'],
      message: 'External-session source descriptors require the externalSessions capability.',
    });
  }
  const resumeOnlySourceIssue = findAgentResumeOnlyExternalSourceContractIssue(value);
  if (resumeOnlySourceIssue !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'sessions', 'open'],
      message: resumeOnlySourceIssue,
    });
  }
})));
export type PluginAgentContributionV2 = z.input<typeof PluginAgentContributionV2Schema>;
export type ParsedPluginAgentContributionV2 = z.output<typeof PluginAgentContributionV2Schema>;

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
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.projectNativeAdapters, schema: PluginProjectNativeAdapterContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.daemonDatabases, schema: PluginDaemonDatabaseContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerReferences, schema: PluginComposerReferenceProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: PLUGIN_CONTRIBUTION_FAMILY_V2.searchProviders, schema: PluginSearchProviderContributionV1Schema }),
  definePluginContributionFamilyV2({
    family: PLUGIN_CONTRIBUTION_FAMILY_V2.composerAttachments,
    schema: PluginComposerAttachmentContributionV1Schema,
    maxItems: MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1,
  }),
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
