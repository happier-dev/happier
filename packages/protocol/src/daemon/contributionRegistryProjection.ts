import { z } from 'zod';

import {
  DaemonPluginStructuredMessageActionExecuteRequestSchema,
} from '../plugins/actions/daemonInvocationV1.js';
export {
  DaemonPluginHostPresentedComposerCurrentIntentV1Schema,
  DaemonPluginStructuredMessageActionExecuteRequestSchema,
  DaemonPluginStructuredMessageActionInvocationV1Schema,
  DaemonPluginStructuredMessageActionMountedBindingSchema,
  type DaemonPluginHostPresentedComposerCurrentIntentV1,
  type DaemonPluginStructuredMessageActionExecuteRequest,
  type DaemonPluginStructuredMessageActionInvocationV1,
  type DaemonPluginStructuredMessageActionMountedBinding,
} from '../plugins/actions/daemonInvocationV1.js';

import {
  ActionInputHintsSchema,
  ActionInputOptionValueSchema,
  ActionInputPathSchema,
  createActionInputHintsSchemas,
} from '../actions/actionInputHints.js';
import { ActionOperationDeclarationV1Schema } from '../actions/operations/v1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountRefSchema as CanonicalQualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import {
  PluginActionConfirmationV2Schema,
  PluginActionDangerLevelV2Schema,
  PluginActionExecutionV2Schema,
  PluginActionIconV2Schema,
  PluginActionPlacementV2Schema,
  PluginActionPlacementBindingsV2Schema,
  PluginActionScopeV2Schema,
  PluginActionSlashV2Schema,
  PluginActionSurfaceV2Schema,
  pluginActionRequiresConfirmationPresentation,
  pluginActionRequiresPlacement,
} from '../plugins/actions/v2.js';
import { PluginActionPresentUserAuthorizationFactsSchema } from '../plugins/actions/invocation.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { PluginUiHostMethodV1Schema } from '../plugins/ui/hostApiDefinition.js';
import { PluginUiResourceSubscriptionEventV1Schema } from '../plugins/ui/subscriptions.js';
import { PluginUiResolvedSemanticCommandV1Schema } from '../plugins/ui/semanticCommands.js';
import {
  ComposerSurfaceRoleV1Schema,
} from '../plugins/ui/composer.js';
import {
  PluginAgentCapabilitiesV2Schema,
  AgentUiProjectedDeclarationV1Schema,
  PluginResourceContextV1Schema,
  PluginResourceKindV2Schema,
} from '../plugins/contributions/v2.js';
import {
  PluginDescriptorClearWhenEmptyV1Schema,
  PluginDescriptorRedactionV1Schema,
} from '../plugins/contributions/_descriptors.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';
import { PluginEventAutomationDeclarationV1Schema } from '../automations/automationEventDeclarationV1.js';
import {
  readPluginSettingManagedServiceOrigin,
  readPluginSettingSecretCustody,
  PluginSettingAnalyticsV2Schema,
  PluginSettingFieldIdV2Schema,
  PluginSettingFieldPresentationV2Schema,
  PluginSettingFieldSchemaV2Schema,
  PluginSettingManagedServiceOriginV1Schema,
  PluginSecretCustodyV1Schema,
  PluginSettingsScopeRefV1Schema,
  PluginSettingsPresentationV2Schema,
  type PluginSettingFieldSchemaV2,
  type PluginSettingFieldV2,
  type PluginSettingsContributionV2,
} from '../plugins/contributions/settings.js';
import { PluginUiHeaderActionPresentationV1Schema } from '../plugins/contributions/ui/sessionHeaderActions.js';
import { PluginDeclarativeDocumentSourceV1Schema } from '../plugins/contributions/ui/v2.js';
import {
  PluginUiContainerV1Schema,
  PluginUiDestinationBindingV1Schema,
} from '../plugins/contributions/ui/surfaceRegistry.js';
import { PluginAgentCliMetadataSchema } from '../plugins/contributions/agentCliMetadata.js';
import { PluginOptionalStringSchema } from '../plugins/_shared.js';
import {
  PluginBackendCapabilitiesV1Schema,
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../plugins/backendDefinitionV1.js';
import {
  PluginContributionIdentityV1Schema as CanonicalPluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema as CanonicalPluginContributionLocalIdSchema,
  buildQualifiedPluginContributionKey,
} from '../plugins/contributionIdentity.js';
import {
  ComposerReferenceCandidatePageV1Schema,
  ComposerReferenceTriggerV1Schema,
  normalizeComposerReferenceQueryV1,
} from '../plugins/contributions/composerReferenceProviders.js';
import { PluginComposerAttachmentContributionV1Schema } from '../plugins/contributions/composerAttachments.js';
import { PluginComposerControlContributionV1Schema } from '../plugins/contributions/composerControls.js';
import { PluginComposerRegionContributionV1Schema } from '../plugins/contributions/composerRegions.js';
import { OpenableContentViewerSelectorV1Schema } from '../plugins/openableContent.js';
import { PluginIdSchema as CanonicalPluginIdSchema } from '../plugins/pluginId.js';
import {
  PluginUiImmutableGenerationIdV1Schema as CanonicalPluginUiImmutableGenerationIdV1Schema,
  PluginUiTargetedContributionProtocolV1Schema,
  PluginUiTargetedContributionSurfaceV1Schema,
  PluginUiTargetedContributionSurfacePresentationV1Schema,
  PluginUiTargetedContributionsV1Schema,
} from '../plugins/ui/targetedContributions.js';
import {
  NormalizedPluginCollectionUiQueryDescriptorV1Schema,
  PluginCollectionContractDigestV1Schema,
  PluginCollectionSchemaVersionV1Schema,
} from '../plugins/data/collectionsV1.js';
import { PluginMachineExecutionOriginV1Schema } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import {
  assertPluginProjectionFamilyIdsV2,
} from '../plugins/contributions/catalog.js';
import { ConnectedAccountUiProjectionEntryV1Schema } from '../connect/connectedAccountUiProjectionV1.js';
import {
  PluginContributionIntrospectionProjectionV1Schema,
  PluginDiagnosticRecordV1Schema,
} from './pluginContributionIntrospection.js';

const QualifiedConnectedAccountRefSchema = asProtocolZod(CanonicalQualifiedConnectedAccountRefSchema);
const PluginContributionIdentityV1Schema = asProtocolZod(CanonicalPluginContributionIdentityV1Schema);
const PluginContributionLocalIdSchema = asProtocolZod(CanonicalPluginContributionLocalIdSchema);
const PluginIdSchema = asProtocolZod(CanonicalPluginIdSchema);
const PluginUiImmutableGenerationIdV1Schema = asProtocolZod(
  CanonicalPluginUiImmutableGenerationIdV1Schema,
);

const RETIRED_PROVIDER_AS_AGENT_ENTRY_ALIASES = [
  'providerId',
  'providerAgentId',
] as const;
const RETIRED_PROVIDER_AS_AGENT_PROJECTION_ROOT_ALIASES = ['providersById'] as const;

function rejectRetiredProviderAsAgentProjectionAliases(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
  aliases: readonly string[],
): void {
  for (const alias of aliases) {
    if (!Object.hasOwn(value, alias)) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [alias],
      message: `Retired provider-as-Agent projection alias '${alias}' is not supported.`,
    });
  }
}

/**
 * Daemon-scoped merged contribution registry projection.
 *
 * This is an internal UI/daemon contract used for projection (display + grouping),
 * not for plugin execution. Keep it additive and versioned.
 */

export const DaemonContributionRegistryProjectionAgentEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).passthrough().superRefine((value, context) => {
  rejectRetiredProviderAsAgentProjectionAliases(
    value,
    context,
    RETIRED_PROVIDER_AS_AGENT_ENTRY_ALIASES,
  );
});
export type DaemonContributionRegistryProjectionAgentEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAgentEntryV1Schema
>;

export const DaemonContributionRegistryProjectionBackendEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).passthrough().superRefine((value, context) => {
  rejectRetiredProviderAsAgentProjectionAliases(
    value,
    context,
    RETIRED_PROVIDER_AS_AGENT_ENTRY_ALIASES,
  );
});
export type DaemonContributionRegistryProjectionBackendEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionBackendEntryV1Schema
>;

export const DaemonContributionRegistryProjectionActionEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  safety: z.string().trim().min(1),
  surfaces: z.record(z.string(), z.boolean()).default({}),
  bindings: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
export type DaemonContributionRegistryProjectionActionEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionActionEntryV1Schema
>;

export const DaemonContributionRegistryProjectionResourceEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
  type: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  path: PluginOptionalStringSchema,
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionResourceEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionResourceEntryV1Schema
>;

export const DaemonContributionRegistryProjectionV1Schema = z.object({
  v: z.literal(1),
  generationId: PluginOptionalStringSchema,
  agentsById: z.record(z.string(), DaemonContributionRegistryProjectionAgentEntryV1Schema).default({}),
  backendsById: z.record(z.string(), DaemonContributionRegistryProjectionBackendEntryV1Schema).default({}),
  actionsById: z.record(z.string(), DaemonContributionRegistryProjectionActionEntryV1Schema).default({}),
  resourcesById: z.record(z.string(), DaemonContributionRegistryProjectionResourceEntryV1Schema).default({}),
}).passthrough().superRefine((value, context) => {
  rejectRetiredProviderAsAgentProjectionAliases(
    value,
    context,
    RETIRED_PROVIDER_AS_AGENT_PROJECTION_ROOT_ALIASES,
  );
});
export type DaemonContributionRegistryProjectionV1 = z.infer<typeof DaemonContributionRegistryProjectionV1Schema>;

const DaemonReactNativeHostRuntimeIdentityStringV1Schema = z.string().trim().min(1);
const DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema =
  DaemonReactNativeHostRuntimeIdentityStringV1Schema.refine(
    (value) => value !== '*' && !value.includes('x'),
    { message: 'runtime identity versions must be exact' },
  );

/**
 * ScriptManager readiness reported by the UI/native host probe (PR-13).
 *
 * Readiness ORIGINATES from the UI native probe (the Re.Pack loader-backend
 * resolution) and travels to the daemon as part of the reported host-runtime
 * identity. The daemon CONSUMES these bits; it never asserts or infers them.
 * Both bits are required when the field is present so a partial report cannot
 * silently flip the gate; the whole field is optional so an older client (or
 * web/desktop, where no native runtime exists) reports nothing and the daemon
 * stays fail-closed.
 */
export const DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema = z.object({
  integrated: z.boolean(),
  installedArtifactLoaderAvailable: z.boolean(),
}).strict();
export type DaemonReactNativeHostRuntimeScriptManagerReadinessV1 = z.infer<
  typeof DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema
>;

export const DaemonReactNativeHostRuntimeIdentityV1Schema = z.object({
  platform: z.enum(['android', 'ios']),
  channel: z.enum(['development', 'internal', 'store']),
  rawUpdateChannel: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  appVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeApplicationVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeBuildVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  applicationId: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  reactVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  reactNativeVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  expoRuntimeVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  hermesVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  availableNativeCapabilities: z.array(DaemonReactNativeHostRuntimeIdentityStringV1Schema).default([]),
  scriptManagerRuntime: DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema.optional(),
}).strict();
export type DaemonReactNativeHostRuntimeIdentityV1 = z.infer<
  typeof DaemonReactNativeHostRuntimeIdentityV1Schema
>;

/** Installed-artifact loader readiness reported by a React Native web host. */
export const DaemonReactNativeWebLoaderCapabilityV1Schema = z.object({
  integrated: z.boolean(),
  installedArtifactLoaderAvailable: z.boolean(),
}).strict();
export type DaemonReactNativeWebLoaderCapabilityV1 = z.infer<
  typeof DaemonReactNativeWebLoaderCapabilityV1Schema
>;

/**
 * One exact physical hosted-frame adapter observed by the UI host. This is a
 * transport fact only: it does not attest to Artifact hosting, Account
 * eligibility, an endpoint, or any other server-owned admission condition.
 *
 * Keep the platform and adapter coupled. A renderer must never infer a native
 * adapter from a generic "web host" claim or substitute a browser iframe for
 * a packaged physical frame.
 */
export const DaemonHostedWebFrameCapabilityV1Schema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('web'),
    adapter: z.literal('domIframe'),
  }).strict(),
  z.object({
    platform: z.literal('desktop'),
    adapter: z.literal('wry'),
  }).strict(),
  z.object({
    platform: z.literal('ios'),
    adapter: z.literal('WKWebView'),
  }).strict(),
  z.object({
    platform: z.literal('android'),
    adapter: z.literal('WebViewAssetLoader'),
  }).strict(),
]);
export type DaemonHostedWebFrameCapabilityV1 = z.infer<
  typeof DaemonHostedWebFrameCapabilityV1Schema
>;

/**
 * The one mounted target whose cold-admitted contribution snapshot a client
 * may request. This is an equality fence against the daemon's current runtime
 * registry, never a general catalog selector.
 */
export const DaemonContributionRegistryProjectionMountedTargetV1Schema = z.object({
  pluginId: PluginIdSchema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
}).strict();
export type DaemonContributionRegistryProjectionMountedTargetV1 = z.infer<
  typeof DaemonContributionRegistryProjectionMountedTargetV1Schema
