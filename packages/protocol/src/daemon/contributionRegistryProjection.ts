import { z } from 'zod';
import { InputHintsSchema, InputPathSchema } from '../inputs/inputFields.js';
import { WidgetConnectedAccountPurposeBindingV1Schema } from '../widgets/widgetConnectedAccountPurposeBindingV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { PluginHostedHtmlSourceV1Schema } from '../plugins/contributions/ui/hostedHtmlSourceV1.js';
import { PluginUiHostedHtmlRequestedCapabilitiesV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import {
  PluginSourceCustodyV1Schema,
  pluginSourceCustodyV1Equal,
} from '../plugins/runtime/sourceCustody.js';

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
import { ConnectedAccountPurposeDeclarationV1Schema } from '../connect/connectedAccountPurposes.js';
import {
  PluginActionConfirmationV2Schema,
  PluginActionDangerLevelV2Schema,
  PluginActionExecutionV2Schema,
  PluginActionIconV2Schema,
  PluginActionPlacementBindingsV2Schema,
  PluginActionScopeV2Schema,
  PluginActionSlashV2Schema,
  PluginActionSurfaceV2Schema,
  pluginActionRequiresConfirmationPresentation,
  hasValidPluginConnectedAccountPurposeBindingsV2,
} from '../plugins/actions/v2.js';
import { PluginActionPresentUserAuthorizationFactsSchema } from '../plugins/actions/invocation.js';
import { PluginDiagnosticRemediationV1Schema } from './pluginContributionIntrospection.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { PluginUiHostMethodV1Schema } from '../plugins/ui/hostApiDefinition.js';
import {
  PluginUiQualifiedActionReferenceV1Schema as CanonicalPluginUiQualifiedActionReferenceV1Schema,
} from '../plugins/ui/hostApiRequests.js';
import { PluginUiResourceSubscriptionEventV1Schema } from '../plugins/ui/subscriptions.js';
import { PluginUiResolvedSemanticCommandV1Schema } from '../plugins/ui/semanticCommands.js';
import {
  ComposerSurfaceRoleV1Schema,
} from '../plugins/ui/composer.js';
import {
  PluginAgentCapabilitiesV2Schema,
  AgentUiProjectedDeclarationV1Schema,
  PluginResourceContextV1Schema,
  PluginDynamicResourceScopeV1Schema,
  PluginResourceKindV2Schema,
  PluginWorkflowContributionV1Schema,
  PluginInputTypeContributionV1Schema,
  PluginDragSourceContributionV1Schema,
  PluginDropTargetContributionV1Schema,
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
import { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from '../plugins/settings/accountSettingsLimits.js';
import { PluginUiHeaderActionPresentationV1Schema } from '../plugins/contributions/ui/sessionHeaderActions.js';
import {
  PluginDeclarativeDocumentSourceV1Schema,
} from '../plugins/contributions/ui/v2.js';
import {
  PluginDeclarativeProjectedModelV1Schema,
} from '../plugins/contributions/ui/declarativeProjectedModelV1.js';
import {
  PluginUiContainerV1Schema,
  PluginUiDestinationBindingV1Schema,
  PluginUiInlineSurfaceRoleV1Schema,
  PluginUiSurfaceBindingV1Schema,
} from '../plugins/contributions/ui/surfaceRegistry.js';
import { PluginAgentCliMetadataSchema } from '../plugins/contributions/agentCliMetadata.js';
import { PluginOptionalStringSchema } from '../plugins/_shared.js';
import {
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../plugins/backendDefinitionV1.js';
import {
  PluginContributionIdentityV1Schema as CanonicalPluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema as CanonicalPluginContributionLocalIdSchema,
  qualifyPluginContributionReferenceV1,
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
  PluginUiRuntimeOccurrenceIdV1Schema as CanonicalPluginUiRuntimeOccurrenceIdV1Schema,
  PluginUiTargetedContributionContributorV1Schema,
  PluginUiTargetedContributionProtocolV1Schema,
  PluginUiTargetedContributionSurfaceV1Schema,
  PluginUiTargetedContributionSurfacePresentationV1Schema,
  PluginUiTargetedContributionTargetV1Schema,
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
const PluginUiQualifiedActionReferenceV1Schema = asProtocolZod(
  CanonicalPluginUiQualifiedActionReferenceV1Schema,
);
const PluginUiRuntimeOccurrenceIdV1Schema = asProtocolZod(
  CanonicalPluginUiRuntimeOccurrenceIdV1Schema,
);

const DaemonReactNativeHostRuntimeIdentityStringV1Schema = z.string().trim().min(1);

export const DaemonReactNativeHostRuntimeIdentityV1Schema = z.object({
  platform: z.enum(['android', 'ios']),
  channel: z.enum(['development', 'internal', 'store']),
  rawUpdateChannel: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  appVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeApplicationVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeBuildVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  applicationId: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
}).strict();
export type DaemonReactNativeHostRuntimeIdentityV1 = z.infer<
  typeof DaemonReactNativeHostRuntimeIdentityV1Schema
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
 * A mounted plugin target as the client knows it: the plugin and the runtime
 * occurrence its current catalog row named. A targeted read returns the
 * daemon's *current* snapshot tagged with its own occurrence; the client
 * remounts when that tag differs. Only effects are occurrence-fenced.
 */
export const DaemonContributionRegistryProjectionMountedTargetV1Schema = z.object({
  pluginId: PluginIdSchema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
}).strict();
export type DaemonContributionRegistryProjectionMountedTargetV1 = z.infer<
  typeof DaemonContributionRegistryProjectionMountedTargetV1Schema
>;

/**
 * The client facts that select what the daemon projects for this caller:
 * translation locale and the renderers this client can actually host.
 */
const DaemonContributionRegistryProjectionClientContextV1Shape = {
  machineId: z.string().trim().min(1),
  /**
   * The caller's display locale. A client reads exactly two translation
   * bundles — its preferred locale merged over English — so naming the locale
   * lets the daemon ship only those. Omitting it keeps the whole set.
   */
  locale: z.string().trim().min(1).max(64).optional(),
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  hostedWebFrameCapability: DaemonHostedWebFrameCapabilityV1Schema.optional(),
};

function rejectMismatchedClientPlatforms(
  value: Readonly<{
    reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
    hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
  }>,
  context: z.RefinementCtx,
): void {
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
}

/** The machine-wide catalog read. It never carries a mounted target. */
export const DaemonContributionRegistryProjectionDescribeRequestSchema = z.object(
  DaemonContributionRegistryProjectionClientContextV1Shape,
).passthrough().superRefine(rejectMismatchedClientPlatforms);
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
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
    sourceCustody: PluginSourceCustodyV1Schema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).nullable(),
    payloadSchema: PluginJsonSchemaV2Schema.optional(),
    automation: PluginEventAutomationDeclarationV1Schema,
  }).strict(),
  setupAction: DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema,
  setupSurface: z.lazy(
    () => DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1Schema,
  ).optional(),
  historyGapResetAction: DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema.optional(),
}).strict().superRefine((entry, context) => {
  const eventIdentity = entry.event.identity;
  const requireSamePluginOccurrence = (
    value: Readonly<{ identity: Readonly<{ pluginId: string }>; occurrenceId: string }>,
    path: (string | number)[],
  ) => {
    if (
      value.identity.pluginId !== eventIdentity.pluginId
      || value.occurrenceId !== entry.event.occurrenceId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'Automation Action must carry the exact admitted Event plugin occurrence.',
      });
    }
  };
  requireSamePluginOccurrence(entry.setupAction, ['setupAction']);
  if (entry.historyGapResetAction) {
    requireSamePluginOccurrence(entry.historyGapResetAction, ['historyGapResetAction']);
  }
  if (!entry.setupSurface) return;
  if (
    entry.setupSurface.contribution.pluginId !== eventIdentity.pluginId
    || entry.setupSurface.occurrenceId !== entry.event.occurrenceId
    || entry.setupSurface.contributorTargetedContributions.target.pluginId !== eventIdentity.pluginId
    || entry.setupSurface.contributorTargetedContributions.target.occurrenceId
      !== entry.event.occurrenceId
    || !entry.setupSurface.contributorTargetedContributions.target.sourceCustody
    || !entry.event.sourceCustody
    || !pluginSourceCustodyV1Equal(
      entry.setupSurface.contributorTargetedContributions.target.sourceCustody,
      entry.event.sourceCustody,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['setupSurface'],
      message: 'Automation setup Surface must carry the exact admitted Event plugin authority.',
    });
  }
});
export type DaemonContributionRegistryProjectionAutomationEligibleEventV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema
>;

