import { z } from 'zod';
import { PluginCaptureSourceContributionV1Schema } from './captureSources.js';
export { PluginCaptureSourceContributionV1Schema, type PluginCaptureSourceContributionV1 } from './captureSources.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import { PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginAgentSessionCapabilitiesV2Schema,
  type PluginAgentSessionCapabilitiesV2,
} from './agentSessionCapabilities.js';
import {
  PluginActionContributionV2Schema,
  PluginActionAvailabilityV2Schema,
  PluginJsonSchemaV2Schema,
  PluginToolContributionV2Schema,
} from '../actions/v2.js';
import {
  AgentUiBehaviorDeclarationV1Schema,
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
} from './settings.js';
import {
  PluginExecutionRunProfileContributionV2Schema,
} from './executionRunProfiles.js';
import {
  PluginEventContributionV1Schema,
} from './events.js';
import {
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
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginRoleDeclarationV1Schema } from './roles.js';
import { PluginWorkflowContributionV1Schema } from './workflows.js';
import { PluginInputTypeContributionV1Schema } from './inputTypes.js';
export { PluginInputTypeContributionV1Schema, type PluginInputTypeContributionV1 } from './inputTypes.js';
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

const PluginVoiceModelPackContributionV2Schema = VoiceModelPackContributionV1Schema
  .omit({ id: true })
  .extend({ id: asProtocolZod(PluginContributionLocalIdSchema) })
  .strict();

const PluginHookRegistrationFilterV1Schema = z.object({
  agentId: z.string().trim().min(1).optional(),
  runtimeTargetId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwdPrefix: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  eventNames: z.array(z.string().trim().min(1)).optional(),
}).strict();

const PluginAgentAcpStderrMatchRuleV2Schema = z.object({
  includes: z.array(z.string().min(1)).min(1),
  caseSensitive: z.boolean().optional(),
}).strict();

const PluginAgentAcpStderrStatusErrorRuleV2Schema =
  PluginAgentAcpStderrMatchRuleV2Schema.extend({
    detail: z.string().min(1),
  }).strict();

const PluginAgentAcpStderrRulesV2Schema = z.object({
  authenticationErrorDetail: z.string().trim().min(1).optional(),
  suppress: z.array(PluginAgentAcpStderrMatchRuleV2Schema)
    .min(1)
    .optional(),
  statusErrors: z.array(PluginAgentAcpStderrStatusErrorRuleV2Schema)
    .min(1)
    .optional(),
}).strict().refine(
  (value) => value.authenticationErrorDetail !== undefined || value.suppress !== undefined || value.statusErrors !== undefined,
  'ACP stderr rules must declare at least one rule.',
);

const PluginAgentAcpPermissionModeMappingV2Schema = z.object({
  default: z.string().trim().min(1).nullable().optional(),
  'read-only': z.string().trim().min(1).nullable().optional(),
  'safe-yolo': z.string().trim().min(1).nullable().optional(),
  yolo: z.string().trim().min(1).nullable().optional(),
  plan: z.string().trim().min(1).nullable().optional(),
}).strict();

const PluginAgentAcpPermissionModeArgvV2Schema = z.object({
  flag: z.string().trim().min(1),
  map: PluginAgentAcpPermissionModeMappingV2Schema,
}).strict();

const PluginAgentAcpPlatformValueV2Schema = z.object({
  posix: z.string().trim().min(1),
  win32: z.string().trim().min(1),
}).strict();