>;

export const DaemonContributionRegistryProjectionDescribeRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  /**
   * The caller's display locale. Plugin translation bundles are the largest part
   * of this response and a client reads exactly two of them — its preferred
   * locale merged over English — so naming the locale lets the daemon ship only
   * those. Omitting it keeps the whole set, which is what an older client
   * receives and what an older daemon returns for a newer client (the request
   * schema is `.passthrough()`, so an unknown field is accepted and ignored
   * rather than rejected).
   */
  locale: z.string().trim().min(1).max(64).optional(),
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  reactNativeWebLoaderCapability: DaemonReactNativeWebLoaderCapabilityV1Schema.optional(),
  hostedWebFrameCapability: DaemonHostedWebFrameCapabilityV1Schema.optional(),
  mountedTarget: DaemonContributionRegistryProjectionMountedTargetV1Schema.optional(),
}).passthrough().superRefine((value, context) => {
  if (value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'native runtime identity and web loader capability are mutually exclusive',
    });
  }
  if (
    value.reactNativeHostRuntimeIdentity
    && value.hostedWebFrameCapability
    && value.reactNativeHostRuntimeIdentity.platform !== value.hostedWebFrameCapability.platform
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'native runtime identity and hosted frame capability must report the same physical platform',
    });
  }
});
export type DaemonContributionRegistryProjectionDescribeRequest = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeRequestSchema
>;

/**
 * A cold, current Event Automation composer entry. This is deliberately a
 * response sibling rather than a field in the generic PluginProjectionV2:
 * Event authoring consumes it, while the generic projection remains a broad
 * display catalog with no Event-store or setup-binding ownership.
 */
export const DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema = z.object({
  id: z.string().trim().min(1).max(1024),
  identity: PluginContributionIdentityV1Schema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable(),
  inputSchema: PluginJsonSchemaV2Schema,
  inputHints: ActionInputHintsSchema.nullable(),
}).strict();
export type DaemonContributionRegistryProjectionAutomationEligibleEventActionV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema
>;

export const DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema = z.object({
  event: z.object({
    id: z.string().trim().min(1).max(1024),
    identity: PluginContributionIdentityV1Schema,
    immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).nullable(),
    payloadSchema: PluginJsonSchemaV2Schema.optional(),
    automation: PluginEventAutomationDeclarationV1Schema,
  }).strict(),
  setupAction: DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema,
  historyGapResetAction: DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema.optional(),
}).strict();
export type DaemonContributionRegistryProjectionAutomationEligibleEventV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema
>;

export const DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema = z.array(
  DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
);
export type DaemonContributionRegistryProjectionAutomationEligibleEventsV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema
>;

const ACTIVE_PREDECESSOR_UI_HOST_METHOD_CEILING_V1 = [
  'context',
  'watchContext',
  'executeAction',
  'readResource',
  'statOpenableContent',
  'readOpenableContent',
  'watchResource',
  'openSurface',
  'notify',
  'confirm',
  'diagnostic',
  'readClipboard',
  'writeClipboard',
  'openExternalLink',
] as const;

function isProjectionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasActivePredecessorUiHostMethodCeiling(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === ACTIVE_PREDECESSOR_UI_HOST_METHOD_CEILING_V1.length
    && value.every((method, index) => method === ACTIVE_PREDECESSOR_UI_HOST_METHOD_CEILING_V1[index]);
}

function normalizeActivePredecessorExternalSessionSource(source: unknown): unknown {
  if (!isProjectionRecord(source) || !isProjectionRecord(source.schema)) return source;
  if (!Object.hasOwn(source.schema, 'passthrough') || source.schema.passthrough !== true) return source;
  const { passthrough: _predecessorPassthrough, ...schema } = source.schema;
  return { ...source, schema };
}

function normalizeActivePredecessorProjectedAction(action: unknown): unknown {
  if (!isProjectionRecord(action)) return action;
  if (!Object.hasOwn(action, 'placement') || Object.hasOwn(action, 'placementBindings')) return action;
  const placement = PluginActionPlacementV2Schema.safeParse(action.placement);
  if (!placement.success) return action;
  const { placement: _predecessorPlacement, ...canonicalAction } = action;
  return { ...canonicalAction, placementBindings: [placement.data] };
}

function normalizeActivePredecessorUiDestinationBinding(binding: unknown): unknown {
  if (!isProjectionRecord(binding)) return binding;
  if (
    !Object.hasOwn(binding, 'collisionDomain')
    || !Object.hasOwn(binding, 'collisionKey')
    || !Object.hasOwn(binding, 'methodCeiling')
  ) {
    return binding;
  }
  if (!isProjectionRecord(binding.collisionDomain)
    || !hasExactOwnKeys(binding.collisionDomain, ['container', 'targetKind'])
    || typeof binding.container !== 'string'
    || typeof binding.targetKind !== 'string'
    || binding.collisionDomain.container !== binding.container
    || binding.collisionDomain.targetKind !== binding.targetKind
    || !hasActivePredecessorUiHostMethodCeiling(binding.methodCeiling)) {
    return binding;
  }
  const destination = PluginContributionIdentityV1Schema.safeParse(binding.destination);
  if (!destination.success) return binding;
  const expectedCollisionKey = `${binding.container}\u0000${binding.targetKind}\u0000${buildQualifiedPluginContributionKey(destination.data)}`;
  if (binding.collisionKey !== expectedCollisionKey) return binding;
  const {
    collisionDomain: _predecessorCollisionDomain,
    collisionKey: _predecessorCollisionKey,
    methodCeiling: _predecessorMethodCeiling,
    ...canonicalBinding
  } = binding;
  return canonicalBinding;
}

/**
 * Current mounted daemons can still run the active predecessor snapshot. Its
 * V2 describe response has three redundant projection facts that current
 * readers intentionally removed: source-schema `passthrough: true`, scalar
 * Action `placement`, and the complete former UI binding collision ceiling.
 * Normalize only that observed predecessor tuple at this RPC ingress, then
 * validate the result through the single closed current projection schema.
 * Remove this adapter when supported predecessor daemon snapshots no longer
 * emit these exact fields.
 */
function normalizeActivePredecessorDaemonContributionRegistryProjectionResponse(value: unknown): unknown {
  if (!isProjectionRecord(value) || value.protocolVersion !== 1 || !isProjectionRecord(value.projection)) {
    return value;
  }
  if (value.projection.v !== 2) return value;

  let projection = value.projection;
  if (isProjectionRecord(projection.agentsById)) {
    let normalizedAgentsById: Record<string, unknown> | undefined;
    for (const [agentId, agent] of Object.entries(projection.agentsById)) {
      if (!isProjectionRecord(agent)) continue;
      const externalSessions = agent.externalSessions;
      if (!isProjectionRecord(externalSessions)) continue;
      const originalSources = externalSessions.sources;
      if (!Array.isArray(originalSources)) {
        continue;
      }
      const sources = originalSources.map(normalizeActivePredecessorExternalSessionSource);
      if (sources.every((source, index) => source === originalSources[index])) continue;
      normalizedAgentsById ??= { ...projection.agentsById };
      normalizedAgentsById[agentId] = {
        ...agent,
        externalSessions: { ...externalSessions, sources },
      };
    }
    if (normalizedAgentsById) projection = { ...projection, agentsById: normalizedAgentsById };
  }

  if (isProjectionRecord(projection.actionsById)) {
    let normalizedActionsById: Record<string, unknown> | undefined;
    for (const [actionId, action] of Object.entries(projection.actionsById)) {
      const normalizedAction = normalizeActivePredecessorProjectedAction(action);
      if (normalizedAction === action) continue;
      normalizedActionsById ??= { ...projection.actionsById };
      normalizedActionsById[actionId] = normalizedAction;
    }
    if (normalizedActionsById) projection = { ...projection, actionsById: normalizedActionsById };
  }

  const familiesById = isProjectionRecord(projection.familiesById)
    ? projection.familiesById
    : null;
  const pluginUi = familiesById && isProjectionRecord(familiesById.pluginUi)
    ? familiesById.pluginUi
    : null;
  if (familiesById && pluginUi && isProjectionRecord(pluginUi.entriesById)) {
    let normalizedEntriesById: Record<string, unknown> | undefined;
    for (const [entryId, entry] of Object.entries(pluginUi.entriesById)) {
      if (!isProjectionRecord(entry)) continue;
      const binding = normalizeActivePredecessorUiDestinationBinding(entry.binding);
      if (binding === entry.binding) continue;
      normalizedEntriesById ??= { ...pluginUi.entriesById };
      normalizedEntriesById[entryId] = { ...entry, binding };
    }
    if (normalizedEntriesById) {
      projection = {
        ...projection,
        familiesById: {
          ...familiesById,
          pluginUi: { ...pluginUi, entriesById: normalizedEntriesById },
        },
      };
    }
  }

  return projection === value.projection ? value : { ...value, projection };
}

export const DaemonContributionRegistryProjectionDescribeResponseSchema = z.preprocess(
  normalizeActivePredecessorDaemonContributionRegistryProjectionResponse,
  z.object({
  protocolVersion: z.literal(1),
  projection: z.union([
    DaemonContributionRegistryProjectionV1Schema,
    z.lazy(() => PluginProjectionV2Schema),
  ]),
  /** Present only when the request carried an exact mounted target. */
  targetedContributions: PluginUiTargetedContributionsV1Schema.optional(),
  /**
   * Host-private selected embedded-Surface mounts for that exact target. This
   * never widens the public data-only targeted-contribution handle.
   */
  targetedSurfaceMounts: z.lazy(() => DaemonPluginUiTargetedSurfaceMountsV1Schema).optional(),
  /**
   * Daemon-selected static Composer renderer facts. The UI joins each row to
   * its current live Composer/input/instance facts before producing a mount.
   */
  composerSurfaceCatalog: z.lazy(() => z.array(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema)).optional(),
  /** Current cold Event-automation composer facts, independent of mounted targets. */
  automationEligibleEvents: DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema.optional(),
  }).passthrough(),
);
export type DaemonContributionRegistryProjectionDescribeResponse = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeResponseSchema
>;

/** The one natural Settings record selected by this projection entry. */
export const PluginProjectedSettingsScopeV2Schema = PluginSettingsScopeRefV1Schema;
export type PluginProjectedSettingsScopeV2 = z.infer<
  typeof PluginProjectedSettingsScopeV2Schema
>;

/**
 * Every daemon Settings/Secrets request repeats the selected portable server
 * identity at the receiver boundary. A machine id alone is not an authority:
 * it can be stale or collide across configured servers.
 */
const DaemonPluginSettingsExactTargetSchema = z.object({
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId,
  machineId: z.string().trim().min(1),
}).strict();

export const DaemonPluginSettingsGetRequestSchema = DaemonPluginSettingsExactTargetSchema.extend({
  pluginId: z.string().trim().min(1),
  scope: PluginSettingsScopeRefV1Schema,
}).strict();
export type DaemonPluginSettingsGetRequest = z.infer<
  typeof DaemonPluginSettingsGetRequestSchema
>;

/**
 * Secret removal is a distinct mutation. In particular, `''` is valid setting
 * data and must never acquire deletion semantics from its value alone.
 */
export const DaemonPluginSettingsMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set'),
    // `z.unknown()` alone treats an object key as optional in Zod. A set
    // mutation must carry JSON data explicitly; omission is not deletion.
    value: z.unknown().refine((value) => value !== undefined, {
      message: 'A settings set mutation requires a value.',
    }),
  }).strict(),
  z.object({
    kind: z.literal('delete'),
  }).strict(),
]);
export type DaemonPluginSettingsMutation = z.infer<
  typeof DaemonPluginSettingsMutationSchema
>;

export const DaemonPluginSettingsSetRequestSchema = DaemonPluginSettingsExactTargetSchema.extend({
  pluginId: z.string().trim().min(1),
  scope: PluginSettingsScopeRefV1Schema,
  fieldId: z.string().trim().min(1),
  mutation: DaemonPluginSettingsMutationSchema,
  expectedRevision: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSettingsSetRequest = z.infer<
  typeof DaemonPluginSettingsSetRequestSchema
>;

export const DaemonPluginSettingsSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  pluginId: z.string().trim().min(1),
  scope: PluginSettingsScopeRefV1Schema,
  revision: z.string().trim().min(1),
  values: z.record(z.string(), z.unknown()).default({}),
  redactedKeys: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type DaemonPluginSettingsSnapshot = z.infer<
  typeof DaemonPluginSettingsSnapshotSchema
>;

export const DaemonPluginSettingsGetResponseSchema = DaemonPluginSettingsSnapshotSchema;
export type DaemonPluginSettingsGetResponse = DaemonPluginSettingsSnapshot;

export const DaemonPluginSettingsSetResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    snapshot: DaemonPluginSettingsSnapshotSchema,
  }).strict(),
  z.object({
    status: z.literal('conflict'),
    snapshot: DaemonPluginSettingsSnapshotSchema,
  }).strict(),
]);
export type DaemonPluginSettingsSetResponse = z.infer<
  typeof DaemonPluginSettingsSetResponseSchema
