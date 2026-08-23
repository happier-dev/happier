import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginActionContributionV2Schema,
  PluginActionAvailabilityV2Schema,
  PluginJsonSchemaV2Schema,
  PluginToolContributionV2Schema,
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
  PluginUiTranslationsContributionV1Schema,
} from './ui/i18n.js';
import {
  PluginUiInstanceKeyV1Schema,
  PluginUiLaunchInputV1Schema,
} from '../ui/semanticCommands.js';
import {
  PluginSessionHeaderActionDescriptorV1Schema,
} from './ui/sessionHeaderActions.js';
import {
  PluginHostedWebContributionV1Schema,
} from './ui/hostedWeb.js';
import {
  PluginTranscriptActivityContributionV1Schema,
} from './ui/transcriptActivities.js';
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
import { PluginUiContributionsV2Schema } from './ui/v2.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { ConnectedAccountPurposeDeclarationsV1Schema } from '../../connect/connectedAccountPurposes.js';
import {
  PluginConnectedAccountAuthenticationV2Schema,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';
import {
  PluginComposerReferenceProviderContributionV1Schema,
} from './composerReferenceProviders.js';
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

const LEGACY_ACTIVITY_PROVIDER_FAMILY = `activity${'Providers'}`;
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

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectForbiddenKey(
  ctx: z.RefinementCtx,
  key: string,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [key],
    message,
  });
}