const PluginAgentAcpPlatformSegmentsV2Schema = z.object({
  posix: z.array(z.string().trim().min(1)).min(1),
  win32: z.array(z.string().trim().min(1)).min(1),
}).strict();

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
const PluginAgentAcpNativeSessionMcpConfigV2Schema = z.object({
  /** Environment variable naming the provider's config root. */
  configRootEnvKey: PluginAgentAcpPlatformValueV2Schema,
  /** Config root relative to the user's home directory when that variable is unset. */
  homeRelativeConfigRoot: PluginAgentAcpPlatformSegmentsV2Schema,
  /** Provider directory inside the config root that holds the MCP config file. */
  directory: z.string().trim().min(1),
  /** MCP config file name inside that directory. */
  fileName: z.string().trim().min(1),
  /** Key of the JSON object holding the server map. */
  serversKey: z.string().trim().min(1),
  /** Constant fields merged into every host-generated server entry. */
  serverEntryConstants: z.record(z.string().trim().min(1), z.string()).optional(),
  /** Config-root siblings linked into the session-private root beside `directory`. */
  linkedConfigRootEntries: z.array(z.string().trim().min(1)).min(1).optional(),
  /**
   * Workspace-relative provider config files that would shadow a session
   * server. A shadowing project entry fails the launch instead of silently
   * replacing a Happier tool server.
   */
  projectShadowPaths: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict();
export type PluginAgentAcpNativeSessionMcpConfigV2 =
  z.infer<typeof PluginAgentAcpNativeSessionMcpConfigV2Schema>;

const PluginAgentAcpModelSuffixOptionValueV2Schema = z.object({
  value: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Words a provider model name may use for this value, when they differ from `name`. */
  modelNameWords: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict();

const PluginAgentAcpModelTrailingOptionValueV2Schema = z.object({
  /** Provider-native id segment appended after the primary suffix option value. */
  segment: z.string().trim().min(1),
  /** Stable option value reported to Happier clients. */
  value: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Words a provider model name may use for this value, when they differ from `name`. */
  modelNameWords: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict();

const PluginAgentAcpModelTrailingOptionV2Schema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Option value represented by the absence of a trailing provider id segment. */
  defaultValue: z.object({
    value: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }).strict(),
  values: z.array(PluginAgentAcpModelTrailingOptionValueV2Schema)
    .min(1)
    .superRefine((values, context) => {
      if (new Set(values.map((entry) => entry.segment)).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Trailing option segments must be unique.' });
      }
      if (new Set(values.map((entry) => entry.value)).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Trailing option values must be unique.' });
      }
    }),
}).strict().superRefine((option, context) => {
  if (option.values.some((entry) => entry.value === option.defaultValue.value)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultValue', 'value'],
      message: 'The default trailing option value must differ from segment-backed values.',
    });
  }
});

/**
 * Providers that advertise one model per option value encode that value in the
 * model id (`<model>-high`, `<model>-high-fast`). This declaration lets the
 * host present one model plus a canonical option instead of a combinatorial
 * model list, and to expand a selection back to the advertised id.
 */
const PluginAgentAcpModelSuffixOptionV2Schema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  values: z.array(PluginAgentAcpModelSuffixOptionValueV2Schema)
    .min(2)
    .refine(
      (values) => new Set(values.map((entry) => entry.value)).size === values.length,
      'Option values must be unique.',
    ),
  /** Id segments that may follow the option segment, such as a speed tier. */
  trailingSegments: z.array(z.string().trim().min(1)).min(1).optional(),
  /**
   * Optionally projects a complete matrix of trailing provider segments as a second model option.
   * Incomplete matrices retain their separate provider models.
   */
  trailingOption: PluginAgentAcpModelTrailingOptionV2Schema.optional(),
  /** Words a provider model name may place after the value word, such as `Thinking`. */
  modelNameFillerWords: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict().superRefine((option, context) => {
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
});
export type PluginAgentAcpModelSuffixOptionV2 =
  z.infer<typeof PluginAgentAcpModelSuffixOptionV2Schema>;

/**
 * Data-only behavior the host ACP composer can apply without invoking plugin
 * code. Dynamic ACP behavior remains a custom Agent runtime responsibility.
 */
export const PluginAgentAcpDefinitionV2Schema = z.object({
  auth: z.object({
    methodId: z.string().trim().min(1).max(256),
  }).strict().optional(),
  modelConfigOptionId: z.string().trim().min(1).optional(),
  stderrRules: PluginAgentAcpStderrRulesV2Schema.optional(),
  mcp: z.object({
    policy: z.enum(['pass_through', 'drop']),
    nativeSessionConfig: PluginAgentAcpNativeSessionMcpConfigV2Schema.optional(),
  }).strict().optional(),
  models: z.object({
    suffixOption: PluginAgentAcpModelSuffixOptionV2Schema,
  }).strict().optional(),
  permissionModeMapping: PluginAgentAcpPermissionModeMappingV2Schema.optional(),
  permissionModeArgv: PluginAgentAcpPermissionModeArgvV2Schema.optional(),
}).strict().refine(
  (value) => (
    value.auth !== undefined
    || value.modelConfigOptionId !== undefined
    || value.stderrRules !== undefined
    || value.mcp !== undefined
    || value.models !== undefined
    || value.permissionModeMapping !== undefined
    || value.permissionModeArgv !== undefined
  ),
  'ACP definitions must declare at least one behavior.',
).refine(
  (value) => value.mcp?.nativeSessionConfig === undefined || value.mcp.policy === 'drop',
  {
    path: ['mcp'],
    message: 'Native session MCP config delivery requires the `drop` input policy.',
  },
);
export type PluginAgentAcpDefinitionV2 = z.infer<typeof PluginAgentAcpDefinitionV2Schema>;

export const PluginAgentRuntimeAcpV2Schema = z.object({
  kind: z.literal('acp'),
  transport: PluginAgentAcpTransportSchema,
  definition: PluginAgentAcpDefinitionV2Schema.optional(),
}).strict();
export type PluginAgentRuntimeAcpV2 = z.infer<typeof PluginAgentRuntimeAcpV2Schema>;

export const PluginAgentRuntimeCustomV2Schema = z.object({
  kind: z.literal('custom'),
}).strict();
export type PluginAgentRuntimeCustomV2 = z.infer<typeof PluginAgentRuntimeCustomV2Schema>;

export const PluginAgentRuntimeV2Schema = z.discriminatedUnion('kind', [
  PluginAgentRuntimeAcpV2Schema,
  PluginAgentRuntimeCustomV2Schema,
]);
export type PluginAgentRuntimeV2 = z.infer<typeof PluginAgentRuntimeV2Schema>;

// The Agent Session capability vocabulary is owned by the focused contribution
// module so small runtime contracts can consume it without importing this
// aggregate manifest. It is re-exported here unchanged for manifest consumers.
export {
  PluginAgentSessionCapabilitiesV2Schema,
  type PluginAgentSessionCapabilitiesV2,
};

export const PluginAgentExecutionRunCapabilitiesV2Schema = z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), checkpoint: z.boolean(), stop: z.boolean(),
}).strict();
export type PluginAgentExecutionRunCapabilitiesV2 = z.infer<typeof PluginAgentExecutionRunCapabilitiesV2Schema>;