>;

/**
 * A Settings watch is a content-free, exact-daemon invalidation handshake.
 * The client retains only the last revision it observed so this transport can
 * tell it whether its record projection needs one canonical reread; neither
 * Settings values nor field identities ride this watch boundary.
 */
export const DaemonPluginSettingsWatchRequestSchema = DaemonPluginSettingsExactTargetSchema.extend({
  pluginId: z.string().trim().min(1),
  scope: z.object({ kind: z.literal('daemon') }).strict(),
  knownRevision: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSettingsWatchRequest = z.infer<
  typeof DaemonPluginSettingsWatchRequestSchema
>;

export const DaemonPluginSettingsWatchResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), revision: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('changed'), revision: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('idle'), revision: z.string().trim().min(1) }).strict(),
]);
export type DaemonPluginSettingsWatchResponse = z.infer<
  typeof DaemonPluginSettingsWatchResponseSchema
>;

/**
 * Safe exact-machine projection over the current declared Secrets service.
 * The transport deliberately has no Settings scope and no secret-value field:
 * declarations route custody independently of Settings presentation scope.
 */
export const DaemonPluginSecretStatusRequestSchema = DaemonPluginSettingsExactTargetSchema.extend({
  pluginId: z.string().trim().min(1),
  secretId: PluginSettingFieldIdV2Schema,
  /** Exact credential partition when the declaration is origin-bound. */
  canonicalOrigin: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSecretStatusRequest = z.infer<
  typeof DaemonPluginSecretStatusRequestSchema
>;

export const DaemonPluginSecretStatusResponseSchema = z.object({
  protocolVersion: z.literal(1),
  pluginId: z.string().trim().min(1),
  secretId: PluginSettingFieldIdV2Schema,
  state: z.enum(['configured', 'missing', 'denied', 'unavailable']),
  revision: z.string().trim().min(1),
}).strict();
export type DaemonPluginSecretStatusResponse = z.infer<
  typeof DaemonPluginSecretStatusResponseSchema
>;

/** Explicit user-mediated creation/replacement never returns secret material. */
export const DaemonPluginSecretSetRequestSchema = DaemonPluginSecretStatusRequestSchema.extend({
  value: z.string(),
  expectedRevision: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSecretSetRequest = z.infer<
  typeof DaemonPluginSecretSetRequestSchema
>;

export const DaemonPluginSecretSetResponseSchema = DaemonPluginSecretStatusResponseSchema;
export type DaemonPluginSecretSetResponse = DaemonPluginSecretStatusResponse;

/** Deletion is an explicit safe mutation and never returns secret material. */
export const DaemonPluginSecretDeleteRequestSchema = DaemonPluginSecretStatusRequestSchema.extend({
  expectedRevision: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSecretDeleteRequest = z.infer<
  typeof DaemonPluginSecretDeleteRequestSchema
>;

export const DaemonPluginSecretDeleteResponseSchema = DaemonPluginSecretStatusResponseSchema;
export type DaemonPluginSecretDeleteResponse = DaemonPluginSecretStatusResponse;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isCanonicalBase64(value: string): boolean {
  if (!CANONICAL_BASE64_PATTERN.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 0) return true;
  const lastSextet = BASE64_ALPHABET.indexOf(value[value.length - padding - 1] ?? '');
  return padding === 2 ? lastSextet % 16 === 0 : lastSextet % 4 === 0;
}

export const DaemonPluginStructuredMessageActionExecuteResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: PluginJsonValueV2Schema }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
  }).strict(),
]);
export type DaemonPluginStructuredMessageActionExecuteResponse = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteResponseSchema
>;

/**
 * One host-owned form option request. The caller names only a current target
 * Action field; the daemon derives any Connected Account purpose and service
 * scope from that Action's manifest and HostAccess declaration.
 */
export const DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  qualifiedActionId: z.string().trim().min(1),
  fieldPath: ActionInputPathSchema,
}).strict();
export type DaemonPluginActionFormConnectedAccountOptionsResolveRequest = z.infer<
  typeof DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema
>;

/** The form sees one safe display label plus the exact ref it may submit. */
export const DaemonPluginActionFormConnectedAccountOptionSchema = z.object({
  value: QualifiedConnectedAccountRefSchema,
  label: z.string().trim().min(1).max(512),
}).strict();
export type DaemonPluginActionFormConnectedAccountOption = z.infer<
  typeof DaemonPluginActionFormConnectedAccountOptionSchema
>;

export const DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    options: z.array(DaemonPluginActionFormConnectedAccountOptionSchema).max(256),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
  }).strict(),
]);
export type DaemonPluginActionFormConnectedAccountOptionsResolveResponse = z.infer<
  typeof DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema
>;

/**
 * A picker search targets one projection-discovered composer-reference identity. It does
 * not carry a candidate or resolved context: candidate identity alone remains
 * the durable composer input, while resolution happens at reference dispatch.
 */
const DaemonPluginComposerReferenceSearchQueryV1Schema = z.string()
  .superRefine((value, context) => {
    try {
      normalizeComposerReferenceQueryV1(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Composer reference query is invalid.',
      });
    }
  })
  .transform((value) => normalizeComposerReferenceQueryV1(value));

export const DaemonPluginComposerReferenceSearchRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  reference: PluginContributionIdentityV1Schema,
  // Older UI builds could only discover `@` references. Expand their missing
  // trigger at this seam rather than teaching a target runtime to guess.
  trigger: ComposerReferenceTriggerV1Schema.default('@'),
  query: DaemonPluginComposerReferenceSearchQueryV1Schema,
}).strict();
export type DaemonPluginComposerReferenceSearchRequest = z.infer<
  typeof DaemonPluginComposerReferenceSearchRequestSchema
>;

export const DaemonPluginComposerReferenceSearchResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    reference: PluginContributionIdentityV1Schema,
    page: ComposerReferenceCandidatePageV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
    reason: z.enum(['invalid_payload', 'stale_generation', 'unavailable', 'not_current']),
  }).strict(),
]);
export type DaemonPluginComposerReferenceSearchResponse = z.infer<
  typeof DaemonPluginComposerReferenceSearchResponseSchema
>;

export const DaemonPluginReactNativeBundleCacheIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostAppVersion: z.string().trim().min(1),
  hostUiApiVersion: z.string().trim().min(1),
  reactVersion: z.string().trim().min(1),
  reactNativeVersion: z.string().trim().min(1),
  expoRuntimeVersion: z.string().trim().min(1).optional(),
  hermesVersion: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  nativeCapabilitiesDigest: PluginUiArtifactDigestV1Schema,
  projectionGeneration: z.number().int().nonnegative(),
}).strict();
export type DaemonPluginReactNativeBundleCacheIdentityV1 = z.infer<
  typeof DaemonPluginReactNativeBundleCacheIdentityV1Schema
>;

/** Stable process-local key for one exact daemon-issued RN compatibility identity. */
export function deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(
  identity: DaemonPluginReactNativeBundleCacheIdentityV1,
): string {
  return [
    identity.pluginId,
    identity.contributionId,
    identity.artifactDigest,
    identity.hostAppVersion,
    identity.hostUiApiVersion,
    identity.reactVersion,
    identity.reactNativeVersion,
    identity.expoRuntimeVersion ?? '',
    identity.hermesVersion ?? '',
    identity.platform,
    identity.channel,
    identity.nativeCapabilitiesDigest,
    String(identity.projectionGeneration),
  ].join(':');
}

/**
 * Exact daemon-read correlation for one generated hosted-web renderer. This
 * is a live projection/currentness gate only: persistent Artifact bytes stay
 * keyed by their release slot and immutable digest, never by this generation.
 */
export const DaemonPluginHostedWebArtifactCacheIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  platform: z.literal('web'),
  projectionGeneration: z.number().int().nonnegative(),
}).strict();
export type DaemonPluginHostedWebArtifactCacheIdentityV1 = z.infer<
  typeof DaemonPluginHostedWebArtifactCacheIdentityV1Schema
>;

export const DaemonPluginUiArtifactBytesCacheIdentityV1Schema = z.union([
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
]);
export type DaemonPluginUiArtifactBytesCacheIdentityV1 = z.infer<
  typeof DaemonPluginUiArtifactBytesCacheIdentityV1Schema
>;

export const DaemonPluginUiArtifactBytesFamilyV1Schema = z.enum([
  'reactNative',
  'hostedWeb',
]);
export type DaemonPluginUiArtifactBytesFamilyV1 = z.infer<
  typeof DaemonPluginUiArtifactBytesFamilyV1Schema
>;

/**
 * The generated contribution family that canonically owns a React Native
 * Artifact read. Renderer, Voice provider, and host-private candidate
 * Collection migration reads have distinct lifecycle contracts, so this
 * discriminator is part of the byte-read ABI rather than an optional client
 * hint.
 */
export const DaemonPluginReactNativeArtifactOwnerKindV1Schema = z.enum([
  'renderer',
  'voiceProvider',
  'collectionMigrations',
  'clientContribution',
]);
export type DaemonPluginReactNativeArtifactOwnerKindV1 = z.infer<
  typeof DaemonPluginReactNativeArtifactOwnerKindV1Schema
>;

/**
 * The exact daemon-owned identity of one admitted embedded Surface mount.
 * The public targeted-contribution handle intentionally omits this mount's
 * input schema, renderer facts, execution origin, and Resource capability.
 */
export const DaemonPluginUiTargetedSurfaceMountIdentityV1Schema = z.object({
  target: z.object({
    pluginId: PluginIdSchema,
    immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
  }).strict(),
  point: z.object({
    pointId: PluginContributionLocalIdSchema,
    protocol: asProtocolZod(PluginUiTargetedContributionProtocolV1Schema),
  }).strict(),
  contributor: z.object({
    pluginId: PluginIdSchema,
    contributionId: PluginContributionLocalIdSchema,
    immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
  }).strict(),
  kind: z.literal('targetedSurface'),
  role: PluginContributionLocalIdSchema,
  presentation: PluginUiTargetedContributionSurfacePresentationV1Schema,
}).strict();
export type DaemonPluginUiTargetedSurfaceMountIdentityV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceMountIdentityV1Schema
>;

/**
 * The durable crash containment mount. Destination, targeted Surface, and
 * Composer Surface mounts share one token shape but never share a key. Each
 * arm carries the exact admission/currentness facts selected by its own mount
 * owner; a Composer arm never impersonates a targeted contribution.
 */
export const DaemonPluginReactNativeCrashMountV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('destination'),
    destination: PluginContributionIdentityV1Schema,
  }).strict(),
  DaemonPluginUiTargetedSurfaceMountIdentityV1Schema,
  z.object({
    kind: z.literal('composer'),
    contribution: PluginContributionIdentityV1Schema,
    immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
    role: ComposerSurfaceRoleV1Schema,
  }).strict(),
]);
export type DaemonPluginReactNativeCrashMountV1 = z.infer<
  typeof DaemonPluginReactNativeCrashMountV1Schema
>;