export const DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema = z.array(
  DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
);
export type DaemonContributionRegistryProjectionAutomationEligibleEventsV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema
>;


/**
 * The per-mount read: only the current contributions to one target plugin's
 * declared points. It never carries the machine-wide projection; a mount reads
 * that from the per-machine projection it already holds.
 */
export const DaemonPluginUiTargetedContributionsReadRequestSchema = z.object({
  ...DaemonContributionRegistryProjectionClientContextV1Shape,
  pluginId: PluginIdSchema,
}).strict().superRefine(rejectMismatchedClientPlatforms);
export type DaemonPluginUiTargetedContributionsReadRequest = z.infer<
  typeof DaemonPluginUiTargetedContributionsReadRequestSchema
>;

export const DaemonPluginUiTargetedContributionsReadResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('current'),
    /** Tagged with the target's current occurrence (`target.occurrenceId`). */
    targetedContributions: PluginUiTargetedContributionsV1Schema,
    /** Host-private selected embedded-Surface mounts for the same snapshot. */
    targetedSurfaceMounts: z.lazy(() => DaemonPluginUiTargetedSurfaceMountsV1Schema),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    code: z.string().trim().min(1),
  }).strict(),
]);
export type DaemonPluginUiTargetedContributionsReadResponse = z.infer<
  typeof DaemonPluginUiTargetedContributionsReadResponseSchema
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
    retryable: z.boolean().optional(),
    remediation: PluginDiagnosticRemediationV1Schema.optional(),
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
  expectedOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
 * Reads one current Action's declared input/output schemas. The bulk projection
 * omits them; a reader asks for the one Action it is about to validate or
 * describe, pinned to the occurrence it projected. A reloaded plugin answers
 * `plugin_occurrence_stale` for the retired occurrence.
 */
export const DaemonPluginActionSchemasReadRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  qualifiedActionId: z.string().trim().min(1),
}).strict();
export type DaemonPluginActionSchemasReadRequest = z.infer<
  typeof DaemonPluginActionSchemasReadRequestSchema
>;

export const DaemonPluginActionSchemasReadResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    inputSchema: PluginJsonSchemaV2Schema,
    outputSchema: PluginJsonSchemaV2Schema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
  }).strict(),
]);
export type DaemonPluginActionSchemasReadResponse = z.infer<
  typeof DaemonPluginActionSchemasReadResponseSchema
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
  expectedOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    reason: z.enum(['invalid_payload', 'stale_occurrence', 'unavailable', 'not_current']),
  }).strict(),
]);
export type DaemonPluginComposerReferenceSearchResponse = z.infer<
  typeof DaemonPluginComposerReferenceSearchResponseSchema
>;

export const DaemonPluginUiArtifactByteIdentityV1Schema = z.object({
  artifactDigest: PluginUiArtifactDigestV1Schema,
}).strict();
export type DaemonPluginUiArtifactByteIdentityV1 = z.infer<
  typeof DaemonPluginUiArtifactByteIdentityV1Schema
>;

/** Compatibility name for the one digest-only executable byte identity. */
export const DaemonPluginReactNativeBundleCacheIdentityV1Schema = DaemonPluginUiArtifactByteIdentityV1Schema;
export type DaemonPluginReactNativeBundleCacheIdentityV1 = z.infer<
  typeof DaemonPluginReactNativeBundleCacheIdentityV1Schema
>;

/** Stable process-local key for immutable executable bytes. */
export function deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(
  identity: DaemonPluginReactNativeBundleCacheIdentityV1,
): string {
  return DaemonPluginReactNativeBundleCacheIdentityV1Schema.parse(identity).artifactDigest;
}

/**
 * Hosted-Web executable byte identity. Semantic selection stays in the slot
 * envelope; persistent bytes add Account scope outside this digest identity.
 */
export const DaemonPluginHostedWebArtifactCacheIdentityV1Schema = DaemonPluginUiArtifactByteIdentityV1Schema;
export type DaemonPluginHostedWebArtifactCacheIdentityV1 = z.infer<
  typeof DaemonPluginHostedWebArtifactCacheIdentityV1Schema
>;

/** Canonical cache identity equality shared by daemon, RN, and hosted clients. */
export function isSameDaemonPluginReactNativeBundleCacheIdentityV1(
  left: unknown,
  right: unknown,
): boolean {
  const parsedLeft = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(left);
  const parsedRight = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && createCanonicalJsonSigningInput(parsedLeft.data) === createCanonicalJsonSigningInput(parsedRight.data);
}

export function deriveDaemonPluginHostedWebArtifactCacheIdentityKeyV1(
  identity: DaemonPluginHostedWebArtifactCacheIdentityV1,
): string {
  return DaemonPluginHostedWebArtifactCacheIdentityV1Schema.parse(identity).artifactDigest;
}

export function isSameDaemonPluginHostedWebArtifactCacheIdentityV1(
  left: unknown,
  right: unknown,
): boolean {
  const parsedLeft = DaemonPluginHostedWebArtifactCacheIdentityV1Schema.safeParse(left);
  const parsedRight = DaemonPluginHostedWebArtifactCacheIdentityV1Schema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && createCanonicalJsonSigningInput(parsedLeft.data) === createCanonicalJsonSigningInput(parsedRight.data);
}

export const DaemonPluginUiArtifactBytesCacheIdentityV1Schema = DaemonPluginUiArtifactByteIdentityV1Schema;
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
/**
 * The exact daemon-owned identity of one admitted embedded Surface mount.
 * The public targeted-contribution handle intentionally omits this mount's
 * input schema, renderer facts, execution origin, and Resource capability.
 */