export const PluginAgentCapabilitySurfaceV2Schema = z.enum(['terminal', 'externalSessions']);
export type PluginAgentCapabilitySurfaceV2 = z.infer<typeof PluginAgentCapabilitySurfaceV2Schema>;

export const PluginAgentCapabilitySurfacesV2Schema = z.array(PluginAgentCapabilitySurfaceV2Schema)
  .refine((values) => new Set(values).size === values.length, 'Entries must be unique.');
export type PluginAgentCapabilitySurfacesV2 = z.infer<typeof PluginAgentCapabilitySurfacesV2Schema>;

/**
 * The one public declaration of how this Agent receives contributed Happier
 * tools. Absence deliberately means no delivery: the host must not infer a
 * channel from an Agent id, runtime kind, or the presence of tool declarations.
 */
export const PluginAgentToolsDeliveryV2Schema = z.enum([
  'native_mcp',
  'native_extension',
  'shell_bridge',
]);
export type PluginAgentToolsDeliveryV2 = z.infer<typeof PluginAgentToolsDeliveryV2Schema>;

export const PluginAgentToolsCapabilityV2Schema = z.object({
  delivery: PluginAgentToolsDeliveryV2Schema,
}).strict();
export type PluginAgentToolsCapabilityV2 = z.infer<typeof PluginAgentToolsCapabilityV2Schema>;

/** Prompted structured JSON consumed by the host's strict output normalizers. */
export const PluginAgentStructuredOutputCapabilityV2Schema = z.object({
  formats: z.tuple([z.literal('json')]),
}).strict();
export type PluginAgentStructuredOutputCapabilityV2 = z.infer<typeof PluginAgentStructuredOutputCapabilityV2Schema>;