export const DaemonPluginReactNativeCrashBindingTokenV1Schema = z.object({
  mount: DaemonPluginReactNativeCrashMountV1Schema,
  renderer: PluginContributionIdentityV1Schema,
  artifactDigest: PluginUiArtifactDigestV1Schema,
  crashStateEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type DaemonPluginReactNativeCrashBindingTokenV1 = z.infer<
  typeof DaemonPluginReactNativeCrashBindingTokenV1Schema
>;

/**
 * The one stable serialization of a daemon-selected React Native crash mount.
 * Both comparators below and every consumer that needs a mount-scoped key
 * derive from this, so a new mount member cannot be honoured by one owner and
 * silently ignored by another.
 */
export function deriveDaemonPluginReactNativeCrashMountKeyV1(
  mount: DaemonPluginReactNativeCrashMountV1,
): string {
  switch (mount.kind) {
    case 'destination':
      return [
        'destination',
        mount.destination.pluginId,
        mount.destination.localId,
      ].join('\u0000');
    case 'targetedSurface':
      return [
        'targetedSurface',
        mount.target.pluginId,
        mount.target.immutableGenerationId,
        mount.point.pointId,
        mount.point.protocol.id,
        String(mount.point.protocol.version),
        mount.contributor.pluginId,
        mount.contributor.contributionId,
        mount.contributor.immutableGenerationId,
        mount.role,
        mount.presentation,
      ].join('\u0000');
    case 'composer':
      return [
        'composer',
        mount.contribution.pluginId,
        mount.contribution.localId,
        mount.immutableGenerationId,
        mount.role,
      ].join('\u0000');
  }
}

/**
 * Stable key for the daemon-selected binding, excluding the artifact and crash
 * epoch. Local pending failures use this only to discard a superseded token;
 * callers that need exact currentness must use the token key below.
 */
export function deriveDaemonPluginReactNativeCrashBindingKeyV1(
  token: DaemonPluginReactNativeCrashBindingTokenV1,
): string {
  return [
    deriveDaemonPluginReactNativeCrashMountKeyV1(token.mount),
    token.renderer.pluginId,
    token.renderer.localId,
  ].join('\u0000');
}

/**
 * Stable key for exact daemon-owned React Native crash-state currentness. A
 * consumer that needs a lifecycle/dependency key composes this with its own
 * local scope rather than re-expanding the mount union.
 */
export function deriveDaemonPluginReactNativeCrashBindingTokenKeyV1(
  token: DaemonPluginReactNativeCrashBindingTokenV1,
): string {
  return [
    deriveDaemonPluginReactNativeCrashBindingKeyV1(token),
    token.artifactDigest,
    String(token.crashStateEpoch),
  ].join('\u0000');
}

/**
 * Same daemon-selected React Native binding, excluding the artifact and crash
 * epoch. Local pending failures use this only to discard a superseded token;
 * callers that need exact currentness must use the token comparator below.
 */
export function isSameDaemonPluginReactNativeCrashBindingV1(
  left: DaemonPluginReactNativeCrashBindingTokenV1,
  right: DaemonPluginReactNativeCrashBindingTokenV1,
): boolean {
  return deriveDaemonPluginReactNativeCrashBindingKeyV1(left)
    === deriveDaemonPluginReactNativeCrashBindingKeyV1(right);
}

/**
 * Exact daemon-owned React Native crash-state currentness. Every consumer of
 * a token must use this closed comparison rather than reimplementing a subset
 * of its mount union.
 */
export function isSameDaemonPluginReactNativeCrashBindingTokenV1(
  left: DaemonPluginReactNativeCrashBindingTokenV1,
  right: DaemonPluginReactNativeCrashBindingTokenV1,
): boolean {
  return deriveDaemonPluginReactNativeCrashBindingTokenKeyV1(left)
    === deriveDaemonPluginReactNativeCrashBindingTokenKeyV1(right);
}

export const DaemonPluginReactNativeCrashStateV1Schema = z.object({
  token: DaemonPluginReactNativeCrashBindingTokenV1Schema,
  disabled: z.boolean(),
}).strict();
export type DaemonPluginReactNativeCrashStateV1 = z.infer<
  typeof DaemonPluginReactNativeCrashStateV1Schema
>;

export const DaemonPluginUiArtifactFileBytesV1Schema = z.object({
  relativePath: z.string().trim().min(1),
  digest: PluginUiArtifactDigestV1Schema,
  byteSize: z.number().int().nonnegative(),
  bytesBase64: z.string().trim().min(1),
}).strict();
export type DaemonPluginUiArtifactFileBytesV1 = z.infer<
  typeof DaemonPluginUiArtifactFileBytesV1Schema
>;

const DaemonPluginReactNativeArtifactBytesReadRequestBaseShape = {
  artifactFamily: z.literal('reactNative'),
  machineId: z.string().trim().min(1),
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  reactNativeWebLoaderCapability: DaemonReactNativeWebLoaderCapabilityV1Schema.optional(),
};

/**
 * A generic client executable is authorized by the selected projected Action,
 * not by a renderer or Voice provider that happens to share its bundle. The
 * exact Action identity is echoed on success so the client cannot adopt bytes
 * for another Action with the same Artifact owner kind.
 */
const DaemonPluginReactNativeClientContributionIdentityV1Schema = z.object({
  family: z.literal('actions'),
  action: PluginContributionIdentityV1Schema,
}).strict();

const DaemonPluginReactNativeRendererArtifactBytesReadRequestSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadRequestBaseShape,
  artifactOwnerKind: z.literal('renderer'),
  crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1Schema,
}).strict()
  .refine(
    (value) => value.cacheIdentity.artifactDigest === value.crashStateToken.artifactDigest,
    { message: 'React Native artifact reads must carry the matching crash-state artifact digest' },
  )
  .refine(
    (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
    { message: 'native runtime identity and web loader capability are mutually exclusive' },
  );

const DaemonPluginReactNativeVoiceProviderArtifactBytesReadRequestSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadRequestBaseShape,
  artifactOwnerKind: z.literal('voiceProvider'),
}).strict()
  .refine(
    (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
    { message: 'native runtime identity and web loader capability are mutually exclusive' },
  );

/**
 * Exact candidate code is not a renderer mount and must not borrow renderer
 * crash authority. The host-private migration consumer receives the same
 * immutable Artifact graph, with no callback, activation, or public byte-read
 * capability on this wire arm.
 */
const DaemonPluginReactNativeCollectionMigrationsArtifactBytesReadRequestSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadRequestBaseShape,
  artifactOwnerKind: z.literal('collectionMigrations'),
}).strict()
  .refine(
    (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
    { message: 'native runtime identity and web loader capability are mutually exclusive' },
  );

const DaemonPluginReactNativeClientContributionArtifactBytesReadRequestSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadRequestBaseShape,
  artifactOwnerKind: z.literal('clientContribution'),
  clientContribution: DaemonPluginReactNativeClientContributionIdentityV1Schema,
}).strict()
  .refine(
    (value) => (
      value.cacheIdentity.pluginId === value.clientContribution.action.pluginId
      && value.cacheIdentity.contributionId === value.clientContribution.action.localId
    ),
    { message: 'Client contribution Artifact reads must use the exact Action cache identity.' },
  )
  .refine(
    (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
    { message: 'native runtime identity and web loader capability are mutually exclusive' },
  );

const DaemonPluginHostedWebArtifactBytesReadRequestSchema = z.object({
  artifactFamily: z.literal('hostedWeb'),
  machineId: z.string().trim().min(1),
  cacheIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
}).strict();

/**
 * One exact daemon byte-read route with closed Artifact-family and generated-
 * owner discriminators. A caller cannot pass React Native runtime facts for
 * hosted assets, and the daemon cannot reinterpret either Artifact family, a
 * Voice lifecycle, or host-private candidate migration code as a renderer
 * lifecycle.
 */
export const DaemonPluginUiArtifactBytesReadRequestSchema = z.union([
  DaemonPluginReactNativeRendererArtifactBytesReadRequestSchema,
  DaemonPluginReactNativeVoiceProviderArtifactBytesReadRequestSchema,
  DaemonPluginReactNativeCollectionMigrationsArtifactBytesReadRequestSchema,
  DaemonPluginReactNativeClientContributionArtifactBytesReadRequestSchema,
  DaemonPluginHostedWebArtifactBytesReadRequestSchema,
]);
export type DaemonPluginUiArtifactBytesReadRequest = z.infer<
  typeof DaemonPluginUiArtifactBytesReadRequestSchema
>;

const DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape = {
  ok: z.literal(true),
  artifactFamily: z.literal('reactNative'),
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  artifact: z.object({
    pluginId: z.string().trim().min(1),
    contributionId: z.string().trim().min(1),
    artifactKind: z.literal('reactNativeBundle'),
    digest: PluginUiArtifactDigestV1Schema,
    format: z.literal('plainJs'),
    byteSize: z.number().int().nonnegative(),
  }).strict(),
  bytesBase64: z.string().trim().min(1),
  files: z.array(DaemonPluginUiArtifactFileBytesV1Schema).min(1).optional(),
};

const DaemonPluginReactNativeRendererArtifactBytesReadSuccessSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape,
  artifactOwnerKind: z.literal('renderer'),
  crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1Schema,
}).strict();

const DaemonPluginReactNativeVoiceProviderArtifactBytesReadSuccessSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape,
  artifactOwnerKind: z.literal('voiceProvider'),
}).strict();

const DaemonPluginReactNativeCollectionMigrationsArtifactBytesReadSuccessSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape,
  artifactOwnerKind: z.literal('collectionMigrations'),
}).strict();

const DaemonPluginReactNativeClientContributionArtifactBytesReadSuccessSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape,
  artifactOwnerKind: z.literal('clientContribution'),
  clientContribution: DaemonPluginReactNativeClientContributionIdentityV1Schema,
}).strict().refine(
  (value) => (
    value.cacheIdentity.pluginId === value.clientContribution.action.pluginId
    && value.cacheIdentity.contributionId === value.clientContribution.action.localId
  ),
  { message: 'Client contribution Artifact bytes must echo their exact Action cache identity.' },
);

const DaemonPluginHostedWebArtifactBytesReadSuccessSchema = z.object({
  ok: z.literal(true),
  artifactFamily: z.literal('hostedWeb'),
  cacheIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
  artifact: z.object({
    pluginId: z.string().trim().min(1),
    contributionId: z.string().trim().min(1),
    artifactKind: z.literal('hostedWebAsset'),
    digest: PluginUiArtifactDigestV1Schema,
    byteSize: z.number().int().nonnegative(),
  }).strict(),
  bytesBase64: z.string().trim().min(1),
  files: z.array(DaemonPluginUiArtifactFileBytesV1Schema).min(1).optional(),
}).strict();

export const DaemonPluginUiArtifactBytesReadResponseSchema = z.union([
  DaemonPluginReactNativeRendererArtifactBytesReadSuccessSchema,
  DaemonPluginReactNativeVoiceProviderArtifactBytesReadSuccessSchema,
  DaemonPluginReactNativeCollectionMigrationsArtifactBytesReadSuccessSchema,
  DaemonPluginReactNativeClientContributionArtifactBytesReadSuccessSchema,
  DaemonPluginHostedWebArtifactBytesReadSuccessSchema,
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'invalid_request',
      'crash_state_token_mismatch',
      'artifact_not_found',
      'artifact_unavailable',
      'artifact_read_failed',
      'artifact_integrity_failed',
      'unsupported_artifact_format',
    ]),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
]);
export type DaemonPluginUiArtifactBytesReadResponse = z.infer<
  typeof DaemonPluginUiArtifactBytesReadResponseSchema
>;

/**
 * Read one declared plugin resource for a mounted plugin UI surface (§3.6).
 *
 * `readResource` is the single snapshot authority for plugin UI: it returns the
 * admitted generation's verified bytes, and no subscription ever carries a
 * payload. A **packaged** resource is immutable within its generation, so this
 * request has no watch counterpart.
 *
 * The reference is caller-scoped. `callerPluginId` is host-stamped from the
 * mounted surface, never author-supplied, and the daemon binds the resource
 * service to it, so a structured reference naming another plugin is rejected
 * through the existing `plugin_resource_not_found` taxonomy rather than being
 * policed only on the UI side.
 */
export const DaemonPluginUiResourceReadRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  callerPluginId: z.string().trim().min(1),
  resource: z.object({
    pluginId: z.string().trim().min(1),
    localId: z.string().trim().min(1),
  }).strict(),
  /** Omission reaches the Resource owner, which rejects a required context typed. */
  context: PluginResourceContextV1Schema.optional(),
}).strict();
export type DaemonPluginUiResourceReadRequest = z.infer<
  typeof DaemonPluginUiResourceReadRequestSchema
>;

export const DaemonPluginUiResourceReadResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    resource: z.object({
      pluginId: z.string().trim().min(1),
      localId: z.string().trim().min(1),
    }).strict(),
    kind: PluginResourceKindV2Schema,
    contentType: z.string().trim().min(1),
    digest: PluginUiArtifactDigestV1Schema,
    bytesBase64: z.string().refine(isCanonicalBase64),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
    reason: z.enum(['invalid_payload', 'stale_generation', 'not_found', 'unavailable']),
  }).strict(),
]);
export type DaemonPluginUiResourceReadResponse = z.infer<
  typeof DaemonPluginUiResourceReadResponseSchema
>;

/**
 * Live resource invalidation transport for a mounted plugin UI surface
 * (§3.6, EU-4b).
 *
 * The app owns the connection: it opens one subscription, long-polls `next`,
 * and closes. There is no daemon-initiated push, no second socket and no
 * `apps/server` change — the forward machine RPC channel the snapshot read
 * already uses carries all three calls, exactly as the managed-service endpoint
 * read triple does for its stream.
 *
 * `next` never carries resource bytes. The event is the canonical bounded
 * invalidation signal (`PluginUiResourceSubscriptionEventV1`) and the observer
 * re-reads through `daemon.plugins.ui.resources.read`, which stays the single
 * snapshot authority.
 *
 * `open` answers with the digest the daemon currently observes, so a late
 * mount, a reconnect or a replaced daemon-side subscription converges on
 * last-known-good plus one re-read instead of a silent stale view.
 */
export const DaemonPluginUiResourceWatchOpenRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  callerPluginId: z.string().trim().min(1),
  subscriptionId: z.string().trim().min(1).max(256),
  resource: z.object({
    pluginId: z.string().trim().min(1),
    localId: z.string().trim().min(1),
  }).strict(),
  /** The watch owns this exact contextual binding until it is closed or retired. */
  context: PluginResourceContextV1Schema.optional(),
}).strict();
export type DaemonPluginUiResourceWatchOpenRequest = z.infer<
  typeof DaemonPluginUiResourceWatchOpenRequestSchema
>;

const DaemonPluginUiResourceWatchFailureSchema = z.object({
  ok: z.literal(false),
  code: z.string().trim().min(1),
  reason: z.enum([
    'invalid_payload',
    'stale_generation',
    'not_found',
    'unknown_subscription',
    'unavailable',
  ]),
}).strict();

export const DaemonPluginUiResourceWatchOpenResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    subscriptionId: z.string().trim().min(1).max(256),
    digest: PluginUiArtifactDigestV1Schema,
  }).strict(),
  DaemonPluginUiResourceWatchFailureSchema,
]);
export type DaemonPluginUiResourceWatchOpenResponse = z.infer<
  typeof DaemonPluginUiResourceWatchOpenResponseSchema
>;

/**
 * The long-poll budget the caller asks the daemon to park for. It is bounded on
 * both ends so a client cannot pin a daemon handler open indefinitely and a
 * degenerate value cannot turn the poll into a busy loop.
 */
export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS = 1_000;
export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS = 60_000;
export const DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS = 25_000;

export const DaemonPluginUiResourceWatchNextRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  callerPluginId: z.string().trim().min(1),
  subscriptionId: z.string().trim().min(1).max(256),
  waitMs: z.number().int()
    .min(DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS)
    .max(DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS)
    .optional(),
}).strict();
export type DaemonPluginUiResourceWatchNextRequest = z.infer<
  typeof DaemonPluginUiResourceWatchNextRequestSchema
>;

export const DaemonPluginUiResourceWatchNextResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('event'),
    event: PluginUiResourceSubscriptionEventV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    status: z.literal('idle'),
  }).strict(),
  DaemonPluginUiResourceWatchFailureSchema,
]);
export type DaemonPluginUiResourceWatchNextResponse = z.infer<
  typeof DaemonPluginUiResourceWatchNextResponseSchema
>;

export const DaemonPluginUiResourceWatchCloseRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  callerPluginId: z.string().trim().min(1),
  subscriptionId: z.string().trim().min(1).max(256),
}).strict();
export type DaemonPluginUiResourceWatchCloseRequest = z.infer<
  typeof DaemonPluginUiResourceWatchCloseRequestSchema
>;

export const DaemonPluginUiResourceWatchCloseResponseSchema = z.object({
  ok: z.literal(true),
  closed: z.boolean(),
}).strict();
export type DaemonPluginUiResourceWatchCloseResponse = z.infer<
  typeof DaemonPluginUiResourceWatchCloseResponseSchema
>;

export const DaemonPluginReactNativeCrashFailureV1Schema = z.enum([
  'render_error',
  'load_timeout',
  'invalid_surface_module',
  'load_error',
]);
export type DaemonPluginReactNativeCrashFailureV1 = z.infer<
  typeof DaemonPluginReactNativeCrashFailureV1Schema
>;

export const DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema = z.string()
  .uuid()
  .refine(
    (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    { message: 'React Native crash failure occurrence IDs must be UUIDv4 values' },
  );
export type DaemonPluginReactNativeCrashFailureOccurrenceIdV1 = z.infer<
  typeof DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema
>;

export const DaemonPluginReactNativeCrashReportV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reportFailure'),
    token: DaemonPluginReactNativeCrashBindingTokenV1Schema,
    failureOccurrenceId: DaemonPluginReactNativeCrashFailureOccurrenceIdV1Schema,
    failure: DaemonPluginReactNativeCrashFailureV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('reset'),
    token: DaemonPluginReactNativeCrashBindingTokenV1Schema,
  }).strict(),
]);
export type DaemonPluginReactNativeCrashReportV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportV1Schema
>;

export const DaemonPluginReactNativeCrashReportRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
  machineId: z.string().trim().min(1),
  report: DaemonPluginReactNativeCrashReportV1Schema,
}).strict();
export type DaemonPluginReactNativeCrashReportRequestV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportRequestV1Schema
>;

export const DaemonPluginReactNativeCrashReportResponseV1Schema = z.union([
  z.object({
    protocolVersion: z.literal(1),
    ok: z.literal(true),
    token: DaemonPluginReactNativeCrashBindingTokenV1Schema,
    disabled: z.boolean(),
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    ok: z.literal(false),
    code: z.enum([
      'invalid_request',
      'binding_token_mismatch',
      'failure_occurrence_conflict',
      'state_write_failed',
    ]),
    diagnostics: z.array(z.string().trim().min(1).max(256)).max(16).default([]),
  }).strict(),
]);
export type DaemonPluginReactNativeCrashReportResponseV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportResponseV1Schema
>;

export const PluginProjectionSourceV2Schema = z.object({
  kind: z.string().trim().min(1),
  locator: z.string().trim().min(1),
}).strict();
export type PluginProjectionSourceV2 = z.infer<typeof PluginProjectionSourceV2Schema>;

/**
 * The one catalog-facing fact for an optional portable plugin brand mark.
 *
 * It deliberately exposes the already-admitted Resource identity, dimensions,
 * and digest—not a path, URL, byte handle, or cache key. Consumers render a
 * neutral textual fallback for every non-available state.
 */
export const PluginProjectionBrandAssetV2Schema = z.union([
  z.object({
    state: z.literal('available'),
    resource: PluginContributionIdentityV1Schema,
    width: z.number().int().min(64).max(512),
    height: z.number().int().min(64).max(512),
    digest: PluginUiArtifactDigestV1Schema,
  }).strict().refine((value) => value.width === value.height, {
    message: 'A plugin brand asset must be square',
  }),
  z.object({
    state: z.enum(['missing', 'invalid', 'retired']),
  }).strict(),
]);
export type PluginProjectionBrandAssetV2 = z.infer<typeof PluginProjectionBrandAssetV2Schema>;

export const PluginProjectionInstalledPackageV2Schema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  version: PluginOptionalStringSchema,
  enabled: z.boolean(),
  source: PluginProjectionSourceV2Schema,
  // Present only for a projection built from the committed runtime registry.
  // Metadata-only package rows legitimately have no current immutable generation.
  immutableGenerationId: z.string().trim().min(1).optional(),
  brand: PluginProjectionBrandAssetV2Schema.optional(),
}).strict();
export type PluginProjectionInstalledPackageV2 = z.infer<typeof PluginProjectionInstalledPackageV2Schema>;

export const PluginProjectedContributionBaseV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
});
export type PluginProjectedContributionBaseV2 = z.infer<typeof PluginProjectedContributionBaseV2Schema>;

const PluginProjectedProviderOwnedEnvironmentKeysV2Schema = z.array(
  z.string().min(1).max(256).regex(/^[A-Z_][A-Z0-9_]*$/u),
).max(64).superRefine((keys, ctx) => {
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: 'custom', message: 'Provider-owned environment keys must be unique' });
  }
});

export const PluginProjectedAgentExternalSessionsOperationsV2Schema = z.object({
  listCandidates: z.boolean(),
  resolveLinkIdentity: z.boolean(),
  pageTranscript: z.boolean(),
  readAfterTranscript: z.boolean(),
}).strict();
export type PluginProjectedAgentExternalSessionsOperationsV2 = z.infer<
  typeof PluginProjectedAgentExternalSessionsOperationsV2Schema
>;

export const PluginProjectedAgentExternalSessionsV2Schema = z.object({
  agent: PluginContributionIdentityV1Schema,
  generation: z.number().int().nonnegative(),
  operations: PluginProjectedAgentExternalSessionsOperationsV2Schema,
  sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema).min(1),
}).strict();
export type PluginProjectedAgentExternalSessionsV2 = z.infer<
  typeof PluginProjectedAgentExternalSessionsV2Schema
>;

const PluginProjectedAgentConnectedServiceIdsV2Schema = z.array(
  ConnectedServiceIdSchema,
).max(ConnectedServiceIdSchema.options.length).superRefine((serviceIds, ctx) => {
  if (new Set(serviceIds).size !== serviceIds.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Projected Agent Connected Service ids must be unique',
    });
  }
});

export const PluginProjectedAgentV2Schema = z.object({
  id: z.string().trim().min(1),
  identity: PluginContributionIdentityV1Schema.optional(),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  connectedServiceIds: PluginProjectedAgentConnectedServiceIdsV2Schema.optional(),
  providerOwnedEnvironmentKeys: PluginProjectedProviderOwnedEnvironmentKeysV2Schema.default([]),
  capabilities: PluginAgentCapabilitiesV2Schema.optional(),
  cli: PluginAgentCliMetadataSchema.optional(),
  externalSessions: PluginProjectedAgentExternalSessionsV2Schema.optional(),
  /**
   * The Agent's own client UI-behavior declaration, carried verbatim. This is
   * the runtime channel an installed Agent uses to reach the client's single
   * fail-closed descriptor interpreter; absent it, the client has only its
   * build-time bundled projection and degrades the Agent to neutral behavior.
   *
   * Carried structurally, not re-validated: the strict public grammar is the
   * authoring contract, and re-applying it here would let one unreadable field
   * remove the whole Agent from the catalog instead of refusing that one
   * declaration.
   */
  ui: AgentUiProjectedDeclarationV1Schema.optional(),
}).strict();
export type PluginProjectedAgentV2 = z.infer<typeof PluginProjectedAgentV2Schema>;

export const PluginProjectedBackendV2Schema = z.object({
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  capabilities: PluginBackendCapabilitiesV1Schema,
}).strict();
export type PluginProjectedBackendV2 = z.infer<typeof PluginProjectedBackendV2Schema>;

/**
 * Action presentation is the one projected contribution surface that retains
 * plugin localization descriptors. Existing string projections remain valid,
 * while UI presentation resolves these values through the projected plugin
 * translation bundle rather than the daemon's execution normalization.
 */
const PluginProjectedActionInputHintsSchemasV2 = createActionInputHintsSchemas(
  PluginLocalizedStringV2Schema,
  ActionInputOptionValueSchema,
);
export const PluginProjectedActionInputHintsV2Schema =
  PluginProjectedActionInputHintsSchemasV2.hintsSchema;
export type PluginProjectedActionInputHintsV2 = z.infer<
  typeof PluginProjectedActionInputHintsV2Schema
>;

export const PluginProjectedActionV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  title: PluginLocalizedStringV2Schema,
  // Older projection writers emitted `null` for an omitted description.
  description: PluginLocalizedStringV2Schema.nullable().optional(),
  icon: PluginActionIconV2Schema.optional(),
  scopes: z.array(PluginActionScopeV2Schema).min(1),
  surfaces: z.array(PluginActionSurfaceV2Schema).min(1),
  execution: PluginActionExecutionV2Schema,
  operation: ActionOperationDeclarationV1Schema.optional(),
  // The Action projection retains the producer-owned exact origin used by
  // client projection admission. Consumers must not derive this from a
  // package/member identity or replace it with a coarser machine fact.
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId.optional(),
  materializationRef: PluginMachineExecutionOriginV1Schema.shape.materializationRef.optional(),
  placementBindings: PluginActionPlacementBindingsV2Schema.optional(),
  slash: PluginActionSlashV2Schema.optional(),
  inputSchema: PluginJsonSchemaV2Schema.optional(),
  outputSchema: PluginJsonSchemaV2Schema.optional(),
  inputHints: PluginProjectedActionInputHintsV2Schema.optional(),
  priority: z.number().int().optional(),
  dangerLevel: PluginActionDangerLevelV2Schema,
  confirmation: PluginActionConfirmationV2Schema.optional(),
  available: z.boolean().optional(),
  /**
   * Read-only canonical Action policy facts. This additive field is absent
   * when the daemon cannot resolve a current final-policy authority.
   */
  authorization: PluginActionPresentUserAuthorizationFactsSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasServerIdentity = value.serverIdentityId !== undefined;
  const hasMaterializationRef = value.materializationRef !== undefined;
  if (hasServerIdentity !== hasMaterializationRef) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasServerIdentity ? ['materializationRef'] : ['serverIdentityId'],
      message: 'Projected Action execution origin must include both serverIdentityId and materializationRef.',
    });
  } else if (
    hasMaterializationRef
    && value.materializationRef!.pluginId !== value.pluginId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['materializationRef', 'pluginId'],
      message: 'Projected Action execution origin must match the Action pluginId.',
    });
  }
  if (pluginActionRequiresPlacement(value.surfaces) && !value.placementBindings) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['placementBindings'],
      message: 'UI projected actions must carry their declared placement bindings.',
    });
  }
  if (value.operation && value.execution.target !== 'daemon') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operation'],
      message: 'Tracked operations require daemon Action execution.',
    });
  }
  if (value.slash && !value.surfaces.includes('ui')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['slash'],
      message: 'Projected composer slash metadata requires the UI Action surface.',
    });
  }
  if (value.dangerLevel === 'safe' && value.confirmation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmation'],
      message: 'Safe projected actions cannot request confirmation.',
    });
    return;
  }
  if (!pluginActionRequiresConfirmationPresentation(value.surfaces, value.dangerLevel) || value.confirmation) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['confirmation'],
    message: 'Non-safe projected actions must carry host confirmation presentation metadata.',
  });
});
export type PluginProjectedActionV2 = z.infer<typeof PluginProjectedActionV2Schema>;

export const PluginProjectedToolV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  exposesToAgent: z.boolean().default(false),
}).strict();
export type PluginProjectedToolV2 = z.infer<typeof PluginProjectedToolV2Schema>;

export const PluginProjectedCommandSurfaceV2Schema = z.enum(['cli', 'agentSlash', 'commandPalette']);
export type PluginProjectedCommandSurfaceV2 = z.infer<typeof PluginProjectedCommandSurfaceV2Schema>;