export const DaemonPluginUiTargetedSurfaceMountIdentityV1Schema = z.object({
  target: asProtocolZod(PluginUiTargetedContributionTargetV1Schema),
  point: z.object({
    pointId: PluginContributionLocalIdSchema,
    protocol: asProtocolZod(PluginUiTargetedContributionProtocolV1Schema),
  }).strict(),
  contributor: asProtocolZod(PluginUiTargetedContributionContributorV1Schema),
  kind: z.literal('targetedSurface'),
  role: PluginContributionLocalIdSchema,
  presentation: PluginUiTargetedContributionSurfacePresentationV1Schema,
}).strict();
export type DaemonPluginUiTargetedSurfaceMountIdentityV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceMountIdentityV1Schema
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
  cacheIdentity: DaemonPluginUiArtifactByteIdentityV1Schema,
};

const DaemonPluginReactNativeArtifactBytesReadRequestSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadRequestBaseShape,
}).strict();

const DaemonPluginHostedWebArtifactBytesReadRequestSchema = z.object({
  artifactFamily: z.literal('hostedWeb'),
  machineId: z.string().trim().min(1),
  cacheIdentity: DaemonPluginUiArtifactByteIdentityV1Schema,
}).strict();

/**
 * One exact daemon byte-read route. Logical byte identity is the verified
 * digest alone; contribution and runtime metadata remain admission facts at
 * their own owners and cannot invalidate an identical byte request.
 */
export const DaemonPluginUiArtifactBytesReadRequestSchema = z.union([
  DaemonPluginReactNativeArtifactBytesReadRequestSchema,
  DaemonPluginHostedWebArtifactBytesReadRequestSchema,
]);
export type DaemonPluginUiArtifactBytesReadRequest = z.infer<
  typeof DaemonPluginUiArtifactBytesReadRequestSchema
>;

const DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape = {
  ok: z.literal(true),
  artifactFamily: z.literal('reactNative'),
  cacheIdentity: DaemonPluginUiArtifactByteIdentityV1Schema,
  artifact: z.object({
    artifactKind: z.literal('reactNativeBundle'),
    digest: PluginUiArtifactDigestV1Schema,
    format: z.literal('plainJs'),
    byteSize: z.number().int().nonnegative(),
  }).strict(),
  bytesBase64: z.string().trim().min(1),
  files: z.array(DaemonPluginUiArtifactFileBytesV1Schema).min(1).optional(),
};

const DaemonPluginReactNativeArtifactBytesReadSuccessSchema = z.object({
  ...DaemonPluginReactNativeArtifactBytesReadSuccessBaseShape,
}).strict();

const DaemonPluginHostedWebArtifactBytesReadSuccessSchema = z.object({
  ok: z.literal(true),
  artifactFamily: z.literal('hostedWeb'),
  cacheIdentity: DaemonPluginUiArtifactByteIdentityV1Schema,
  artifact: z.object({
    artifactKind: z.literal('hostedWebAsset'),
    digest: PluginUiArtifactDigestV1Schema,
    byteSize: z.number().int().nonnegative(),
  }).strict(),
  bytesBase64: z.string().trim().min(1),
  files: z.array(DaemonPluginUiArtifactFileBytesV1Schema).min(1).optional(),
}).strict();

export const DaemonPluginUiArtifactBytesReadResponseSchema = z.union([
  DaemonPluginReactNativeArtifactBytesReadSuccessSchema,
  DaemonPluginHostedWebArtifactBytesReadSuccessSchema,
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'invalid_request',
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
  expectedCallerOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    reason: z.enum(['invalid_payload', 'stale_occurrence', 'not_found', 'unavailable']),
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
  expectedCallerOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    'stale_occurrence',
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
  expectedCallerOccurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    monochrome: z.boolean().optional(),
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
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
  /**
   * The current occurrence's source custody and whether it declares
   * contribution points. A mount of a plugin without points needs no
   * targeted read: its targeted-contribution snapshot is empty by definition.
   */
  sourceCustody: PluginSourceCustodyV1Schema.optional(),
  declaresContributionPoints: z.boolean().optional(),
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

/**
 * One Agent-owned Connected Account purpose with its package-relative service
 * reference resolved to an exact contribution identity. The host and clients
 * can therefore present external and bundled Agents through the same account
 * chooser without consulting a bundled Agent catalog.
 */
export const PluginProjectedAgentConnectedAccountPurposeV2Schema =
  ConnectedAccountPurposeDeclarationV1Schema.extend({
    service: PluginContributionIdentityV1Schema,
  }).strict();
export type PluginProjectedAgentConnectedAccountPurposeV2 = z.infer<
  typeof PluginProjectedAgentConnectedAccountPurposeV2Schema
>;

const PluginProjectedAgentConnectedAccountsV2Schema = z.array(
  PluginProjectedAgentConnectedAccountPurposeV2Schema,
).max(32);

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
  connectedAccounts: PluginProjectedAgentConnectedAccountsV2Schema.optional(),
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
  /** Exact process-local occurrence of the plugin slot that supplied this Action. */
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
  // Input/output schemas are not projected: they are most of the describe
  // body, so a reader fetches one Action's schemas on demand through
  // `DaemonPluginActionSchemasReadRequestSchema`.
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
  /** Actual serving runtime slot; absent on earlier projection writers. */
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
  /** Producer-owned origin, consumed by the same Administration selection as Views. */
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId.optional(),
  materializationRef: PluginMachineExecutionOriginV1Schema.shape.materializationRef.optional(),
  resourceKind: PluginResourceKindV2Schema,
  /** Dynamic Resources have no packaged file path. */
  path: z.string().trim().min(1).optional(),
  /** Current declaration fact; absent older rows cannot serve contextual refresh. */
  scope: PluginDynamicResourceScopeV1Schema.optional(),
  /** Exact admitted Resource HostAccess, never a widget-owned credential choice. */
  connectedAccountPurposes: z.array(z.object({
    purpose: z.string().trim().min(1), serviceRefs: z.array(PluginContributionIdentityV1Schema).min(1),
  }).strict()).optional(),
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).strict().superRefine((resource, context) => {
  if (resource.path === undefined && resource.scope === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A pathless Resource must carry its declared scope.' });
  }
  const hasOrigin = resource.serverIdentityId !== undefined || resource.materializationRef !== undefined;
  if (hasOrigin && (resource.serverIdentityId === undefined || resource.materializationRef === undefined || resource.occurrenceId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Projected Resource origin requires both exact origin fields and its serving occurrence.' });
  }
  if (resource.materializationRef && resource.materializationRef.pluginId !== resource.pluginId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['materializationRef', 'pluginId'], message: 'Projected Resource origin must match its pluginId.' });
  }
});
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
  displayKey: PluginLocalizedStringV2Schema,
  descriptionKey: PluginLocalizedStringV2Schema.optional(),
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
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
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