const PluginAgentCapabilitiesV2Shape = {
  surfaces: PluginAgentCapabilitySurfacesV2Schema.optional(),
  sessions: PluginAgentSessionCapabilitiesV2Schema.optional(),
  executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema.optional(),
  tools: PluginAgentToolsCapabilityV2Schema.optional(),
  structuredOutput: PluginAgentStructuredOutputCapabilityV2Schema.optional(),
};

/**
 * The normalized lifecycle declaration is the one capability contract shared
 * by manifest parsing and the daemon projection. Consumers never reconstruct
 * this shape from Agent presentation metadata.
 */
export const PluginAgentCapabilitiesV2Schema = z.object(PluginAgentCapabilitiesV2Shape).strict()
  .refine(
    (value) => (
      value.surfaces !== undefined
      || value.sessions !== undefined
      || value.executionRuns !== undefined
      || value.tools !== undefined
    ),
    'At least one Agent capability declaration is required.',
  );
export type PluginAgentCapabilitiesV2 = z.infer<typeof PluginAgentCapabilitiesV2Schema>;

export const PluginAgentVendorResumeSupportV2Schema = z.enum(['supported', 'unsupported', 'experimental']);
export type PluginAgentVendorResumeSupportV2 = z.infer<typeof PluginAgentVendorResumeSupportV2Schema>;

export const AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES = 2_048;

const PluginAgentCodingPromptBehaviorBlockV1Schema = z.object({
  id: AgentSessionStartupInstructionsIdV1Schema,
  text: AgentSessionStartupInstructionsTextV1Schema.refine(
    (value) => new TextEncoder().encode(value).byteLength <= AGENT_CODING_PROMPT_BLOCK_V1_MAX_UTF8_BYTES,
    'Coding prompt block exceeds the UTF-8 byte limit',
  ),
  when: z.enum(['disableTodos']).optional(),
}).strict();

const PluginAgentCodingPromptBehaviorV1Schema = z.object({
  blocks: z.array(PluginAgentCodingPromptBehaviorBlockV1Schema).min(1),
}).strict();

const PluginAgentResumeChecklistV1Schema = z.object({
  includeLoginStatus: z.literal(true),
}).strict();

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
export const PluginAgentUiBehaviorContributionV2Schema = z.object({
  behavior: AgentUiBehaviorDeclarationV1Schema.optional(),
  session: AgentUiSessionDeclarationV1Schema.optional(),
  message: AgentUiMessageDeclarationV1Schema.optional(),
  components: AgentUiComponentsDeclarationV1Schema.optional(),
}).strict();
export type PluginAgentUiBehaviorContributionV2 = z.infer<typeof PluginAgentUiBehaviorContributionV2Schema>;
export { AgentUiProjectedDeclarationV1Schema, type AgentUiProjectedDeclarationV1 } from './agentUiGrammar.js';

/**
 * Declarative Agent catalog-entry facts.
 *
 * Bundled Agents carry these facts in the host's own Agent tables; a contributed
 * Agent has no such table, so the manifest is where it declares them. The host
 * projects this block through the single Agent catalog-entry hook owner, so a
 * contributed Agent and a bundled one reach the same catalog contract.
 */