export const PluginProjectedCommandV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  surfaces: z.array(PluginProjectedCommandSurfaceV2Schema).min(1),
  tokens: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginProjectedCommandV2 = z.infer<typeof PluginProjectedCommandV2Schema>;

export const PluginProjectedResourceV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  resourceKind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).strict();
export type PluginProjectedResourceV2 = z.infer<typeof PluginProjectedResourceV2Schema>;

/**
 * The only Resource fact a selected plugin UI surface may receive from the
 * daemon projection. It intentionally excludes resource identities, counts,
 * origin, and generation; those remain owned by the selected binding and the
 * canonical Resource service.
 */
export const PluginUiResourceBindingCapabilityV1Schema = z.object({
  readable: z.boolean(),
  dynamic: z.boolean(),
}).strict();
export type PluginUiResourceBindingCapabilityV1 =
  z.infer<typeof PluginUiResourceBindingCapabilityV1Schema>;

export const PluginProjectedSettingsFieldV2Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.literal('settings.field'),
  version: z.string().trim().min(1),
  valueSchema: PluginSettingFieldSchemaV2Schema,
  valueType: z.enum(['string', 'boolean', 'number', 'integer', 'object', 'array', 'null']),
  control: z.enum([
    'auto',
    'text',
    'password',
    'textarea',
    'switch',
    'select',
    'multiSelect',
    'number',
    'json',
  ]),
  /** The declared secret owner; independent from the enclosing Settings scope. */
  secretCustody: PluginSecretCustodyV1Schema.nullable(),
  /** Origin relation metadata; it is not a secret value or a second owner. */
  managedServiceOrigin: PluginSettingManagedServiceOriginV1Schema.optional(),
  displayKey: z.string().trim().min(1),
  descriptionKey: PluginOptionalStringSchema,
  presentation: PluginSettingFieldPresentationV2Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  analytics: PluginSettingAnalyticsV2Schema.optional(),
  groupId: PluginOptionalStringSchema.nullable().optional(),
  order: z.number().int().optional(),
  capabilityGates: z.array(z.string().trim().min(1)).default([]),
  permissionGates: z.array(z.string().trim().min(1)).default([]),
  redaction: PluginDescriptorRedactionV1Schema.default('none'),
  clearWhenEmpty: PluginDescriptorClearWhenEmptyV1Schema.default('persist'),
  defaultBooleanValue: z.boolean().optional(),
  defaultValue: PluginJsonValueV2Schema.optional(),
}).strict();
export type PluginProjectedSettingsFieldV2 = z.infer<typeof PluginProjectedSettingsFieldV2Schema>;

export const PluginProjectedSettingsV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  version: z.literal(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  scope: PluginProjectedSettingsScopeV2Schema,
  presentation: PluginSettingsPresentationV2Schema,
  target: z.union([
    z.object({ kind: z.literal('plugin') }).strict(),
    z.object({
      kind: z.literal('agent'),
      agent: z.object({
        pluginId: z.string().trim().min(1),
        localId: z.string().trim().min(1),
      }).strict(),
    }).strict(),
  ]),
  fields: z.array(PluginProjectedSettingsFieldV2Schema).default([]),
}).strict();
export type PluginProjectedSettingsV2 = z.infer<typeof PluginProjectedSettingsV2Schema>;

type ProjectedSettingsValueType = NonNullable<PluginProjectedSettingsFieldV2['valueSchema']['type']>;

const ALL_PROJECTED_SETTINGS_VALUE_TYPES: readonly ProjectedSettingsValueType[] = [
  'null',
  'boolean',
  'number',
  'integer',
  'string',
  'array',
  'object',
];

/**
 * A normalized Settings declaration is still declarative input. This pure
 * projection gives every runtime/host consumer the same editable Settings
 * semantics without electing a persistence or execution owner.
 */
export class PluginSettingsProjectionError extends Error {
  readonly code = 'PLUGIN_SETTINGS_PROJECTION_INVALID' as const;

  constructor(
    message: string,
    readonly pluginId: string,
    readonly contributionId: string,
    readonly fieldId: string | null,
  ) {
    super(message);
    this.name = 'PluginSettingsProjectionError';
  }
}

function invalidSettingsProjection(params: Readonly<{
  pluginId: string;
  contributionId: string;
  fieldId?: string | null;
  reason: string;
}>): PluginSettingsProjectionError {
  const fieldContext = params.fieldId ? ` field '${params.fieldId}'` : '';
  return new PluginSettingsProjectionError(
    `Cannot project settings contribution '${params.pluginId}/${params.contributionId}'${fieldContext}: ${params.reason}`,
    params.pluginId,
    params.contributionId,
    params.fieldId ?? null,
  );
}

function readProjectedSettingsText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fallback = (value as Readonly<{ fallback?: unknown }>).fallback;
  if (typeof fallback !== 'string') return undefined;
  const normalized = fallback.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function intersectSettingsValueTypes(
  left: ReadonlySet<ProjectedSettingsValueType>,
  right: ReadonlySet<ProjectedSettingsValueType>,
): Set<ProjectedSettingsValueType> {
  return new Set([...left].filter((type) => right.has(type)));
}

function resolvePossibleSettingsValueTypes(
  schema: PluginSettingFieldSchemaV2,
): Set<ProjectedSettingsValueType> {
  let possibleTypes = new Set<ProjectedSettingsValueType>(
    schema.type ? [schema.type] : ALL_PROJECTED_SETTINGS_VALUE_TYPES,
  );

  if (schema.anyOf) {
    const alternativeTypes = new Set<ProjectedSettingsValueType>();
    for (const alternative of schema.anyOf) {
      for (const type of resolvePossibleSettingsValueTypes(alternative)) {
        alternativeTypes.add(type);
      }
    }
    possibleTypes = intersectSettingsValueTypes(possibleTypes, alternativeTypes);
  }

  if (schema.oneOf) {
    const alternativeTypeCounts = new Map<ProjectedSettingsValueType, number>();
    for (const alternative of schema.oneOf) {
      for (const type of resolvePossibleSettingsValueTypes(alternative)) {
        alternativeTypeCounts.set(type, (alternativeTypeCounts.get(type) ?? 0) + 1);
      }
    }
    const exclusiveAlternativeTypes = new Set<ProjectedSettingsValueType>(
      [...alternativeTypeCounts]
        .filter(([, count]) => count === 1)
        .map(([type]) => type),
    );
    possibleTypes = intersectSettingsValueTypes(possibleTypes, exclusiveAlternativeTypes);
  }

  for (const constraint of schema.allOf ?? []) {
    possibleTypes = intersectSettingsValueTypes(
      possibleTypes,
      resolvePossibleSettingsValueTypes(constraint),
    );
  }

  return possibleTypes;
}

function resolveProjectedSettingsValueType(params: Readonly<{
  pluginId: string;
  contributionId: string;
  fieldId: string;
  schema: PluginSettingFieldSchemaV2;
  control?: 'auto' | 'text' | 'textarea' | 'switch' | 'select' | 'multiSelect' | 'number' | 'json';
}>): ProjectedSettingsValueType {
  const valueTypes = [...resolvePossibleSettingsValueTypes(params.schema)];
  if (valueTypes.length === 1) {
    return valueTypes[0]!;
  }
  if (
    params.control === 'number'
    && valueTypes.every((type) => type === 'number' || type === 'integer' || type === 'null')
  ) {
    return valueTypes.includes('integer') ? 'integer' : 'number';
  }
  if (params.control === 'json') {
    return 'object';
  }

  throw invalidSettingsProjection({
    pluginId: params.pluginId,
    contributionId: params.contributionId,
    fieldId: params.fieldId,
    reason: valueTypes.length === 0
      ? 'schema accepts no declared value types'
      : `schema can accept multiple value types (${valueTypes.sort().join(', ')})`,
  });
}

function projectPluginSettingsFieldV2(params: Readonly<{
  pluginId: string;
  contributionId: string;
  field: PluginSettingFieldV2;
}>): PluginProjectedSettingsFieldV2 {
  const secretCustody = readPluginSettingSecretCustody(params.field.secret);
  const managedServiceOrigin = readPluginSettingManagedServiceOrigin(params.field.secret);
  const isSecret = secretCustody !== null;
  const valueType = resolveProjectedSettingsValueType({
    pluginId: params.pluginId,
    contributionId: params.contributionId,
    fieldId: params.field.id,
    schema: params.field.schema,
    control: params.field.presentation?.control,
  });
  if (isSecret && valueType !== 'string') {
    throw invalidSettingsProjection({
      pluginId: params.pluginId,
      contributionId: params.contributionId,
      fieldId: params.field.id,
      reason: `secret fields must resolve to string, received '${valueType}'`,
    });
  }
  const requestedControl = params.field.presentation?.control;
  const control: PluginProjectedSettingsFieldV2['control'] = isSecret
    ? 'password'
    : requestedControl && requestedControl !== 'auto'
      ? requestedControl
      : valueType === 'boolean'
        ? 'switch'
        : valueType === 'string'
          ? 'text'
          : valueType === 'number' || valueType === 'integer'
            ? 'number'
            : 'json';
  const displayKey = readProjectedSettingsText(params.field.title);
  if (!displayKey) {
    throw invalidSettingsProjection({
      pluginId: params.pluginId,
      contributionId: params.contributionId,
      fieldId: params.field.id,
      reason: 'title has no displayable text',
    });
  }
  const descriptionKey = readProjectedSettingsText(params.field.description);

  return {
    id: params.field.id,
    kind: 'settings.field',
    version: '1.0.0',
    valueSchema: params.field.schema,
    valueType,
    control,
    secretCustody,
    ...(managedServiceOrigin ? { managedServiceOrigin } : {}),
    displayKey,
    ...(descriptionKey ? { descriptionKey } : {}),
    ...(params.field.presentation ? { presentation: params.field.presentation } : {}),
    ...(params.field.availability ? { availability: params.field.availability } : {}),
    ...(params.field.analytics ? { analytics: params.field.analytics } : {}),
    ...(params.field.presentation?.order !== undefined
      ? { order: params.field.presentation.order }
      : {}),
    capabilityGates: [],
    permissionGates: [],
    redaction: isSecret ? 'secret' : 'none',
    clearWhenEmpty: isSecret ? 'omit' : 'persist',
    ...(valueType === 'boolean' && typeof params.field.default === 'boolean'
      ? { defaultBooleanValue: params.field.default }
      : {}),
    ...(!isSecret && params.field.default !== undefined
      ? { defaultValue: params.field.default }
      : {}),
  };
}

/**
 * Pure normalization from a parsed Settings contribution to the one editable
 * projection shape shared by daemon projection and Account recovery UI.
 */
export function projectPluginSettingsContributionV2(params: Readonly<{
  pluginId: string;
  definition: PluginSettingsContributionV2;
}>): PluginProjectedSettingsV2 {
  const title = readProjectedSettingsText(params.definition.title);
  if (!title) {
    throw invalidSettingsProjection({
      pluginId: params.pluginId,
      contributionId: params.definition.id,
      reason: 'title has no displayable text',
    });
  }
  const description = readProjectedSettingsText(params.definition.description);
  return {
    id: params.definition.id,
    pluginId: params.pluginId,
    version: params.definition.version,
    title,
    ...(description ? { description } : {}),
    scope: { kind: params.definition.scope },
    presentation: params.definition.presentation,
    target: params.definition.target.kind === 'plugin'
      ? { kind: 'plugin' }
      : {
        kind: 'agent',
        agent: typeof params.definition.target.agent === 'string'
          ? { pluginId: params.pluginId, localId: params.definition.target.agent }
          : params.definition.target.agent,
      },
    fields: params.definition.fields.map((field) => {
      const projected = projectPluginSettingsFieldV2({
        pluginId: params.pluginId,
        contributionId: params.definition.id,
        field,
      });
      const groupId = params.definition.presentation.sections.find((section) => (
        section.fields.includes(field.id)
      ))?.id;
      return groupId ? { ...projected, groupId } : projected;
    }),
  };
}

const PluginProjectedFamilyEntryBaseV2Shape = {
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
} as const;

function strictProjectedFamilyEntrySchema<const Keys extends readonly string[]>(keys: Keys) {
  const optionalFields = Object.fromEntries(
    keys.map((key) => [key, z.unknown().optional()]),
  ) as { [Key in Keys[number]]: z.ZodOptional<z.ZodUnknown> };
  return z.object({
    ...PluginProjectedFamilyEntryBaseV2Shape,
    ...optionalFields,
  }).strict();
}

const PluginProjectedDefinitionEntryV2Schema = strictProjectedFamilyEntrySchema([
  'generation',
  'contributionKey',
  'definition',
] as const);
const PluginProjectedVoiceProviderEntryV2Schema = strictProjectedFamilyEntrySchema([
  'generation',
  'contributionKey',
  'definition',
  'recipientContract',
  'recipientContractDigest',
] as const);

const PluginProjectedComposerEntryBaseV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginIdSchema,
  identity: PluginContributionIdentityV1Schema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
}).strict();