function readProjectedSettingsText(
  value: unknown,
): z.infer<typeof PluginLocalizedStringV2Schema> | undefined {
  const parsed = PluginLocalizedStringV2Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
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
const PluginProjectedWorkflowEntryV1Schema = z.object({
  ...PluginProjectedFamilyEntryBaseV2Shape,
  pluginVersion: z.string().trim().min(1),
  definition: PluginWorkflowContributionV1Schema,
}).strict();
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
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
  /** Exact live slot stamped on plugin-owned projection-family entries. */
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
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
  'occurrenceId',
  'contributionKind',
  'pluginVersion',
  'descriptorId',
  'identity',
  'viewer',
  'destination',
  'serverIdentityId',
  'materializationRef',
]);

const PluginProjectedSearchProviderEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginIdSchema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  contributionKind: z.literal('searchProvider'),
  descriptorId: PluginContributionLocalIdSchema,
  identity: PluginContributionIdentityV1Schema,
  action: PluginContributionIdentityV1Schema,
}).strict().superRefine((value, context) => {
  if (value.id !== `searchProvider:${value.pluginId}:${value.descriptorId}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'Projected search-provider id must match its qualified contribution identity.',
    });
  }
  if (
    value.identity.pluginId !== value.pluginId
    || value.identity.localId !== value.descriptorId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity'],
      message: 'Projected search-provider identity must match its pluginId and descriptorId.',
    });
  }
  if (value.action.pluginId !== value.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action', 'pluginId'],
      message: 'Projected search-provider Action must belong to the declaring plugin.',
    });
  }
});

const PluginProjectedUiGenericEntryV2Schema = strictProjectedFamilyEntrySchema([
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
  'artifactSelectionOwner',
  'bundle',
  'hostApi',
  'nativeCapabilities',
  'availablePlatforms',
  'policy',
  'requiredHostMethods',
  'placement',
  'column',
  'container',
  'target',
  'binding',
  'renderer',
  'visibility',
  'enabled',
  'featureGate',
  'badge',
  'home',
  'inputs',
  'inputSchema',
  'sessionInputPath',
  'connectedAccountPurposeBindings',
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
  'diagnostics',
] as const).extend({
  /** Exact process-local occurrence of the plugin slot that supplied this UI contribution. */
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  /** Semantic selector for this exact generated Artifact; byte sources remain non-authoritative. */
  artifactSelectionOwner: z.enum(['accountRelease', 'daemonProjection']).optional(),
  command: PluginUiResolvedSemanticCommandV1Schema.optional(),
  headerActions: z.array(PluginProjectedUiHeaderActionV2Schema).optional(),
  binding: PluginUiSurfaceBindingV1Schema.optional(),
  inputs: InputHintsSchema.optional(),
  inputSchema: PluginJsonSchemaV2Schema.optional(),
  sessionInputPath: InputPathSchema.optional(),
  connectedAccountPurposeBindings: z.array(WidgetConnectedAccountPurposeBindingV1Schema).optional(),
  resources: z.array(PluginContributionIdentityV1Schema).optional(),
  container: PluginUiContainerV1Schema.optional(),
  identity: PluginContributionIdentityV1Schema.optional(),
  viewer: OpenableContentViewerSelectorV1Schema.optional(),
  destination: PluginContributionIdentityV1Schema.optional(),
  // The canonical normalized renderer reference, reusing the targeted-Surface
  // renderer schema verbatim (lazy: it is declared later in this module) so the
  // static projected UI entries and the mounted targeted Surface mounts admit
  // the declarative model through one strict Protocol-owned contract instead
  // of opaque records.
  renderer: z.lazy(() => DaemonPluginUiTargetedSurfaceRendererRefV1Schema).optional(),
  // F7: a projection producer may stamp a per-plugin UI entry with the exact
  // machine materialization which produced it.  Older producers legitimately
  // omit both fields; consumers then fail closed rather than deriving a coarse
  // machine-level replacement.
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId.optional(),
  materializationRef: PluginMachineExecutionOriginV1Schema.shape.materializationRef.optional(),
}).strict().superRefine((value, context) => {
  if (value.resources !== undefined && (value.contributionKind !== 'surfacePlacement'
    || value.binding?.kind !== 'inline' || value.binding.role !== 'widget'
    || value.resources.some(resource => resource.pluginId !== value.pluginId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources'], message: 'Widget Resources must name the same declaring plugin.' });
  }
  if (value.inputs !== undefined || value.inputSchema !== undefined || value.sessionInputPath !== undefined || value.connectedAccountPurposeBindings !== undefined) {
    const binding = value.binding;
    if (value.contributionKind !== 'surfacePlacement' || binding?.kind !== 'inline' || binding.role !== 'widget'
      || (value.sessionInputPath !== undefined && binding.targetKind !== 'session')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inputs'], message: 'Widget input descriptors require an inline widget binding.' });
    }
    if (value.inputs !== undefined && value.inputSchema === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inputSchema'], message: 'Widget inputs require their value-admission schema.' });
    }
    if (value.sessionInputPath !== undefined && !value.inputs?.fields.some((field) => field.path === value.sessionInputPath)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionInputPath'], message: 'The exact Session path must name a declared widget input.' });
    }
  }
  if (!hasValidPluginConnectedAccountPurposeBindingsV2(value.inputSchema, value.connectedAccountPurposeBindings ?? [])
    || value.connectedAccountPurposeBindings?.some((binding) => !value.inputs?.fields.some((field) => field.path === binding.path)
      || !value.resources?.some(resource => resource.pluginId === binding.consumer.pluginId && resource.localId === binding.consumer.localId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['connectedAccountPurposeBindings'], message: 'Widget viewer purposes must bind exact declared Connected Account input fields.' });
  }
  if (value.binding?.kind === 'inline' && value.binding.role === 'widget' && value.binding.targetKind === 'session'
    && (value.inputs === undefined || value.inputSchema === undefined || value.sessionInputPath === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionInputPath'], message: 'Session widgets require an exact typed Session input.' });
  }
  if (value.contributionKind === 'searchProvider') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributionKind'],
      message: 'Projected search providers must use the closed typed search-provider arm.',
    });
    return;
  }
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

const PluginProjectedUiEntryV2Schema = z.union([
  PluginProjectedSearchProviderEntryV1Schema,
  PluginProjectedUiGenericEntryV2Schema,
]);

/**
 * A normalized renderer reference already prepared by the canonical plugin-UI
 * projection. Declarative models use the strict Protocol-owned projected
 * schema here and at the physical UI host; relational mount/currentness checks
 * remain with the consumers that own those lifetimes.
 */
export const DaemonPluginUiTargetedSurfaceRendererRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hostedHtml'),
    contributionId: PluginContributionLocalIdSchema,
    source: PluginHostedHtmlSourceV1Schema,
    requiredHostMethods: z.array(PluginUiHostMethodV1Schema),
    // The declared request travels with the by-value document it describes; the
    // mounting host resolves and enforces it against current authority.
    requestedCapabilities: PluginUiHostedHtmlRequestedCapabilitiesV1Schema.optional(),
  }).strict(),
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
    // The one strict Protocol-owned final projected declarative model. The
    // daemon has already normalized and currentness-stamped it; the physical
    // UI host remains its only consumer and re-parses this same schema.
    model: PluginDeclarativeProjectedModelV1Schema.optional(),
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
  artifactProjection: PluginProjectedUiGenericEntryV2Schema.optional(),
}).strict();
export type DaemonPluginUiTargetedSurfaceSelectedRendererV1 = z.infer<
  typeof DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema
>;

/**
 * One exact current physical renderer selection for optional Event source
 * setup. It is carried beside the setup Action and is neither a destination
 * nor targeted-contribution membership.
 */
export const DaemonPluginUiEmbeddedSurfaceV1Schema = z.object({
  contribution: PluginContributionIdentityV1Schema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  projectionGeneration: z.number().int().nonnegative(),
  rendererChain: z.array(PluginContributionIdentityV1Schema).min(1).max(8),
  selectedRenderer: DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema,
  executionOrigin: PluginMachineExecutionOriginV1Schema,
  resourceCapability: PluginUiResourceBindingCapabilityV1Schema,
  contributorTargetedContributions: PluginUiTargetedContributionsV1Schema,
}).strict();
export const DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1Schema = DaemonPluginUiEmbeddedSurfaceV1Schema;
export type DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1Schema
>;

/**
 * The daemon-selected static half of a Composer surface mount. The UI owns the
 * exact live Composer/input/instance facts and pairs them with this catalog row
 * only after revalidating every current-generation fence; it never selects a
 * renderer itself.
 */
export const DaemonPluginUiComposerSurfaceCatalogEntryV1Schema = z.object({
  contribution: PluginContributionIdentityV1Schema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
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
    || entry.contributorTargetedContributions.target.occurrenceId !== entry.occurrenceId
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
      || mount.contributorTargetedContributions.target.occurrenceId
        !== mount.contributor.occurrenceId
      || !mount.contributorTargetedContributions.target.sourceCustody
      || !mount.contributor.sourceCustody
      || !pluginSourceCustodyV1Equal(
        mount.contributorTargetedContributions.target.sourceCustody,
        mount.contributor.sourceCustody,
      )
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
  left: Readonly<{
    pluginId: string;
    contributionId: string;
    occurrenceId: string;
    sourceCustody: z.infer<typeof PluginSourceCustodyV1Schema>;
  }>,
  right: Readonly<{
    pluginId: string;
    contributionId: string;
    occurrenceId: string;
    sourceCustody: z.infer<typeof PluginSourceCustodyV1Schema>;
  }>,
): boolean {
  return left.pluginId === right.pluginId
    && left.contributionId === right.contributionId
    && left.occurrenceId === right.occurrenceId
    && pluginSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody);
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
    && mount.target.occurrenceId === input.target.occurrenceId
    && pluginSourceCustodyV1Equal(
      mount.target.sourceCustody,
      input.target.sourceCustody,
    )
    ? mount
    : null;
}

const PluginProjectedInputTypeEntryV1Schema = z.object({
  id: z.string().min(1), pluginId: PluginIdSchema, pluginVersion: z.string().min(1), occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId.optional(),
  materializationRef: PluginMachineExecutionOriginV1Schema.shape.materializationRef.optional(),
  definition: PluginInputTypeContributionV1Schema,
  pickerSurface: DaemonPluginUiEmbeddedSurfaceV1Schema.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.id !== `${entry.pluginId}/${entry.definition.id}`) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Input type identity must match its descriptor' });
  }
  const hasOrigin = entry.serverIdentityId !== undefined || entry.materializationRef !== undefined;
  if (hasOrigin && (!entry.serverIdentityId || !entry.materializationRef || !entry.occurrenceId)) {
    context.addIssue({ code: 'custom', message: 'Projected input type origin requires both exact origin fields and its serving occurrence' });
  }
  if (entry.materializationRef && entry.materializationRef.pluginId !== entry.pluginId) {
    context.addIssue({ code: 'custom', path: ['materializationRef', 'pluginId'], message: 'Projected input type origin must match its pluginId' });
  }
  const mount = entry.pickerSurface;
  const declaredPicker = entry.definition.picker
    ? qualifyPluginContributionReferenceV1(entry.definition.picker, entry.pluginId)
    : null;
  if (mount && (!entry.definition.picker || !entry.occurrenceId
    || mount.contribution.pluginId !== entry.pluginId || mount.contribution.localId !== entry.definition.id
    || mount.occurrenceId !== entry.occurrenceId
    || mount.contributorTargetedContributions.target.pluginId !== entry.pluginId
    || mount.contributorTargetedContributions.target.occurrenceId !== entry.occurrenceId
    || !mount.contributorTargetedContributions.target.sourceCustody
    || mount.executionOrigin.materializationRef.pluginId !== entry.pluginId
    || mount.rendererChain[0]?.pluginId !== declaredPicker?.pluginId
    || mount.rendererChain[0]?.localId !== declaredPicker?.localId
    || mount.rendererChain.some(renderer => renderer.pluginId !== entry.pluginId)
    || !mount.rendererChain.some(renderer => renderer.pluginId === mount.selectedRenderer.identity.pluginId
      && renderer.localId === mount.selectedRenderer.identity.localId))) {
    context.addIssue({ code: 'custom', path: ['pickerSurface'], message: 'Picker surface must carry the exact admitted input type authority' });
  }
});

export const PluginProjectedDragSourceEntryV1Schema = z.object({
  id: z.string().min(1), pluginId: PluginIdSchema, pluginVersion: z.string().min(1), occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
  definition: PluginDragSourceContributionV1Schema,
}).strict().superRefine((entry, context) => {
  if (entry.id !== `${entry.pluginId}/${entry.definition.id}`) context.addIssue({ code: 'custom', path: ['id'], message: 'Drag source identity must match its descriptor' });
});
export type PluginProjectedDragSourceEntryV1 = z.infer<typeof PluginProjectedDragSourceEntryV1Schema>;
export const PluginProjectedDropTargetEntryV1Schema = z.object({
  id: z.string().min(1), pluginId: PluginIdSchema, pluginVersion: z.string().min(1), occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema.optional(),
  definition: PluginDropTargetContributionV1Schema,
}).strict().superRefine((entry, context) => {
  if (entry.id !== `${entry.pluginId}/${entry.definition.id}`) context.addIssue({ code: 'custom', path: ['id'], message: 'Drop target identity must match its descriptor' });
});
export type PluginProjectedDropTargetEntryV1 = z.infer<typeof PluginProjectedDropTargetEntryV1Schema>;

export const PluginProjectedFamilyEntryV2Schema = z.union([
  PluginProjectedDragSourceEntryV1Schema,
  PluginProjectedDropTargetEntryV1Schema,
  PluginProjectedInputTypeEntryV1Schema,
  PluginProjectedDefinitionEntryV2Schema,
  PluginProjectedWorkflowEntryV1Schema,
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
const PluginProjectedRolesFamilyV1Schema = projectedFamilySchema('roles', PluginProjectedDefinitionEntryV2Schema);
const PluginProjectedWorkflowsFamilyV1Schema = projectedFamilySchema('workflows', PluginProjectedWorkflowEntryV1Schema);
const PluginProjectedInputTypesFamilyV1Schema = projectedFamilySchema('inputTypes', PluginProjectedInputTypeEntryV1Schema);
const PluginProjectedDragSourcesFamilyV1Schema = projectedFamilySchema('dragSources', PluginProjectedDragSourceEntryV1Schema);
const PluginProjectedDropTargetsFamilyV1Schema = projectedFamilySchema('dropTargets', PluginProjectedDropTargetEntryV1Schema);
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
  roles: PluginProjectedRolesFamilyV1Schema.optional(),
  workflows: PluginProjectedWorkflowsFamilyV1Schema.optional(),
  inputTypes: PluginProjectedInputTypesFamilyV1Schema.optional(),
  dragSources: PluginProjectedDragSourcesFamilyV1Schema.optional(),
  dropTargets: PluginProjectedDropTargetsFamilyV1Schema.optional(),
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
  PluginProjectedRolesFamilyV1Schema,
  PluginProjectedWorkflowsFamilyV1Schema,
  PluginProjectedInputTypesFamilyV1Schema,
  PluginProjectedDragSourcesFamilyV1Schema,
  PluginProjectedDropTargetsFamilyV1Schema,
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
  actionsById: z.record(z.string(), PluginProjectedActionV2Schema).default({}),
  toolsById: z.record(z.string(), PluginProjectedToolV2Schema).default({}),
  commandsById: z.record(z.string(), PluginProjectedCommandV2Schema).default({}),
  resourcesById: z.record(z.string(), PluginProjectedResourceV2Schema).default({}),
  settingsById: z.record(z.string(), PluginProjectedSettingsV2Schema).default({}),
  familiesById: PluginProjectedFamiliesByIdV2Schema,
  /**
   * Lifecycle rows for the families a client reads here (composer references)
   * only. The complete per-contribution table is the CLI inspector's.
   */
  contributionIntrospection: PluginContributionIntrospectionProjectionV1Schema.optional(),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema).default([]),
}).strict();
export type PluginProjectionV2 = z.infer<typeof PluginProjectionV2Schema>;

/**
 * The machine-wide describe response. Declared after the projection schemas it
 * carries so the parsed projection is exactly `PluginProjectionV2`.
 */
export const DaemonContributionRegistryProjectionDescribeResponseSchema: z.ZodObject<{
  protocolVersion: z.ZodLiteral<1>;
  projection: typeof PluginProjectionV2Schema;
  composerSurfaceCatalog: z.ZodOptional<z.ZodArray<typeof DaemonPluginUiComposerSurfaceCatalogEntryV1Schema>>;
  automationEligibleEvents: z.ZodOptional<typeof DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema>;
}, z.core.$loose> = z.object({
  protocolVersion: z.literal(1),
  projection: PluginProjectionV2Schema,
  /**
   * Daemon-selected static Composer renderer facts. The UI joins each row to
   * its current live Composer/input/instance facts before producing a mount.
   */
  composerSurfaceCatalog: z.array(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema).optional(),
  /** Current cold Event-automation composer facts, independent of mounted targets. */
  automationEligibleEvents: DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema.optional(),
}).passthrough();
export type DaemonContributionRegistryProjectionDescribeResponse = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeResponseSchema
>;

export type DaemonContributionRegistryProjection = PluginProjectionV2;