export const PluginAgentCatalogV2Schema = z.object({
  /**
   * Native (vendor-owned) Session resume. Absent means the host infers the level
   * from the declared `capabilities.sessions.open` list, which cannot express
   * `experimental`.
   */
  vendorResume: z.object({
    support: PluginAgentVendorResumeSupportV2Schema,
  }).strict().optional(),
  /**
   * Binds this Agent's own CLI to a system tool the same plugin declares, so
   * `exec.systemTools.resolve({ toolId })` reaches the canonical Agent CLI
   * launch resolution — managed install, source preference and JavaScript-file
   * override included — instead of a bare executable-name lookup. The host
   * resolves the launch from this Agent's declared `cli` metadata, so the
   * binding requires that block and a matching `systemTools` declaration.
   */
  agentCliSystemTool: z.object({
    toolId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict().optional(),
  /** Ordered data-only blocks the canonical coding prompt composer may include. */
  codingPromptBehavior: PluginAgentCodingPromptBehaviorV1Schema.optional(),
  /** The only Agent-specific resume-checklist policy currently supported by the host. */
  resumeChecklist: PluginAgentResumeChecklistV1Schema.optional(),
}).strict().refine(
  (value) => (
    value.vendorResume !== undefined
    || value.agentCliSystemTool !== undefined
    || value.codingPromptBehavior !== undefined
    || value.resumeChecklist !== undefined
  ),
  'At least one Agent catalog declaration is required.',
);
export type PluginAgentCatalogV2 = z.infer<typeof PluginAgentCatalogV2Schema>;

const PluginAgentDisplayV2Shape = {
  id: asProtocolZod(PluginContributionLocalIdSchema), title: PluginLocalizedStringV2Schema, description: PluginLocalizedStringV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  connectedAccounts: ConnectedAccountPurposeDeclarationsV1Schema.optional(),
  providerRequirements: AgentProviderRequirementsV1Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  surfaces: z.object({
    externalSession: z.object({
      sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema)
        .min(1)
        .max(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION),
      externalLinkedTakeover: z.object({
        writerSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
      }).strict().optional(),
    }).strict(),
  }).strict().optional(),
  cli: PluginAgentCliMetadataSchema.optional(),
  catalog: PluginAgentCatalogV2Schema.optional(),
  ui: PluginAgentUiBehaviorContributionV2Schema.optional(),
};
const PluginAgentSessionCapabilitiesShape = {
  surfaces: PluginAgentCapabilitySurfacesV2Schema.optional(),
  sessions: PluginAgentSessionCapabilitiesV2Schema,
  tools: PluginAgentToolsCapabilityV2Schema.optional(),
  structuredOutput: PluginAgentStructuredOutputCapabilityV2Schema.optional(),
};
const PluginAgentSessionPrimaryShape = {
  primary: z.literal('sessions'),
  // A Session-capable Agent registers only its native Session runtime: the
  // host derives the finite Execution Run projection from Session facts, so a
  // Session-primary declaration may not carry an `executionRuns` block and
  // this strict shape rejects one.
  capabilities: z.object(PluginAgentSessionCapabilitiesShape).strict(),
};
const PluginAgentExecutionPrimaryShape = {
  primary: z.literal('executionRuns'),
  capabilities: z.object({
    surfaces: PluginAgentCapabilitySurfacesV2Schema.optional(),
    executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema,
    tools: PluginAgentToolsCapabilityV2Schema.optional(),
    structuredOutput: PluginAgentStructuredOutputCapabilityV2Schema.optional(),
  }).strict(),
};
const PluginAgentPrimaryContributionV2Schema = z.union([
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeAcpV2Schema, ...PluginAgentSessionPrimaryShape }).strict(),
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentSessionPrimaryShape }).strict(),
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentExecutionPrimaryShape }).strict(),
]);
const PluginAgentExternalSessionsAuxiliaryV2Schema = z.object({
  ...PluginAgentDisplayV2Shape,
  capabilities: z.object({
    surfaces: PluginAgentCapabilitySurfacesV2Schema
      .refine((values) => values.includes('externalSessions'), 'An auxiliary-only Agent must declare the externalSessions surface.'),
  }).strict(),
}).strict();

export const PluginAgentContributionV2Schema = z.union([
  PluginAgentPrimaryContributionV2Schema,
  PluginAgentExternalSessionsAuxiliaryV2Schema,
]).superRefine((value, ctx) => {
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
});
export type PluginAgentContributionV2 = z.input<typeof PluginAgentContributionV2Schema>;
export type ParsedPluginAgentContributionV2 = z.output<typeof PluginAgentContributionV2Schema>;

export const PluginCommandVisibilityV2Schema = z.enum(['default', 'advanced']);
export type PluginCommandVisibilityV2 = z.infer<typeof PluginCommandVisibilityV2Schema>;