function validateProjectedComposerEntry(
  value: Readonly<{
    id: string;
    pluginId: string;
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: Readonly<{ id: string }>;
  }>,
  context: z.RefinementCtx,
): void {
  const expectedId = `${value.identity.pluginId}/${value.identity.localId}`;
  if (value.id !== expectedId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'Projected Composer entry id must match its qualified identity.',
    });
  }
  if (value.pluginId !== value.identity.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pluginId'],
      message: 'Projected Composer entry pluginId must match its identity.',
    });
  }
  if (value.definition.id !== value.identity.localId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['definition', 'id'],
      message: 'Projected Composer definition id must match its identity.',
    });
  }
}

/** Exact current-generation static Composer attachment descriptor for UI projection. */
export const PluginProjectedComposerAttachmentEntryV1Schema = PluginProjectedComposerEntryBaseV1Schema.extend({
  definition: PluginComposerAttachmentContributionV1Schema,
}).strict().superRefine(validateProjectedComposerEntry);
export type PluginProjectedComposerAttachmentEntryV1 = z.infer<
  typeof PluginProjectedComposerAttachmentEntryV1Schema
>;

/** Exact current-generation static Composer control descriptor for UI projection. */
export const PluginProjectedComposerControlEntryV1Schema = PluginProjectedComposerEntryBaseV1Schema.extend({
  definition: PluginComposerControlContributionV1Schema,
}).strict().superRefine(validateProjectedComposerEntry);
export type PluginProjectedComposerControlEntryV1 = z.infer<
  typeof PluginProjectedComposerControlEntryV1Schema
>;

/** Exact current-generation static Composer region descriptor for UI projection. */
export const PluginProjectedComposerRegionEntryV1Schema = PluginProjectedComposerEntryBaseV1Schema.extend({
  definition: PluginComposerRegionContributionV1Schema,
}).strict().superRefine(validateProjectedComposerEntry);
export type PluginProjectedComposerRegionEntryV1 = z.infer<
  typeof PluginProjectedComposerRegionEntryV1Schema
>;
const PluginProjectedScmHostingProviderEntryV2Schema = strictProjectedFamilyEntrySchema([
  'localId',
  'kind',
  'displayName',
  'description',
  'baseUrl',
  'urlSafety',
  'capabilities',
  'operations',
  'authService',
  'metadata',
] as const);
const PluginProjectedScmBackendEntryV2Schema = strictProjectedFamilyEntrySchema([
  'localId',
  'title',
  'displayName',
  'description',
  'kind',
  'capabilities',
  'operations',
  'metadata',
] as const);
const PluginProjectedManagedDependencyEntryV2Schema = strictProjectedFamilyEntrySchema([
  'key',
  'kind',
  'title',
  'version',
  'capabilityId',
  'sourceKind',
  'display',
  'description',
  'source',
  'sources',
  'binary',
  'defaultPolicy',
  'consent',
  'ui',
  'stability',
  'experimental',
  'displayKey',
  'descriptionKey',
  'groupId',
  'order',
  'capabilityGates',
  'permissionGates',
  'redaction',
  'hidden',
  'defaultValue',
  'clearWhenEmpty',
  'platforms',
  'architectures',
  'executable',
  'health',
  'metadata',
] as const);
const PluginProjectedMcpEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'title',
  'description',
  'kind',
  'transport',
  'sessionScope',
  'resultSchema',
  'availability',
] as const);
/**
 * Static Account Collection facts available to UI consumers. The full
 * collection schema, index implementation, relation graph, and runtime state
 * remain Data-owned; only normalized, immutable UI-query descriptors cross
 * this projection boundary.
 */
export const PluginProjectedAccountCollectionEntryV1Schema = z.object({
  pluginId: PluginIdSchema,
  collectionId: PluginContributionLocalIdSchema,
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
  uiQueries: z.array(NormalizedPluginCollectionUiQueryDescriptorV1Schema).max(16),
}).strict().superRefine((value, context) => {
  const queryIds = new Set<string>();
  value.uiQueries.forEach((query, index) => {
    if (query.collection.pluginId !== value.pluginId || query.collection.collectionId !== value.collectionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uiQueries', index, 'collection'],
        message: 'Projected UI query collection identity must match its projected collection.',
      });
    }
    if (queryIds.has(query.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uiQueries', index, 'id'],
        message: 'Projected UI query ids must be unique.',
      });
    }
    queryIds.add(query.id);
  });
});
export type PluginProjectedAccountCollectionEntryV1 = z.infer<
  typeof PluginProjectedAccountCollectionEntryV1Schema
>;
const PluginProjectedBrowserEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'contributionId',
  'target',
  'display',
  'currentUrl',
  'launchMode',
  'profileMode',
  'description',
  'availability',
  'metadata',
  'qualifiedActionId',
  'targetId',
  'placement',
  'order',
] as const);
const PluginProjectedUiHeaderActionV2Schema = PluginUiHeaderActionPresentationV1Schema.extend({
  command: PluginUiResolvedSemanticCommandV1Schema,
}).strict();

const PROJECTED_OPENABLE_CONTENT_VIEWER_FIELDS = new Set([
  'id',
  'pluginId',
  'contributionKind',
  'pluginVersion',
  'descriptorId',
  'identity',
  'viewer',
  'destination',
  'serverIdentityId',
  'materializationRef',
]);

const PluginProjectedUiEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'pluginVersion',
  'descriptorId',
  'identity',
  'viewer',
  'destination',
  'contributionId',
  'contributionFamily',
  'artifactId',
  'artifactKind',
  'generatedV2',
  'generatedOwnerKind',
  'defaultLocale',
  'locales',
  'bundles',
  'digest',
  'families',
  'title',
  'description',
  'icon',
  'action',
  'kind',
  'order',
  'availability',
  'metadata',
  'fallback',
  'source',
  'resource',
  'service',
  'runtimeMode',
  'runtimeDiagnostics',
  'runtime',
  'entry',
  'bridge',
  'sandbox',
  'security',
  'display',
  'compatibility',
  'artifactGraph',
  'bundle',
  'hostApi',
  'nativeCapabilities',
  'availablePlatforms',
  'policy',
  'requiredHostMethods',
  'placement',
  'container',
  'target',
  'binding',
  'renderer',
  'visibility',
  'enabled',
  'featureGate',
  'badge',
  'actions',
  'headerActions',
  'rightSidebar',
  'group',
  'page',
  'platform',
  'channel',
  'integrity',
  'byteSize',
  'contentType',
  'assetPath',
  'url',
  'cacheKey',
  'reactNativeCrashState',
  'diagnostics',
] as const).extend({
  command: PluginUiResolvedSemanticCommandV1Schema.optional(),
  headerActions: z.array(PluginProjectedUiHeaderActionV2Schema).optional(),
  binding: PluginUiDestinationBindingV1Schema.optional(),
  container: PluginUiContainerV1Schema.optional(),
  identity: PluginContributionIdentityV1Schema.optional(),
  viewer: OpenableContentViewerSelectorV1Schema.optional(),
  destination: PluginContributionIdentityV1Schema.optional(),
  reactNativeCrashState: DaemonPluginReactNativeCrashStateV1Schema.optional(),
  // F7: a projection producer may stamp a per-plugin UI entry with the exact
  // machine materialization which produced it.  Older producers legitimately
  // omit both fields; consumers then fail closed rather than deriving a coarse
  // machine-level replacement.
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId.optional(),
  materializationRef: PluginMachineExecutionOriginV1Schema.shape.materializationRef.optional(),
}).strict().superRefine((value, context) => {
  const hasServerIdentity = value.serverIdentityId !== undefined;
  const hasMaterializationRef = value.materializationRef !== undefined;
  if (hasServerIdentity !== hasMaterializationRef) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasServerIdentity ? ['materializationRef'] : ['serverIdentityId'],
      message: 'Projected plugin UI execution origin must include both serverIdentityId and materializationRef.',
    });
    return;
  }
  const pluginId = typeof value.pluginId === 'string' ? value.pluginId : '';
  if (hasMaterializationRef && (!pluginId || value.materializationRef!.pluginId !== pluginId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['materializationRef', 'pluginId'],
      message: 'Projected plugin UI execution origin must match the entry pluginId.',
    });
  }

  const contributionKind = value.contributionKind;
  const hasViewerFields = value.identity !== undefined
    || value.viewer !== undefined
    || value.destination !== undefined;
  if (contributionKind !== 'openableContentViewer') {
    if (hasViewerFields) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributionKind'],
        message: 'Openable-content viewer fields are only valid for openableContentViewer entries.',
      });
    }
    return;
  }

  for (const field of Object.keys(value)) {
    if (PROJECTED_OPENABLE_CONTENT_VIEWER_FIELDS.has(field)) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `Projected openable-content viewer must not carry unrelated plugin UI field '${field}'.`,
    });
  }

  const descriptorId = typeof value.descriptorId === 'string' ? value.descriptorId : '';
  const expectedId = pluginId && descriptorId
    ? `openableContentViewer:${pluginId}:${descriptorId}`
    : '';
  if (!expectedId || value.id !== expectedId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'Projected openable-content viewer id must match its qualified identity.',
    });
  }
  if (
    value.identity === undefined
    || value.identity.pluginId !== pluginId
    || value.identity.localId !== descriptorId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity'],
      message: 'Projected openable-content viewer identity must match its pluginId and descriptorId.',
    });
  }
  if (value.viewer === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['viewer'],
      message: 'Projected openable-content viewer requires a normalized viewer selector.',
    });
  }
  if (value.destination === undefined || value.destination.pluginId !== pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['destination'],
      message: 'Projected openable-content viewer destination must be a same-plugin qualified UI view.',
    });
  }
});

/**
 * A normalized renderer reference already prepared by the canonical plugin-UI
 * projection. Declarative models are intentionally opaque here: the daemon
 * has already normalized and currentness-stamped them, while the physical UI
 * host remains their only consumer.
 */
export const DaemonPluginUiTargetedSurfaceRendererRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reactNative'),
    contributionId: PluginContributionLocalIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: PluginContributionLocalIdSchema,
    source: z.object({
      kind: z.literal('artifact'),
      artifact: PluginContributionLocalIdSchema,
    }).strict(),
    requiredHostMethods: z.array(PluginUiHostMethodV1Schema),
  }).strict(),
  z.object({
    kind: z.literal('declarative'),
    contributionId: PluginContributionLocalIdSchema,
    model: z.unknown().optional(),
    documentSource: PluginDeclarativeDocumentSourceV1Schema.optional(),
  }).strict(),
]);
export type DaemonPluginUiTargetedSurfaceRendererRefV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceRendererRefV1Schema
>;

export const DaemonPluginUiTargetedSurfaceRendererAvailabilityV1Schema = z.object({
  state: z.enum(['available', 'fallback', 'blocked', 'disabled']),
  reason: z.string().trim().min(1),
  diagnostics: z.array(z.string().trim().min(1)),
}).strict();
export type DaemonPluginUiTargetedSurfaceRendererAvailabilityV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceRendererAvailabilityV1Schema
>;

/**
 * The one renderer selected by the declaration-owned chain selector. The
 * physical target consumer receives this prepared candidate and never reruns
 * fallback selection from the provenance chain.
 */
export const DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema = z.object({
  identity: PluginContributionIdentityV1Schema,
  renderer: DaemonPluginUiTargetedSurfaceRendererRefV1Schema,
  availability: DaemonPluginUiTargetedSurfaceRendererAvailabilityV1Schema,
  /** Reuses the existing normalized broad UI artifact projection verbatim. */
  artifactProjection: PluginProjectedUiEntryV2Schema.optional(),
  crashState: DaemonPluginReactNativeCrashStateV1Schema.optional(),
}).strict();
export type DaemonPluginUiTargetedSurfaceSelectedRendererV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema
>;

/**
 * The daemon-selected static half of a Composer surface mount. The UI owns the
 * exact live Composer/input/instance facts and pairs them with this catalog row
 * only after revalidating every current-generation fence; it never selects a
 * renderer itself.
 */
export const DaemonPluginUiComposerSurfaceCatalogEntryV1Schema = z.object({
  contribution: PluginContributionIdentityV1Schema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
  projectionGeneration: z.number().int().nonnegative(),
  role: ComposerSurfaceRoleV1Schema,
  rendererChain: z.array(PluginContributionIdentityV1Schema).min(1).max(8),
  selectedRenderer: DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema,
  executionOrigin: PluginMachineExecutionOriginV1Schema,
  resourceCapability: PluginUiResourceBindingCapabilityV1Schema,
  /** The contributor's own current cold snapshot, never a target-owned substitute. */
  contributorTargetedContributions: PluginUiTargetedContributionsV1Schema,
}).strict().superRefine((entry, context) => {
  if (entry.executionOrigin.materializationRef.pluginId !== entry.contribution.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionOrigin', 'materializationRef', 'pluginId'],
      message: 'Composer catalog execution origin must belong to its admitted contributor.',
    });
  }
  if (
    entry.contributorTargetedContributions.target.pluginId !== entry.contribution.pluginId
    || entry.contributorTargetedContributions.target.immutableGenerationId !== entry.immutableGenerationId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributorTargetedContributions', 'target'],
      message: 'Composer catalog child projection must use the exact admitted contributor generation.',
    });
  }
  if (entry.rendererChain.some((renderer) => renderer.pluginId !== entry.contribution.pluginId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rendererChain'],
      message: 'Composer catalog renderer chains must contain only admitted contributor renderers.',
    });
  }
  const selected = entry.selectedRenderer;
  if (
    selected.identity.pluginId !== entry.contribution.pluginId
    || selected.renderer.contributionId !== selected.identity.localId
    || !entry.rendererChain.some((renderer) => (
      renderer.pluginId === selected.identity.pluginId
      && renderer.localId === selected.identity.localId
    ))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedRenderer'],
      message: 'Composer catalog selected renderer must be one same-contributor admitted chain member.',
    });
  }
});
export type DaemonPluginUiComposerSurfaceCatalogEntryV1 = z.infer<
  typeof DaemonPluginUiComposerSurfaceCatalogEntryV1Schema
