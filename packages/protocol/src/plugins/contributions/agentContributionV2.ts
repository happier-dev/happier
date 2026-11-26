import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { McpToolLoadingV1Schema } from '../../mcp/servers/settingsV1.js';
import { isPortableRelativePath } from '../../filesystem/portablePathSegment.js';
import { AcpRegistryAgentV1Schema } from '../../registries/registryItemsV1.js';
import { PluginAgentAcpStderrRulesV2Schema } from './agentAcpStderrRules.js';
import { PluginAgentAcpPermissionModeArgvMappingV2Schema, PluginAgentAcpPermissionModeMappingV2Schema } from './agentAcpPermissionModeMapping.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
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
import {
  AgentUiBehaviorDeclarationV1Schema,
  AgentUiIdentityColorV1Schema,
  AgentUiComponentsDeclarationV1Schema,
  AgentUiMessageDeclarationV1Schema,
  AgentUiSessionDeclarationV1Schema,
} from './agentUiGrammar.js';
import { PluginSettingFieldIdV2Schema } from './settings.js';
import { AgentProviderRequirementsV1Schema } from '../../providers/compatibility/v1.js';
import { ProviderWireProtocolSchema } from '../../providers/capabilities/v1.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { PluginAgentAcpTransportSchema } from './agentAcpTransport.js';
import { PluginAgentCliMetadataSchema } from './agentCliMetadata.js';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from '../contributionLimits.js';
import {
  PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../backendDefinitionV1.js';
import { findAgentResumeOnlyExternalSourceContractIssue } from './agentResumeOnlySources.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { ConnectedAccountPurposeDeclarationsV1Schema, ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
import {
  AgentSessionStartupInstructionsIdV1Schema,
  AgentSessionStartupInstructionsTextV1Schema,
} from '../../runtime/agentSessionStartupInstructionsV1.js';

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

// Keep the Agent Session capability exports available to contribution consumers.
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
  /** Native filesystem enforcement of Run configuration.workspaceWrites='deny'. Absence is unsupported. */
  workspaceWrites: z.optional(z.literal('deny')),
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
  /** The native Run launch can enforce an empty tool allowlist, including built-in tools. */
  noTools: z.optional(z.boolean()),
  mcpToolControl: z.optional(z.strictObject({ off: z.enum(['hidden', 'blocked']), approval: z.enum(['native', 'host']) })),
  mcpToolLoading: z.optional(McpToolLoadingV1Schema),
  nativeCodeMode: z.optional(z.boolean()),
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
  /** An existing connected Session cannot switch to native sign-in with continuity. */
  connectedToNativeSwitchUnsupported: z.optional(z.literal(true)),
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

/** Child Agents an engine can drive; account and readiness decisions remain with those Agents' owners. */
export const PluginAgentRunnerV1Schema = lazyZodSchema(() => z.strictObject({
  agentTarget: AgentExecutionTargetV1Schema,
  /** Empty means native/Connected Account access only, with no supported Provider route. */
  providerProtocols: z.array(ProviderWireProtocolSchema),
  /** Omitted accepts all runner purposes; an empty list excludes runner Connected Accounts. */
  connectedAccountPurposes: z.optional(z.array(ConnectedAccountPurposeIdSchema)),
}));
export const PluginAgentRunnerSelectionV1Schema = lazyZodSchema(() => z.enum(['single', 'perMember']));

const PluginAgentDisplayV2Shape = {
  id: asProtocolZod(PluginContributionLocalIdSchema), title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
  connectedAccounts: z.optional(ConnectedAccountPurposeDeclarationsV1Schema),
  providerRequirements: z.optional(AgentProviderRequirementsV1Schema),
  runnerAgents: z.optional(z.array(PluginAgentRunnerV1Schema)),
  runnerSelection: z.optional(PluginAgentRunnerSelectionV1Schema),
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
    connectedToNativeSwitchUnsupported: z.optional(z.literal(true)),
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