export const PluginCommandContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.union([z.string().trim().min(1), z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict()]),
  description: z.union([z.string().trim().min(1), z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict()]).optional(),
  path: z.array(z.string().trim().min(1)).min(1),
  action: z.union([z.string().trim().min(1), z.object({ pluginId: z.string().min(1), localId: z.string().min(1) }).strict()]),
  visibility: PluginCommandVisibilityV2Schema.optional(),
  arguments: PluginJsonSchemaV2Schema.optional(),
  tmux: z.enum(['inherit', 'required', 'forbidden']).optional(),
  availability: PluginActionAvailabilityV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginCommandContributionV2 = z.infer<typeof PluginCommandContributionV2Schema>;

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
export const PluginResourceKindV2Schema = z.enum(['prompt', 'skill', 'template', 'asset', 'config']);
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
export const PluginResourceSourceV2Schema = z.enum(['packaged', 'dynamic']);
export type PluginResourceSourceV2 = z.infer<typeof PluginResourceSourceV2Schema>;

/**
 * Dynamic bytes are either generation-global or host-contextual. The scope is
 * part of the immutable declaration: consumers cannot infer it from a caller
 * or add a second resource identity at runtime.
 */
export const PluginDynamicResourceScopeV1Schema = z.enum(['global', 'session', 'surface']);
export type PluginDynamicResourceScopeV1 = z.infer<typeof PluginDynamicResourceScopeV1Schema>;

/**
 * The host-stamped context carried only to a contextual dynamic Resource
 * producer. It is deliberately not a generic caller metadata bag: the closed
 * union makes an absent/wrong context fail through the Resource owner.
 */
export const PluginResourceContextV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({
    kind: z.literal('session'),
    sessionId: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal('surface'),
    mountInstanceKey: PluginUiInstanceKeyV1Schema,
    launchInput: PluginUiLaunchInputV1Schema,
  }).strict(),
]);
export type PluginResourceContextV1 = z.infer<typeof PluginResourceContextV1Schema>;

/**
 * `source` is optional on the packaged arm so that every already-admitted
 * manifest — none of which names a source — keeps parsing unchanged. Absent
 * means packaged.
 */
export const PluginPackagedResourceContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  source: z.literal('packaged').optional(),
  kind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: z.string().trim().min(1).optional(),
  contentType: z.string().trim().min(1),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginPackagedResourceContributionV2 =
  z.infer<typeof PluginPackagedResourceContributionV2Schema>;

export const MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2 = 16 * 1024 * 1024;

export const PluginDynamicResourceContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  source: z.literal('dynamic'),
  kind: PluginResourceKindV2Schema,
  contentType: z.string().trim().min(1),
  /** Omitted legacy dynamic declarations retain their existing global bytes. */
  scope: PluginDynamicResourceScopeV1Schema.default('global'),
  hostAccess: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .min(1)
    .refine((values) => new Set(values).size === values.length, 'Entries must be unique.')
    .optional(),
  maxBytes: z.number().int().positive().max(MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginDynamicResourceContributionV2 =
  z.infer<typeof PluginDynamicResourceContributionV2Schema>;

/**
 * One discriminated resource contribution family (§3.6.1): one catalog, one
 * qualified identity, one read authority, one lifecycle — with conditional
 * runtime producer registration for the dynamic arm only.
 */
export const PluginResourceContributionV2Schema = z.union([
  PluginDynamicResourceContributionV2Schema,
  PluginPackagedResourceContributionV2Schema,
]);
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

export const PluginHookContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  on: PluginHookIdV1Schema,
  hookApiVersion: z.literal(1).default(1),
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  filters: PluginHookRegistrationFilterV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema,
  priority: z.number().int().optional(),
  hostAccess: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .min(1)
    .refine((values) => new Set(values).size === values.length, 'Entries must be unique.')
    .optional(),
  compatibility: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginHookContributionV2 = z.infer<typeof PluginHookContributionV2Schema>;

export const BackgroundServiceContributionSchema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema.optional(),
}).strict();
export type BackgroundServiceContribution = z.infer<typeof BackgroundServiceContributionSchema>;