>;

/**
 * Host-private target-filtered mount projection. It is emitted only from the
 * current admitted snapshot and is not an SDK authoring or Host API surface.
 */
export const DaemonPluginUiTargetedSurfaceMountV1Schema =
  DaemonPluginUiTargetedSurfaceMountIdentityV1Schema.extend({
    inputSchema: PluginJsonSchemaV2Schema,
    /** Declaration-order provenance; consumers use selectedRenderer only. */
    rendererChain: z.array(PluginContributionIdentityV1Schema).min(1).max(8),
    selectedRenderer: DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema,
    executionOrigin: PluginMachineExecutionOriginV1Schema,
    resourceCapability: PluginUiResourceBindingCapabilityV1Schema,
    /** The contributor's own current cold snapshot, never inherited from its target. */
    contributorTargetedContributions: PluginUiTargetedContributionsV1Schema,
  }).strict().superRefine((mount, context) => {
    if (mount.executionOrigin.materializationRef.pluginId !== mount.contributor.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionOrigin', 'materializationRef', 'pluginId'],
        message: 'Targeted Surface execution origin must belong to its admitted contributor.',
      });
    }
    if (
      mount.contributorTargetedContributions.target.pluginId !== mount.contributor.pluginId
      || mount.contributorTargetedContributions.target.immutableGenerationId
        !== mount.contributor.immutableGenerationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributorTargetedContributions', 'target'],
        message: 'Targeted Surface child projection must use the exact admitted contributor generation.',
      });
    }
    if (mount.rendererChain.some((renderer) => renderer.pluginId !== mount.contributor.pluginId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rendererChain'],
        message: 'Targeted Surface renderer chains must contain only admitted contributor renderers.',
      });
    }
    const selected = mount.selectedRenderer;
    if (
      selected.identity.pluginId !== mount.contributor.pluginId
      || selected.renderer.contributionId !== selected.identity.localId
      || !mount.rendererChain.some((renderer) => (
        renderer.pluginId === selected.identity.pluginId
        && renderer.localId === selected.identity.localId
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedRenderer'],
        message: 'Targeted Surface selected renderer must be one same-contributor admitted chain member.',
      });
    }
    const expectedArtifactContributionKind = selected.renderer.kind === 'reactNative'
      ? 'reactNativeBundle'
      : selected.renderer.kind === 'hostedWeb'
        ? 'hostedWeb'
        : undefined;
    if (
      expectedArtifactContributionKind !== undefined
      && (
        selected.artifactProjection === undefined
        || selected.artifactProjection.pluginId !== mount.contributor.pluginId
        || selected.artifactProjection.contributionId !== selected.identity.localId
        || selected.artifactProjection.contributionKind !== expectedArtifactContributionKind
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedRenderer', 'artifactProjection'],
        message: 'Executable targeted Surface renderers require their exact contributor artifact projection.',
      });
    }
  });
export type DaemonPluginUiTargetedSurfaceMountV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceMountV1Schema
>;

export const DaemonPluginUiTargetedSurfaceMountsV1Schema = z.array(
  DaemonPluginUiTargetedSurfaceMountV1Schema,
);
export type DaemonPluginUiTargetedSurfaceMountsV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceMountsV1Schema
>;

function sameTargetedSurfaceProtocolV1(
  left: Readonly<{ id: string; version: number }>,
  right: Readonly<{ id: string; version: number }>,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function sameTargetedSurfaceContributorV1(
  left: Readonly<{ pluginId: string; contributionId: string; immutableGenerationId: string }>,
  right: Readonly<{ pluginId: string; contributionId: string; immutableGenerationId: string }>,
): boolean {
  return left.pluginId === right.pluginId
    && left.contributionId === right.contributionId
    && left.immutableGenerationId === right.immutableGenerationId;
}

/**
 * Read one exact daemon-admitted targeted Surface mount for a current target.
 *
 * The Registry remains the admission/selection owner. This helper only owns
 * the shared target+surface correlation used by physical and semantic hosts;
 * a missing, stale, or ambiguous current candidate fails closed.
 */
export function readDaemonPluginUiTargetedSurfaceMountV1<
  TMount extends DaemonPluginUiTargetedSurfaceMountV1,
>(input: Readonly<{
  mounts: readonly TMount[];
  target: TMount['target'];
  surface: z.infer<typeof PluginUiTargetedContributionSurfaceV1Schema>;
}>): TMount | null {
  const matching = input.mounts.filter((mount) => (
    mount.point.pointId === input.surface.point.pointId
    && sameTargetedSurfaceProtocolV1(mount.point.protocol, input.surface.point.protocol)
    && sameTargetedSurfaceContributorV1(mount.contributor, input.surface.contributor)
    && mount.role === input.surface.role
    && mount.presentation === input.surface.presentation
  ));
  if (matching.length !== 1) return null;
  const mount = matching[0]!;
  return mount.target.pluginId === input.target.pluginId
    && mount.target.immutableGenerationId === input.target.immutableGenerationId
    ? mount
    : null;
}

export const PluginProjectedFamilyEntryV2Schema = z.union([
  PluginProjectedDefinitionEntryV2Schema,
  PluginProjectedVoiceProviderEntryV2Schema,
  PluginProjectedComposerAttachmentEntryV1Schema,
  PluginProjectedComposerControlEntryV1Schema,
  PluginProjectedComposerRegionEntryV1Schema,
  ConnectedAccountUiProjectionEntryV1Schema,
  PluginProjectedScmHostingProviderEntryV2Schema,
  PluginProjectedScmBackendEntryV2Schema,
  PluginProjectedManagedDependencyEntryV2Schema,
  PluginProjectedMcpEntryV2Schema,
  PluginProjectedAccountCollectionEntryV1Schema,
  PluginProjectedBrowserEntryV2Schema,
  PluginProjectedUiEntryV2Schema,
]);
export type PluginProjectedFamilyEntryV2 = z.infer<typeof PluginProjectedFamilyEntryV2Schema>;

function projectedFamilySchema<
  const Family extends string,
  EntrySchema extends z.ZodType,
>(
  family: Family,
  entrySchema: EntrySchema,
) {
  return z.object({
    family: z.literal(family),
    entriesById: z.record(z.string(), entrySchema).default({}),
  }).strict();
}

const PluginProjectedProvidersFamilyV2Schema = projectedFamilySchema('providers', PluginProjectedDefinitionEntryV2Schema);
const PluginProjectedConnectedAccountsFamilyV2Schema = projectedFamilySchema('connectedAccounts', ConnectedAccountUiProjectionEntryV1Schema);
const PluginProjectedScmHostingProvidersFamilyV2Schema = projectedFamilySchema('scmHostingProviders', PluginProjectedScmHostingProviderEntryV2Schema);
const PluginProjectedScmBackendsFamilyV2Schema = projectedFamilySchema('scmBackends', PluginProjectedScmBackendEntryV2Schema);
const PluginProjectedManagedDependenciesFamilyV2Schema = projectedFamilySchema('managedDependencies', PluginProjectedManagedDependencyEntryV2Schema);
const PluginProjectedMcpFamilyV2Schema = projectedFamilySchema('mcp', PluginProjectedMcpEntryV2Schema);
const PluginProjectedAccountCollectionsFamilyV2Schema = projectedFamilySchema('accountCollections', PluginProjectedAccountCollectionEntryV1Schema);
const PluginProjectedUiFamilyV2Schema = projectedFamilySchema('pluginUi', PluginProjectedUiEntryV2Schema);
const PluginProjectedBrowserFamilyV2Schema = projectedFamilySchema('pluginBrowser', PluginProjectedBrowserEntryV2Schema);
const PluginProjectedVoiceModelPacksFamilyV2Schema = projectedFamilySchema('voiceModelPacks', PluginProjectedDefinitionEntryV2Schema);
const PluginProjectedVoiceProvidersFamilyV2Schema = projectedFamilySchema('voiceProviders', PluginProjectedVoiceProviderEntryV2Schema);
const PluginProjectedComposerAttachmentsFamilyV1Schema = projectedFamilySchema('composerAttachments', PluginProjectedComposerAttachmentEntryV1Schema);
const PluginProjectedComposerControlsFamilyV1Schema = projectedFamilySchema('composerControls', PluginProjectedComposerControlEntryV1Schema);
const PluginProjectedComposerRegionsFamilyV1Schema = projectedFamilySchema('composerRegions', PluginProjectedComposerRegionEntryV1Schema);

const PluginProjectedFamiliesByIdV2Schema = z.object({
  providers: PluginProjectedProvidersFamilyV2Schema.optional(),
  connectedAccounts: PluginProjectedConnectedAccountsFamilyV2Schema.optional(),
  scmHostingProviders: PluginProjectedScmHostingProvidersFamilyV2Schema.optional(),
  scmBackends: PluginProjectedScmBackendsFamilyV2Schema.optional(),
  managedDependencies: PluginProjectedManagedDependenciesFamilyV2Schema.optional(),
  mcp: PluginProjectedMcpFamilyV2Schema.optional(),
  accountCollections: PluginProjectedAccountCollectionsFamilyV2Schema.optional(),
  pluginUi: PluginProjectedUiFamilyV2Schema.optional(),
  pluginBrowser: PluginProjectedBrowserFamilyV2Schema.optional(),
  voiceModelPacks: PluginProjectedVoiceModelPacksFamilyV2Schema.optional(),
  voiceProviders: PluginProjectedVoiceProvidersFamilyV2Schema.optional(),
  composerAttachments: PluginProjectedComposerAttachmentsFamilyV1Schema.optional(),
  composerControls: PluginProjectedComposerControlsFamilyV1Schema.optional(),
  composerRegions: PluginProjectedComposerRegionsFamilyV1Schema.optional(),
}).strict().default({});
assertPluginProjectionFamilyIdsV2(Object.keys(PluginProjectedFamiliesByIdV2Schema.unwrap().shape));

export const PluginProjectedFamilyV2Schema = z.union([
  PluginProjectedProvidersFamilyV2Schema,
  PluginProjectedConnectedAccountsFamilyV2Schema,
  PluginProjectedScmHostingProvidersFamilyV2Schema,
  PluginProjectedScmBackendsFamilyV2Schema,
  PluginProjectedManagedDependenciesFamilyV2Schema,
  PluginProjectedMcpFamilyV2Schema,
  PluginProjectedAccountCollectionsFamilyV2Schema,
  PluginProjectedUiFamilyV2Schema,
  PluginProjectedBrowserFamilyV2Schema,
  PluginProjectedVoiceModelPacksFamilyV2Schema,
  PluginProjectedVoiceProvidersFamilyV2Schema,
  PluginProjectedComposerAttachmentsFamilyV1Schema,
  PluginProjectedComposerControlsFamilyV1Schema,
  PluginProjectedComposerRegionsFamilyV1Schema,
]);
export type PluginProjectedFamilyV2 = z.infer<typeof PluginProjectedFamilyV2Schema>;

export const PluginProjectionV2Schema = z.object({
  v: z.literal(2),
  generation: z.number().int().nonnegative(),
  installedPackagesById: z.record(z.string(), PluginProjectionInstalledPackageV2Schema).default({}),
  agentsById: z.record(z.string(), PluginProjectedAgentV2Schema).default({}),
  backendsById: z.record(z.string(), PluginProjectedBackendV2Schema).default({}),
  actionsById: z.record(z.string(), PluginProjectedActionV2Schema).default({}),
  toolsById: z.record(z.string(), PluginProjectedToolV2Schema).default({}),
  commandsById: z.record(z.string(), PluginProjectedCommandV2Schema).default({}),
  resourcesById: z.record(z.string(), PluginProjectedResourceV2Schema).default({}),
  settingsById: z.record(z.string(), PluginProjectedSettingsV2Schema).default({}),
  familiesById: PluginProjectedFamiliesByIdV2Schema,
  contributionIntrospection: PluginContributionIntrospectionProjectionV1Schema.optional(),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema).default([]),
}).strict();
export type PluginProjectionV2 = z.infer<typeof PluginProjectionV2Schema>;

export type DaemonContributionRegistryProjection =
  | DaemonContributionRegistryProjectionV1
  | PluginProjectionV2;