export const PluginAgentRuntimeAcpV2Schema = z.object({
  kind: z.literal('acp'),
  transport: PluginAgentAcpTransportSchema,
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

const PluginAgentGoalSetCapabilityV2Schema = z.object({
  fields: z.array(z.enum(['objective', 'status', 'tokenBudget'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  writableStatuses: z.array(z.enum(['active', 'paused', 'complete'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.').optional(),
}).strict();
const PluginAgentGoalControlModeV2Schema = z.object({
  get: z.literal(true).optional(), clear: z.literal(true).optional(), set: PluginAgentGoalSetCapabilityV2Schema.optional(),
}).strict().refine((value) => value.get || value.clear || value.set, 'At least one goal control capability is required.');
const activity = <T extends z.ZodTypeAny>(schema: T) => z.object({ active: schema.optional(), inactive: schema.optional() }).strict()
  .refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.');
const PluginAgentGoalsV2Schema = z.object({
  active: PluginAgentGoalControlModeV2Schema.optional(),
  inactive: PluginAgentGoalControlModeV2Schema.optional(),
  source: z.string().trim().min(1),
}).strict().refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.');
export const PluginAgentSessionCapabilitiesV2Schema = z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  delivery: z.array(z.enum(['newTurn', 'steer', 'followUp'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  cancel: z.boolean(), configuration: z.boolean().optional(),
  compaction: z.object({ events: z.literal(true), manual: z.literal(true).optional() }).strict().optional(),
  conversationRollback: z.literal(true).optional(),
  goals: PluginAgentGoalsV2Schema.optional(),
  catalog: activity(z.array(z.enum(['vendorPlugins', 'skills'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  usageLimitRecovery: activity(z.array(z.enum(['checkNow', 'consumeResetCredit'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  continuationVerification: z.object({ intents: z.array(z.enum(['resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), requirement: z.enum(['required', 'advisory']) }).strict().optional(),
  workStateSources: z.array(z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), itemKinds: z.array(z.enum(['goal', 'task', 'todo'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.') }).strict()).max(32).refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Work-state source ids must be unique.').optional(),
  runtimeActivitySnapshots: z.literal(true).optional(),
  startupInstructions: z.object({
    versions: z.tuple([z.literal(1)]),
  }).strict().optional(),
}).strict();
export type PluginAgentSessionCapabilitiesV2 = z.infer<typeof PluginAgentSessionCapabilitiesV2Schema>;

export const PluginAgentExecutionRunCapabilitiesV2Schema = z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), checkpoint: z.boolean(), stop: z.boolean(),
}).strict();
export type PluginAgentExecutionRunCapabilitiesV2 = z.infer<typeof PluginAgentExecutionRunCapabilitiesV2Schema>;

export const PluginAgentCapabilitySurfaceV2Schema = z.enum(['terminal', 'externalSessions']);
export type PluginAgentCapabilitySurfaceV2 = z.infer<typeof PluginAgentCapabilitySurfaceV2Schema>;

export const PluginAgentCapabilitySurfacesV2Schema = z.array(PluginAgentCapabilitySurfaceV2Schema)
  .refine((values) => new Set(values).size === values.length, 'Entries must be unique.');
export type PluginAgentCapabilitySurfacesV2 = z.infer<typeof PluginAgentCapabilitySurfacesV2Schema>;

const PluginAgentCapabilitiesV2Shape = {
  surfaces: PluginAgentCapabilitySurfacesV2Schema.optional(),
  sessions: PluginAgentSessionCapabilitiesV2Schema.optional(),
  executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema.optional(),
};

/**
 * The normalized lifecycle declaration is the one capability contract shared
 * by manifest parsing and the daemon projection. Consumers never reconstruct
 * this shape from Agent presentation metadata.
 */
export const PluginAgentCapabilitiesV2Schema = z.object(PluginAgentCapabilitiesV2Shape).strict()
  .refine(
    (value) => value.surfaces !== undefined || value.sessions !== undefined || value.executionRuns !== undefined,
    'At least one Agent capability declaration is required.',
  );
export type PluginAgentCapabilitiesV2 = z.infer<typeof PluginAgentCapabilitiesV2Schema>;

export const PluginAgentVendorResumeSupportV2Schema = z.enum(['supported', 'unsupported', 'experimental']);
export type PluginAgentVendorResumeSupportV2 = z.infer<typeof PluginAgentVendorResumeSupportV2Schema>;

/**
 * The client UI-behavior descriptor an Agent contributes: the data-only
 * `plugin.ui.v1` behavior surface (permission-footer handling, transcript
 * storage modes, composer/new-session facts, declarative component slots).
 *
 * It is carried, not re-declared. The client owns the one fail-closed
 * descriptor interpreter, so restating that vocabulary here would create a
 * second owner of the same projection. Without this field an installed Agent
 * has no runtime channel to the client's behavior projection at all and is
 * degraded to the neutral unknown behavior; bundled Agents reach the same
 * interpreter through their build-time projection.
 */
export const PluginAgentUiBehaviorContributionV2Schema = z.object({
  behavior: PluginLooseJsonObjectSchema.optional(),
  message: PluginLooseJsonObjectSchema.optional(),
  components: PluginLooseJsonObjectSchema.optional(),
}).strict();
export type PluginAgentUiBehaviorContributionV2 = z.infer<typeof PluginAgentUiBehaviorContributionV2Schema>;

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
}).strict().refine(
  (value) => value.vendorResume !== undefined || value.agentCliSystemTool !== undefined,
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
const PluginAgentSessionPrimaryShape = {
  primary: z.literal('sessions'),
  capabilities: z.object({ ...PluginAgentCapabilitiesV2Shape, sessions: PluginAgentSessionCapabilitiesV2Schema }).strict(),
};
const PluginAgentExecutionPrimaryShape = {
  primary: z.literal('executionRuns'),
  capabilities: z.object({ ...PluginAgentCapabilitiesV2Shape, executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema }).strict(),
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

export const PluginConnectedAccountDescriptorContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  capabilities: z.array(z.string().trim().min(1)).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;

export const BackgroundServiceContributionSchema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema.optional(),
}).strict();
export type BackgroundServiceContribution = z.infer<typeof BackgroundServiceContributionSchema>;

export {
  PluginConnectedAccountAuthenticationModeV2Schema,
  PluginConnectedAccountAuthenticationV2Schema,
  PluginConnectedAccountConfigurationFieldV2Schema,
  PluginConnectedAccountConfigurationV2Schema,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountAuthenticationV2,
  type PluginConnectedAccountConfigurationFieldV2,
  type PluginConnectedAccountConfigurationV2,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';

export const PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 = [
  definePluginContributionFamilyV2({ family: 'agents', schema: PluginAgentContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'providers', schema: ProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'actions', schema: PluginActionContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'commands', schema: PluginCommandContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'tools', schema: PluginToolContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'resources', schema: PluginResourceContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'transcriptActivities', schema: PluginTranscriptActivityContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionHeaderActions', schema: PluginSessionHeaderActionDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserTargets', schema: PluginBrowserTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserActions', schema: PluginBrowserActionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'settings', schema: PluginSettingsContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'events', schema: PluginEventContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'executionRunProfiles', schema: PluginExecutionRunProfileContributionV2Schema }),
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
  definePluginContributionFamilyV2({ family: 'daemonDatabases', schema: PluginDaemonDatabaseContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'composerReferences', schema: PluginComposerReferenceProviderContributionV1Schema }),
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
  if (hasOwn(value, LEGACY_ACTIVITY_PROVIDER_FAMILY)) {
    rejectForbiddenKey(ctx, LEGACY_ACTIVITY_PROVIDER_FAMILY, 'Activity providers were folded into contributes.notifications; use notification categories instead.');
  }
  const providerIds = new Set<string>();
  value.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: 'Duplicate provider contribution id' });
    }
    providerIds.add(provider.id);
  });
  const voiceModelPackIds = new Set<string>();
  value.voiceModelPacks.forEach((modelPack, index) => {
    if (voiceModelPackIds.has(modelPack.id)) {
      ctx.addIssue({ code: 'custom', path: ['voiceModelPacks', index, 'id'], message: 'Duplicate voice model-pack contribution id' });
    }
    voiceModelPackIds.add(modelPack.id);
  });
  const voiceProviderIds = new Set<string>();
  value.voiceProviders.forEach((provider, index) => {
    if (voiceProviderIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['voiceProviders', index, 'id'], message: 'Duplicate voice provider contribution id' });
    }
    voiceProviderIds.add(provider.id);
  });
  const backgroundServiceIds = new Set<string>();
  value.backgroundServices.forEach((service, index) => {
    if (backgroundServiceIds.has(service.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['backgroundServices', index, 'id'],
        message: 'Duplicate background service contribution id',
      });
    }
    backgroundServiceIds.add(service.id);
  });
  const daemonDatabaseIds = new Set<string>();
  value.daemonDatabases.forEach((database, index) => {
    if (daemonDatabaseIds.has(database.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['daemonDatabases', index, 'id'],
        message: 'Duplicate daemon database contribution id',
      });
    }
    daemonDatabaseIds.add(database.id);
  });
  if (value.accountCollections.length > 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountCollections'],
      message: 'At most 32 account collection contributions are allowed.',
    });
  }
  const accountCollectionIds = new Set<string>();
  value.accountCollections.forEach((collection, index) => {
    if (accountCollectionIds.has(collection.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountCollections', index, 'id'],
        message: 'Duplicate account collection contribution id',
      });
    }
    accountCollectionIds.add(collection.id);
  });
  const webhookIds = new Set<string>();
  value.webhooks.forEach((webhook, index) => {
    if (webhookIds.has(webhook.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['webhooks', index, 'id'],
        message: 'Duplicate webhook contribution id',
      });
    }
    webhookIds.add(webhook.id);
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
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
  type PluginBrowserActionContributionV1,
  type PluginBrowserTargetContributionV1,
} from './browser/v1.js';