export {
  CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
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

export const PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 = [
  definePluginContributionFamilyV2({ family: 'agents', schema: PluginAgentContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'providers', schema: ProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'actions', schema: PluginActionContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'commands', schema: PluginCommandContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'tools', schema: PluginToolContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'resources', schema: PluginResourceContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'inputTypes', schema: PluginInputTypeContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'dragSources', schema: PluginDragSourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'dropTargets', schema: PluginDropTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'transcriptActivities', schema: PluginTranscriptActivityContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionInfoSections', schema: PluginSessionInfoSectionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionHeaderActions', schema: PluginSessionHeaderActionDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserTargets', schema: PluginBrowserTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserActions', schema: PluginBrowserActionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'settings', schema: PluginSettingsContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'events', schema: PluginEventContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'executionRunProfiles', schema: PluginExecutionRunProfileContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'roles', schema: PluginRoleDeclarationV1Schema }),
  definePluginContributionFamilyV2({ family: 'workflows', schema: PluginWorkflowContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'notifications', schema: PluginNotificationCategoryContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'notificationChannels', schema: PluginNotificationChannelContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'scmHostingProviders', schema: ScmHostingProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: 'scmBackends', schema: ScmBackendContributionSchema }),
  definePluginContributionFamilyV2({ family: 'connectedAccountDescriptors', schema: PluginConnectedAccountDescriptorContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'managedDependencies', schema: PluginManagedDependencyContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'systemTools', schema: PluginSystemToolContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'promptAssets', schema: PluginPromptAssetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'hooks', schema: PluginHookContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'requestInterceptors', schema: PluginRequestInterceptorContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'voiceModelPacks', schema: PluginVoiceModelPackContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'voiceProviders', schema: VoiceProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: 'backgroundServices', schema: BackgroundServiceContributionSchema }),
  definePluginContributionFamilyV2({ family: 'captureSources', schema: PluginCaptureSourceContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'daemonDatabases', schema: PluginDaemonDatabaseContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'composerReferences', schema: PluginComposerReferenceProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'searchProviders', schema: PluginSearchProviderContributionV1Schema }),
  definePluginContributionFamilyV2({
    family: 'composerAttachments',
    schema: PluginComposerAttachmentContributionV1Schema,
    maxItems: MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1,
  }),
  definePluginContributionFamilyV2({ family: 'composerControls', schema: PluginComposerControlContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'composerRegions', schema: PluginComposerRegionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'openableContentViewers', schema: PluginOpenableContentViewerContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'accountCollections', schema: PluginAccountCollectionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'webhooks', schema: PluginWebhookContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'pluginContributionPoints', schema: PluginContributionPointV1Schema }),
  definePluginContributionFamilyV2({ family: 'targetedPluginContributions', schema: PluginTargetedContributionV1Schema }),
] as const;

const PluginContributesV2BaseSchema = buildPluginContributionFamilySchemaV2(
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
);

const PluginContributesV2SchemaWithoutDefault = PluginContributesV2BaseSchema.extend({
  mcp: PluginMcpContributesV1Schema,
  ui: PluginUiContributionsV2Schema,
}).superRefine((value, ctx) => {
  const providerIds = new Set<string>();
  value.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: 'Duplicate provider contribution id' });
    }
    providerIds.add(provider.id);
  });
  if (value.accountCollections.length > 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountCollections'],
      message: 'At most 32 account collection contributions are allowed.',
    });
  }
  value.webhooks.forEach((webhook, index) => {
    const action = value.actions.find((candidate) => candidate.id === webhook.handlerAction.localId);
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
  validatePluginSearchProviderContributionsV1(value, ctx);
  validateTargetedContributionEnvelopeBoundsV1(value, ctx);
});

export const PluginContributesV2Schema = PluginContributesV2SchemaWithoutDefault.default(
  PluginContributesV2SchemaWithoutDefault.parse({}),
);
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
export { PluginWorkflowContributionV1Schema, type PluginWorkflowContributionV1 } from './workflows.js';
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
  resolvePluginHostedWebSourceMapPolicyV1,
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
