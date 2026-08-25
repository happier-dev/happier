import type { z } from 'zod';

import {
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
  isDynamicPluginResourceContributionV2,
  type PluginConnectedAccountDescriptorContributionV2,
} from './v2.js';
import { PluginActionDeclaredExecutionV2Schema } from '../actions/v2.js';
import {
  PluginMcpDiscoverySourceContributionV1Schema,
  PluginMcpServerContributionV1Schema,
} from './mcp.js';
import {
  PluginUiRendererV2Schema,
  PluginUiSettingsGroupV1Schema,
  PluginUiSettingsPageV1Schema,
  PluginUiTranslationBundleV2Schema,
  PluginUiViewV2Schema,
} from './ui/v2.js';
import { PluginSettingFieldV2Schema } from './settings.js';
import {
  readComposerAttachmentRuntimeRegistrationFieldsV1,
  type ComposerAttachmentRuntimeRegistrationFieldV1,
} from './composerAttachments.js';
import type { PluginClientExecutionPlatformV1 } from './clientExecution.js';
import type { VoiceProviderContribution } from './voiceProviders.js';
import type { PromptAssetTypeDescriptorV1 } from '../../prompts/library/promptAssetsV1.js';
import { isBundledProviderCatalogParserV1 } from '../../providers/catalog/descriptorV1.js';
import { isBundledProviderCommandCatalogParserV1 } from '../../providers/detection/descriptorV1.js';

export type PluginContributionReferenceRuleV2 = Readonly<{
  field: string;
  targetFamily: string;
  many?: boolean;
}>;
export type PluginContributionReferenceCandidateV2 = Readonly<{
  targetFamily: string;
  /** A closed alternative family set for one polymorphic reference. */
  targetFamilies?: readonly string[];
  /**
   * Whether a structured reference may target another plugin. Omitted preserves
   * the catalog's established cross-plugin reference behavior.
   */
  allowQualifiedCrossPlugin?: boolean;
  /**
   * Whether this declaration owns an exact structured self-reference rather
   * than the catalog's ordinary same-plugin local-id spelling.
   */
  allowQualifiedSamePlugin?: boolean;
  reference: unknown;
  path: readonly (string | number)[];
}>;
export type PluginContributionClientPlatform = PluginClientExecutionPlatformV1;
export type PluginContributionRegistrationTarget =
  | Readonly<{ realm: 'daemon' }>
  | Readonly<{
      realm: 'client';
      artifactId: string;
      modulePath: string;
      exportName: string;
      platforms: readonly PluginContributionClientPlatform[];
    }>;
export type PluginContributionRegistrationRight = Readonly<{
  family: string;
  localId: string;
  target: PluginContributionRegistrationTarget;
  requiredFields?: readonly (
    | 'factory'
    | 'sessionRunnerFactory'
    | 'externalSessions'
    | ComposerAttachmentRuntimeRegistrationFieldV1
  )[];
  promptAssetDescriptor?: PromptAssetTypeDescriptorV1;
  /** Canonical parsed declaration used to validate the registered Voice runtime. */
  voiceProviderDeclaration?: VoiceProviderContribution;
  connectedAccountDescriptorDeclaration?: PluginConnectedAccountDescriptorContributionV2;
  /**
   * The complete set of runtime arms a Provider contribution declares. A
   * Provider can declare a managed runtime, contributed catalog formats, or
   * both, so activation must validate the whole composite rather than accept
   * whichever arm happened to register.
   */
  providerArms?: Readonly<{
    managedRuntime: boolean;
    catalogParserIds: readonly string[];
  }>;
}>;

export const PLUGIN_CONTRIBUTION_LIFECYCLE_STAGES_V2 = Object.freeze([
  'declared',
  'normalized',
  'projected',
  'bound',
  'active',
  'unavailable',
  'invalid',
] as const);
export type PluginContributionLifecycleStageV2 = typeof PLUGIN_CONTRIBUTION_LIFECYCLE_STAGES_V2[number];
export type PluginContributionLifecycleProjectionV2 = Readonly<{
  status: PluginContributionLifecycleStageV2;
  reason?: string;
}>;

export type PluginContributionCatalogEntryV2 = Readonly<{
  manifestKey: string;
  schema: z.ZodTypeAny;
  identityField: string | null;
  identityKind: 'localId' | 'nestedId' | 'locale' | 'delegatedDomain';
  activationDemand: 'none' | 'declarative' | 'registration' | 'conditional';
  projectionFamily: string | null;
  allowedRuntimeRegistration: string | null;
  registrationHost: 'daemon' | 'client' | 'discriminated' | null;
  runtimeRegistrationHost(value: Readonly<Record<string, unknown>>): 'daemon' | 'client' | null;
  runtimeRegistrationTarget(value: Readonly<Record<string, unknown>>): PluginContributionRegistrationTarget | null;
  references: readonly PluginContributionReferenceRuleV2[];
  extractReferences(value: Readonly<Record<string, unknown>>): readonly PluginContributionReferenceCandidateV2[];
  requiresRegistration(value: Readonly<Record<string, unknown>>): boolean;
  runtimeRegistrationFamily(value: Readonly<Record<string, unknown>>): string;
  consumer: string;
  platforms: readonly ('cli' | 'web' | 'ios' | 'android' | 'desktop')[];
  fixtureId: string;
  disposition: 'retained' | 'reshaped' | 'delegated';
  lifecycleStages: typeof PLUGIN_CONTRIBUTION_LIFECYCLE_STAGES_V2;
  readEntries(contributes: Readonly<Record<string, unknown>>): readonly unknown[];
  canonicalize(value: unknown): unknown;
  projectJsonSchema(): Readonly<Record<string, unknown>>;
  conflictKey(value: Readonly<Record<string, unknown>>): string | null;
  merge(existing: unknown, incoming: unknown): Readonly<{ ok: true; value: unknown } | { ok: false; code: 'plugin_contribution_conflict' }>;
  projectIntrospection(
    value: Readonly<Record<string, unknown>>,
    lifecycle?: PluginContributionLifecycleProjectionV2,
  ): Readonly<{
    localId: string | null;
    family: string;
    consumer: string;
    platforms: PluginContributionCatalogEntryV2['platforms'];
    registration: 'required' | 'notRequired';
    status: PluginContributionLifecycleStageV2;
    unavailableReason?: string;
  }>;
}>;

const REFERENCE_RULES: Readonly<Record<string, readonly PluginContributionReferenceRuleV2[]>> = Object.freeze({
  actions: [{ field: 'hostAccess', targetFamily: 'manifest.hostAccess', many: true }],
  hooks: [{ field: 'hostAccess', targetFamily: 'manifest.hostAccess', many: true }],
  resources: [{ field: 'hostAccess', targetFamily: 'manifest.hostAccess', many: true }],
  commands: [{ field: 'action', targetFamily: 'actions' }],
  tools: [{ field: 'action', targetFamily: 'actions' }],
  transcriptActivities: [
    { field: 'resourceId', targetFamily: 'resources' },
    { field: 'actions', targetFamily: 'actions', many: true },
  ],
  sessionInfoSections: [
    { field: 'resourceId', targetFamily: 'resources' },
    { field: 'actions', targetFamily: 'actions', many: true },
  ],
  browserActions: [
    { field: 'action', targetFamily: 'actions' },
    { field: 'target', targetFamily: 'browserTargets' },
  ],
  promptAssets: [
    { field: 'resource', targetFamily: 'resources' },
  ],
  executionRunProfiles: [
    { field: 'promptAsset', targetFamily: 'promptAssets' },
    { field: 'compatibleAgents', targetFamily: 'agents', many: true },
    { field: 'actions', targetFamily: 'actions', many: true },
  ],
  notifications: [
    { field: 'eventIds', targetFamily: 'events', many: true },
    { field: 'defaultChannels', targetFamily: 'notificationChannels', many: true },
  ],
  openableContentViewers: [{ field: 'destination', targetFamily: 'ui.views' }],
  webhooks: [{ field: 'handlerAction', targetFamily: 'actions' }],
});

const ALL_PLATFORMS = Object.freeze(['cli', 'web', 'ios', 'android', 'desktop'] as const);
const CLI_PLATFORMS = Object.freeze(['cli', 'desktop'] as const);
type CoreFamily = typeof PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2[number]['family'];
type FamilyPolicy = Pick<PluginContributionCatalogEntryV2,
  'identityField' | 'disposition' | 'activationDemand' | 'projectionFamily' | 'allowedRuntimeRegistration' | 'consumer' | 'platforms'> &
  Readonly<{ registrationHost?: Exclude<PluginContributionCatalogEntryV2['registrationHost'], null> }>;
const FAMILY_POLICIES = {
  agents: { identityField: 'id', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'agents', consumer: 'agent-runtime', platforms: CLI_PLATFORMS },
  providers: { identityField: 'id', disposition: 'delegated', activationDemand: 'conditional', projectionFamily: 'providers', allowedRuntimeRegistration: 'providers', registrationHost: 'daemon', consumer: 'providers-first-class', platforms: CLI_PLATFORMS },
  actions: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'actions', registrationHost: 'discriminated', consumer: 'action-dispatch', platforms: ALL_PLATFORMS },
  commands: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'cli-commands', platforms: CLI_PLATFORMS },
  tools: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'agent-tools', platforms: CLI_PLATFORMS },
  resources: { identityField: 'id', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'resources', registrationHost: 'daemon', consumer: 'resource-service', platforms: ALL_PLATFORMS },
  transcriptActivities: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'transcript-tail-host', platforms: ALL_PLATFORMS },
  sessionInfoSections: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'session-info-host', platforms: ALL_PLATFORMS },
  sessionHeaderActions: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'session-header-host', platforms: ALL_PLATFORMS },
  browserTargets: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginBrowser', allowedRuntimeRegistration: null, consumer: 'browser-host', platforms: ALL_PLATFORMS },
  browserActions: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginBrowser', allowedRuntimeRegistration: null, consumer: 'browser-host', platforms: ALL_PLATFORMS },
  settings: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'settings-service', platforms: ALL_PLATFORMS },
  events: { identityField: 'id', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'events', consumer: 'event-broker', platforms: CLI_PLATFORMS },
  executionRunProfiles: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'execution-run-host', platforms: CLI_PLATFORMS },
  notifications: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'notification-service', platforms: ALL_PLATFORMS },
  notificationChannels: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'notifications', consumer: 'notification-service', platforms: CLI_PLATFORMS },
  scmHostingProviders: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'scmHostingProviders', allowedRuntimeRegistration: 'scm', consumer: 'scm-host', platforms: CLI_PLATFORMS },
  scmBackends: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'scmBackends', allowedRuntimeRegistration: 'scm', consumer: 'scm-host', platforms: CLI_PLATFORMS },
  connectedAccountDescriptors: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'connectedAccounts', allowedRuntimeRegistration: 'connectedAccounts', consumer: 'connected-account-service', platforms: CLI_PLATFORMS },
  managedDependencies: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'managedDependencies', allowedRuntimeRegistration: null, consumer: 'managed-dependency-service', platforms: CLI_PLATFORMS },
  systemTools: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'system-tool-service', platforms: CLI_PLATFORMS },
  promptAssets: { identityField: 'id', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'promptAssets', consumer: 'prompt-service', platforms: CLI_PLATFORMS },
  hooks: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'hooks', consumer: 'hook-dispatch', platforms: CLI_PLATFORMS },
  requestInterceptors: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'interceptors', consumer: 'fetch-service', platforms: CLI_PLATFORMS },
  voiceModelPacks: { identityField: 'id', disposition: 'retained', activationDemand: 'none', projectionFamily: 'voiceModelPacks', allowedRuntimeRegistration: null, consumer: 'voice-model-catalog', platforms: ALL_PLATFORMS },
  voiceProviders: { identityField: 'id', disposition: 'retained', activationDemand: 'registration', projectionFamily: 'voiceProviders', allowedRuntimeRegistration: 'voiceProviders', registrationHost: 'discriminated', consumer: 'voice-host', platforms: Object.freeze(['web', 'ios', 'android'] as const) },
  backgroundServices: { identityField: 'id', disposition: 'retained', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'backgroundServices', registrationHost: 'daemon', consumer: 'background-service-runner', platforms: CLI_PLATFORMS },
  daemonDatabases: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'daemon-database-service', platforms: CLI_PLATFORMS },
  composerReferences: { identityField: 'id', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'composerReferences', registrationHost: 'daemon', consumer: 'composer-reference-host', platforms: ALL_PLATFORMS },
  composerAttachments: { identityField: 'id', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: 'composerAttachments', allowedRuntimeRegistration: 'composerAttachments', registrationHost: 'daemon', consumer: 'composer-attachment-host', platforms: ALL_PLATFORMS },
  composerControls: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'composerControls', allowedRuntimeRegistration: null, consumer: 'composer-control-host', platforms: ALL_PLATFORMS },
  composerRegions: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'composerRegions', allowedRuntimeRegistration: null, consumer: 'composer-region-host', platforms: ALL_PLATFORMS },
  openableContentViewers: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'openable-content-host', platforms: ALL_PLATFORMS },
  accountCollections: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'accountCollections', allowedRuntimeRegistration: null, consumer: 'account-collection-service', platforms: ALL_PLATFORMS },
  webhooks: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'webhook-ingress', platforms: ALL_PLATFORMS },
  pluginContributionPoints: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'targeted-contribution-admission', platforms: ALL_PLATFORMS },
  targetedPluginContributions: { identityField: 'id', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'targeted-contribution-admission', platforms: ALL_PLATFORMS },
} as const satisfies Record<CoreFamily, FamilyPolicy>;

function extractRuleReferences(
  value: Readonly<Record<string, unknown>>,
  rules: readonly PluginContributionReferenceRuleV2[],
): PluginContributionReferenceCandidateV2[] {
  return rules.flatMap((rule) => {
    const raw = value[rule.field];
    const values = rule.many ? (Array.isArray(raw) ? raw : []) : raw === undefined ? [] : [raw];
    return values.map((reference, index) => ({
      targetFamily: rule.targetFamily,
      reference,
      path: [rule.field, ...(rule.many ? [index] : [])],
    }));
  });
}

function extractNestedReferences(family: string, value: Readonly<Record<string, unknown>>): PluginContributionReferenceCandidateV2[] {
  const openSurfaceDestinationReferences = (
    destination: unknown,
    path: readonly (string | number)[],
  ): PluginContributionReferenceCandidateV2[] => [{
    targetFamily: 'ui.views',
    targetFamilies: Object.freeze(['ui.views', 'ui.settingsPages']),
    allowQualifiedCrossPlugin: true,
    reference: destination,
    path,
  }];
  const semanticActionReferences = (
    declaration: unknown,
    path: readonly (string | number)[],
  ): PluginContributionReferenceCandidateV2[] => {
    // The bare `action: '<local-id>'` sugar has already widened to
    // `executeAction` by the time reference extraction sees a contribution, so
    // there is exactly one shape to read here.
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return [];
    const record = declaration as Readonly<Record<string, unknown>>;
    if (record.kind === 'executeAction' && record.action !== undefined) {
      return [{ targetFamily: 'actions', reference: record.action, path: [...path, 'action'] }];
    }
    if (record.kind === 'openSurface' && record.destination !== undefined) {
      return openSurfaceDestinationReferences(record.destination, [...path, 'destination']);
    }
    return [];
  };
  const collectionRowCommandReferences = (
    command: unknown,
    path: readonly (string | number)[],
  ): PluginContributionReferenceCandidateV2[] => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return [];
    const record = command as Readonly<Record<string, unknown>>;
    if (record.kind === 'action' && record.action !== undefined) {
      return [{
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: record.action,
        path: [...path, 'action'],
      }];
    }
    if (record.kind === 'openSurface' && record.destination !== undefined) {
      return openSurfaceDestinationReferences(record.destination, [...path, 'destination']);
    }
    return [];
  };
  const rendererChainReferences = (
    binding: unknown,
    path: readonly (string | number)[],
  ): PluginContributionReferenceCandidateV2[] => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return [];
    const record = binding as Readonly<Record<string, unknown>>;
    const fallbackRenderers = Array.isArray(record.fallbackRenderers)
      ? record.fallbackRenderers
      : [];
    return [
      ...(record.renderer === undefined ? [] : [{
        targetFamily: 'ui.renderers',
        reference: record.renderer,
        path: [...path, 'renderer'],
      }]),
      ...fallbackRenderers.map((renderer, index) => ({
        targetFamily: 'ui.renderers',
        reference: renderer,
        path: [...path, 'fallbackRenderers', index],
      })),
    ];
  };
  const composerAttachmentOperationReferences = (
    operations: unknown,
    path: readonly (string | number)[],
  ): PluginContributionReferenceCandidateV2[] => (
    Array.isArray(operations)
      ? operations.flatMap((operation, index) => (
          operation
          && typeof operation === 'object'
          && !Array.isArray(operation)
          && (operation as Readonly<Record<string, unknown>>).kind === 'attachment.add'
          && (operation as Readonly<Record<string, unknown>>).attachmentLocalId !== undefined
            ? [{
                targetFamily: 'composerAttachments',
                allowQualifiedCrossPlugin: false,
                reference: (operation as Readonly<Record<string, unknown>>).attachmentLocalId,
                path: [...path, index, 'attachmentLocalId'],
              }]
            : []
        ))
      : []
  );
  if (family === 'composerAttachments') {
    const display = value.display && typeof value.display === 'object' && !Array.isArray(value.display)
      ? value.display as Readonly<Record<string, unknown>>
      : null;
    const preview = value.preview && typeof value.preview === 'object' && !Array.isArray(value.preview)
      ? value.preview as Readonly<Record<string, unknown>>
      : null;
    return [
      ...rendererChainReferences(value.picker, ['picker']),
      ...(display?.kind === 'surface'
        ? rendererChainReferences(display.renderer, ['display', 'renderer'])
        : []),
      ...(preview?.kind === 'surface'
        ? rendererChainReferences(preview.renderer, ['preview', 'renderer'])
        : []),
    ];
  }
  if (family === 'composerControls') {
    const state = value.state && typeof value.state === 'object' && !Array.isArray(value.state)
      ? value.state as Readonly<Record<string, unknown>>
      : null;
    const interaction = value.interaction && typeof value.interaction === 'object' && !Array.isArray(value.interaction)
      ? value.interaction as Readonly<Record<string, unknown>>
      : null;
    const references: PluginContributionReferenceCandidateV2[] = [
      ...(state?.resource === undefined ? [] : [{
        targetFamily: 'resources',
        allowQualifiedCrossPlugin: false,
        reference: state.resource,
        path: ['state', 'resource'],
      }]),
      ...rendererChainReferences(value.compactRenderer, ['compactRenderer']),
    ];
    if (interaction?.kind === 'action' && interaction.action !== undefined) {
      references.push({
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: interaction.action,
        path: ['interaction', 'action'],
      });
    }
    if (interaction?.kind === 'attachmentPicker' && interaction.attachment !== undefined) {
      references.push({
        targetFamily: 'composerAttachments',
        allowQualifiedCrossPlugin: false,
        reference: interaction.attachment,
        path: ['interaction', 'attachment'],
      });
    }
    if (interaction?.kind === 'surface') {
      references.push(...rendererChainReferences(interaction.renderer, ['interaction', 'renderer']));
    }
    if (interaction?.kind === 'destination' && interaction.destination !== undefined) {
      references.push({
        targetFamily: 'ui.views',
        targetFamilies: Object.freeze(['ui.views', 'ui.settingsPages']),
        allowQualifiedCrossPlugin: false,
        reference: interaction.destination,
        path: ['interaction', 'destination'],
      });
    }
    if (interaction?.kind === 'choices' && Array.isArray(interaction.options)) {
      interaction.options.forEach((option, index) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return;
        const effect = (option as Readonly<Record<string, unknown>>).effect;
        if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return;
        const effectRecord = effect as Readonly<Record<string, unknown>>;
        if (effectRecord.kind === 'action' && effectRecord.action !== undefined) {
          references.push({
            targetFamily: 'actions',
            allowQualifiedCrossPlugin: false,
            reference: effectRecord.action,
            path: ['interaction', 'options', index, 'effect', 'action'],
          });
        }
        if (effectRecord.kind === 'composerApply') {
          references.push(...composerAttachmentOperationReferences(
            effectRecord.operations,
            ['interaction', 'options', index, 'effect', 'operations'],
          ));
        }
      });
    }
    return references;
  }
  if (family === 'composerRegions') {
    return rendererChainReferences(value.renderer, ['renderer']);
  }
  if (family === 'sessionHeaderActions') {
    return semanticActionReferences(value.command, ['command']);
  }
  if (family === 'ui.views') {
    const headerActions = Array.isArray(value.headerActions) ? value.headerActions : [];
    return headerActions.flatMap((headerAction, index) => (
      headerAction && typeof headerAction === 'object'
        ? semanticActionReferences(
            (headerAction as Readonly<Record<string, unknown>>).command,
            ['headerActions', index, 'command'],
          )
        : []
    ));
  }
  if (family === 'providers') {
    const managedRuntime = value.managedRuntime && typeof value.managedRuntime === 'object'
      ? value.managedRuntime as Readonly<Record<string, unknown>>
      : null;
    if (managedRuntime?.kind !== 'managed') return [];
    const dependencies = Array.isArray(managedRuntime.dependencies) ? managedRuntime.dependencies : [];
    const connectedAccounts = Array.isArray(managedRuntime.connectedAccounts) ? managedRuntime.connectedAccounts : [];
    return [
      ...dependencies.map((dependency, index) => ({
        targetFamily: 'managedDependencies',
        reference: dependency,
        path: ['managedRuntime', 'dependencies', index],
      })),
      ...connectedAccounts.flatMap((account, index) => account && typeof account === 'object'
        ? [{
            targetFamily: 'connectedAccountDescriptors',
            reference: (account as Readonly<Record<string, unknown>>).service,
            path: ['managedRuntime', 'connectedAccounts', index, 'service'],
          }]
        : []),
    ];
  }
  if (family === 'mcp.servers') {
    const transport = value.transport && typeof value.transport === 'object' ? value.transport as Record<string, unknown> : null;
    const executable = transport?.executable && typeof transport.executable === 'object' ? transport.executable as Record<string, unknown> : null;
    if (!executable || executable.id === undefined) return [];
    return [{ targetFamily: executable.kind === 'managedDependency' ? 'managedDependencies' : 'systemTools', reference: executable.id, path: ['transport', 'executable', 'id'] }];
  }
  if (family === 'agents') {
    const accounts = Array.isArray(value.connectedAccounts) ? value.connectedAccounts : [];
    const accountReferences = accounts.flatMap((account, index) => account && typeof account === 'object'
      ? [{ targetFamily: 'connectedAccountDescriptors', reference: (account as Record<string, unknown>).service, path: ['connectedAccounts', index, 'service'] }]
      : []);
    const runtime = value.runtime && typeof value.runtime === 'object' ? value.runtime as Record<string, unknown> : null;
    const transport = runtime?.transport && typeof runtime.transport === 'object' ? runtime.transport as Record<string, unknown> : null;
    const executable = transport?.executable && typeof transport.executable === 'object' ? transport.executable as Record<string, unknown> : null;
    return [
      ...accountReferences,
      ...(runtime?.kind === 'acp' && transport?.kind === 'stdio' && executable?.id !== undefined
        ? [{ targetFamily: executable.kind === 'managedDependency' ? 'managedDependencies' : 'systemTools', reference: executable.id, path: ['runtime', 'transport', 'executable', 'id'] }]
        : []),
    ];
  }
  if (family === 'settings') {
    const target = value.target && typeof value.target === 'object' ? value.target as Record<string, unknown> : null;
    return target?.kind === 'agent'
      ? [{ targetFamily: 'agents', reference: target.agent, path: ['target', 'agent'] }]
      : [];
  }
  if (family === 'promptAssets') {
    const target = value.target && typeof value.target === 'object' ? value.target as Record<string, unknown> : null;
    return target?.kind === 'agent'
      ? [{ targetFamily: 'agents', reference: target.agent, path: ['target', 'agent'] }]
      : [];
  }
  if (family === 'events' && value.kind === 'subscription') {
    return [{ targetFamily: 'events', reference: value.event, path: ['event'] }];
  }
  if (family === 'events' && value.kind === 'event') {
    const automation = value.automation && typeof value.automation === 'object' && !Array.isArray(value.automation)
      ? value.automation as Readonly<Record<string, unknown>>
      : null;
    const source = automation?.source && typeof automation.source === 'object' && !Array.isArray(automation.source)
      ? automation.source as Readonly<Record<string, unknown>>
      : null;
    if (!source) return [];
    return [
      ...(source.setupActionRef === undefined ? [] : [{
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        allowQualifiedSamePlugin: true,
        reference: source.setupActionRef,
        path: ['automation', 'source', 'setupActionRef'],
      }]),
      ...(source.historyGapResetActionRef === undefined ? [] : [{
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        allowQualifiedSamePlugin: true,
        reference: source.historyGapResetActionRef,
        path: ['automation', 'source', 'historyGapResetActionRef'],
      }]),
      ...(source.webhookContributionRef === undefined ? [] : [{
        targetFamily: 'webhooks',
        allowQualifiedCrossPlugin: false,
        allowQualifiedSamePlugin: true,
        reference: source.webhookContributionRef,
        path: ['automation', 'source', 'webhookContributionRef'],
      }]),
    ];
  }
  if (family === 'voiceProviders') {
    const client = value.client && typeof value.client === 'object' ? value.client as Record<string, unknown> : null;
    const execution = value.execution && typeof value.execution === 'object'
      ? value.execution as Record<string, unknown>
      : null;
    return [
      ...(client?.artifactId === undefined
        ? []
        : [{ targetFamily: 'generated.uiArtifacts', reference: client.artifactId, path: ['client', 'artifactId'] }]),
      ...(execution?.kind === 'experimental_agent_session_realtime' && execution.agent !== undefined
        ? [{
            targetFamily: 'agents',
            reference: execution.agent,
            path: ['execution', 'agent'],
          }]
        : []),
    ];
  }
  if (family === 'scmHostingProviders' && value.authService !== undefined) {
    return [{ targetFamily: 'connectedAccountDescriptors', reference: value.authService, path: ['authService'] }];
  }
  if (family === 'ui.renderers') {
    if (value.kind === 'reactNative') return [{ targetFamily: 'generated.uiArtifacts', reference: value.artifact, path: ['artifact'] }];
    if (value.kind === 'hostedWeb') {
      const source = value.source && typeof value.source === 'object' ? value.source as Record<string, unknown> : null;
      return source?.kind === 'artifact' ? [{ targetFamily: 'generated.uiArtifacts', reference: source.artifact, path: ['source', 'artifact'] }] : [];
    }
    const found: PluginContributionReferenceCandidateV2[] = [];
    const documentSource = value.documentSource && typeof value.documentSource === 'object'
      ? value.documentSource as Readonly<Record<string, unknown>>
      : null;
    if (documentSource?.kind === 'resource' && documentSource.resourceId !== undefined) {
      found.push({
        targetFamily: 'resources',
        reference: documentSource.resourceId,
        path: ['documentSource', 'resourceId'],
      });
    }
    const stack: Array<{ node: unknown; path: (string | number)[] }> = [{ node: value.root, path: ['root'] }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!current.node || typeof current.node !== 'object') continue;
      const node = current.node as Record<string, unknown>;
      if (node.kind === 'action') {
        found.push({
          targetFamily: 'actions',
          allowQualifiedCrossPlugin: false,
          reference: node.action,
          path: [...current.path, 'action'],
        });
      }
      if (node.kind === 'item' && node.action !== undefined) {
        found.push({
          targetFamily: 'actions',
          allowQualifiedCrossPlugin: false,
          reference: node.action,
          path: [...current.path, 'action'],
        });
      }
      if (node.kind === 'collectionList') {
        found.push(...collectionRowCommandReferences(node.primaryCommand, [...current.path, 'primaryCommand']));
        if (Array.isArray(node.secondaryCommands)) {
          node.secondaryCommands.forEach((command, index) => {
            found.push(...collectionRowCommandReferences(
              command,
              [...current.path, 'secondaryCommands', index],
            ));
          });
        }
      }
      if (node.kind === 'field') {
        const control = node.control && typeof node.control === 'object' ? node.control as Record<string, unknown> : null;
        if (typeof control?.settingId === 'string') found.push({ targetFamily: 'settings.fields', reference: control.settingId, path: [...current.path, 'control', 'settingId'] });
      }
      if (Array.isArray(node.children)) node.children.forEach((child, index) => stack.push({ node: child, path: [...current.path, 'children', index] }));
    }
    return found;
  }
  if (family === 'ui.settingsPages') {
    const references: PluginContributionReferenceCandidateV2[] = [
      { targetFamily: 'ui.renderers', reference: value.renderer, path: ['renderer'] },
    ];
    const group = value.group && typeof value.group === 'object'
      ? value.group as Readonly<Record<string, unknown>>
      : null;
    if (group?.kind === 'plugin' && group.localId !== undefined) {
      references.push({
        targetFamily: 'ui.settingsGroups',
        reference: group.localId,
        path: ['group', 'localId'],
      });
    }
    return references;
  }
  return [];
}

function declaresAgentExternalSessions(value: Readonly<Record<string, unknown>>): boolean {
  const capabilities = value.capabilities && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities)
    ? value.capabilities as Readonly<Record<string, unknown>>
    : null;
  const surfaces = value.surfaces && typeof value.surfaces === 'object' && !Array.isArray(value.surfaces)
    ? value.surfaces as Readonly<Record<string, unknown>>
    : null;
  return Array.isArray(capabilities?.surfaces)
    && capabilities.surfaces.includes('externalSessions')
    && surfaces?.externalSession !== null
    && typeof surfaces?.externalSession === 'object'
    && !Array.isArray(surfaces.externalSession);
}

function declaresAgentSessions(value: Readonly<Record<string, unknown>>): boolean {
  const capabilities = value.capabilities
    && typeof value.capabilities === 'object'
    && !Array.isArray(value.capabilities)
    ? value.capabilities as Readonly<Record<string, unknown>>
    : null;
  return capabilities?.sessions !== null
    && typeof capabilities?.sessions === 'object'
    && !Array.isArray(capabilities.sessions);
}

function requiresFamilyRegistration(family: string, value: Readonly<Record<string, unknown>>, demand: PluginContributionCatalogEntryV2['activationDemand']): boolean {
  const availability = value.availability;
  const disabledWhen = availability && typeof availability === 'object' && !Array.isArray(availability)
    ? (availability as Readonly<Record<string, unknown>>).disabledWhen
    : null;
  const staticallyDisabled = disabledWhen && typeof disabledWhen === 'object' && !Array.isArray(disabledWhen)
    && (disabledWhen as Readonly<Record<string, unknown>>).fact === 'plugin.enabled'
    && (disabledWhen as Readonly<Record<string, unknown>>).operator === 'equals'
    && (disabledWhen as Readonly<Record<string, unknown>>).value === true;
  if (staticallyDisabled) return false;
  if (demand === 'registration') return true;
  if (demand !== 'conditional') return false;
  if (family === 'agents') {
    const runtimeIsCustom = (value.runtime as Readonly<{ kind?: unknown }> | undefined)?.kind === 'custom';
    return runtimeIsCustom || declaresAgentExternalSessions(value);
  }
  if (family === 'events') return value.kind === 'subscription';
  // §3.6.1: only the dynamic arm of the discriminated resource family has a
  // runtime producer. A packaged resource is package bytes and gets no
  // registration right (§8.1).
  if (family === 'resources') return isDynamicPluginResourceContributionV2(value);
  if (family === 'promptAssets') return value.adapterDescriptor !== undefined;
  if (family === 'composerAttachments') {
    return readComposerAttachmentRuntimeRegistrationFieldsV1(value.runtime).length > 0;
  }
  if (family === 'providers') {
    return declaresProviderManagedRuntimeV1(value)
      || readContributedProviderCatalogParserIds(value).length > 0;
  }
  return false;
}

/**
 * Whether a Provider contribution declares the managed-runtime arm. This is the
 * single owner of that reading: registration rights, activation correspondence,
 * and projection all consume it rather than re-testing the discriminant.
 */
export function declaresProviderManagedRuntimeV1(
  value: Readonly<Record<string, unknown>>,
): boolean {
  const managedRuntime = value.managedRuntime;
  return managedRuntime !== null
    && typeof managedRuntime === 'object'
    && !Array.isArray(managedRuntime)
    && (managedRuntime as Readonly<Record<string, unknown>>).kind === 'managed';
}

/**
 * The catalog wire formats a Provider contribution declares but the host does
 * not bundle. Each one must be contributed by the declaring plugin's `providers`
 * activation, so declaring one is what earns the registration right.
 */
export function readContributedProviderCatalogParserIds(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const contributed = new Set<string>();
  const catalog = value.catalog;
  if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    const probes = (catalog as Readonly<Record<string, unknown>>).probes;
    if (Array.isArray(probes)) {
      for (const probe of probes) {
        if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
        const parser = (probe as Readonly<Record<string, unknown>>).parser;
        if (typeof parser !== 'string' || isBundledProviderCatalogParserV1(parser)) continue;
        contributed.add(parser);
      }
    }
  }
  // The command catalog fallback names a format from the same contributed
  // vocabulary, so declaring one there earns the same registration right as
  // declaring one on an HTTP probe.
  const discovery = value.discovery;
  if (discovery && typeof discovery === 'object' && !Array.isArray(discovery)) {
    const fallback = (discovery as Readonly<Record<string, unknown>>).catalogFallback;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      const parser = (fallback as Readonly<Record<string, unknown>>).parser;
      if (typeof parser === 'string' && !isBundledProviderCommandCatalogParserV1(parser)) {
        contributed.add(parser);
      }
    }
  }
  return Object.freeze([...contributed].sort());
}

function createCatalogAdapters(input: Readonly<{
  manifestKey: string;
  schema: z.ZodTypeAny;
  identityField: string | null;
  identityKind: PluginContributionCatalogEntryV2['identityKind'];
  consumer: string;
  platforms: PluginContributionCatalogEntryV2['platforms'];
  requiresRegistration(value: Readonly<Record<string, unknown>>): boolean;
  projectPlatforms?(value: Readonly<Record<string, unknown>>): PluginContributionCatalogEntryV2['platforms'];
  readEntries?(contributes: Readonly<Record<string, unknown>>): readonly unknown[];
}>): Pick<PluginContributionCatalogEntryV2, 'readEntries' | 'canonicalize' | 'projectJsonSchema' | 'conflictKey' | 'merge' | 'projectIntrospection'> {
  const readEntries = input.readEntries ?? ((contributes) => readManifestKeyEntries(contributes, input.manifestKey));
  const conflictKey = (value: Readonly<Record<string, unknown>>): string | null => {
    if (input.identityField === null) return null;
    const identity = value[input.identityField];
    return typeof identity === 'string' ? identity : null;
  };
  return {
    readEntries,
    canonicalize: (value) => input.schema.parse(value),
    projectJsonSchema: () => Object.freeze(input.schema.toJSONSchema({
      io: 'input',
      unrepresentable: 'any',
    })),
    conflictKey,
    merge: (existing, incoming) => {
      const current = existing && typeof existing === 'object' ? conflictKey(existing as Readonly<Record<string, unknown>>) : null;
      const next = incoming && typeof incoming === 'object' ? conflictKey(incoming as Readonly<Record<string, unknown>>) : null;
      return current !== null && current === next
        ? Object.freeze({ ok: false as const, code: 'plugin_contribution_conflict' as const })
        : Object.freeze({ ok: true as const, value: incoming });
    },
    projectIntrospection: (value, lifecycle = { status: 'normalized' }) => Object.freeze({
      localId: input.identityKind === 'localId' ? conflictKey(value) : null,
      family: input.manifestKey,
      consumer: input.consumer, platforms: input.projectPlatforms?.(value) ?? input.platforms,
      registration: input.requiresRegistration(value) ? 'required' as const : 'notRequired' as const,
      status: lifecycle.status,
      ...(lifecycle.status === 'unavailable' && lifecycle.reason
        ? { unavailableReason: lifecycle.reason }
        : {}),
    }),
  };
}

type PluginContributionCatalogEntryDefinitionV2 = Omit<PluginContributionCatalogEntryV2,
  'registrationHost' | 'runtimeRegistrationHost' | 'runtimeRegistrationTarget' | 'runtimeRegistrationFamily' | 'lifecycleStages' | 'readEntries' | 'canonicalize' | 'projectJsonSchema' | 'conflictKey' | 'merge' | 'projectIntrospection'> &
  Readonly<{
    registrationHost?: Exclude<PluginContributionCatalogEntryV2['registrationHost'], null>;
    runtimeRegistrationHost?: (value: Readonly<Record<string, unknown>>) => 'daemon' | 'client' | null;
    runtimeRegistrationTarget?: (value: Readonly<Record<string, unknown>>) => PluginContributionRegistrationTarget | null;
    runtimeRegistrationFamily?: (value: Readonly<Record<string, unknown>>) => string;
    projectPlatforms?: (value: Readonly<Record<string, unknown>>) => PluginContributionCatalogEntryV2['platforms'];
    readEntries?: (contributes: Readonly<Record<string, unknown>>) => readonly unknown[];
  }>;
function defineCatalogEntry(input: PluginContributionCatalogEntryDefinitionV2): PluginContributionCatalogEntryV2 {
  if ((input.registrationHost === 'discriminated' || input.registrationHost === 'client')
    && !input.runtimeRegistrationTarget) {
    throw new Error(`Contribution family '${input.manifestKey}' must resolve its client runtime registration target`);
  }
  const runtimeRegistrationTarget = input.runtimeRegistrationTarget ?? (() => (
    input.allowedRuntimeRegistration === null
      ? null
      : Object.freeze({ realm: 'daemon' as const })
  ));
  return Object.freeze({
    ...input,
    registrationHost: input.allowedRuntimeRegistration === null
      ? null
      : input.registrationHost ?? 'daemon',
    runtimeRegistrationHost: input.runtimeRegistrationHost ?? ((value) => runtimeRegistrationTarget(value)?.realm ?? null),
    runtimeRegistrationTarget,
    runtimeRegistrationFamily: input.runtimeRegistrationFamily ?? (() => input.manifestKey),
    lifecycleStages: PLUGIN_CONTRIBUTION_LIFECYCLE_STAGES_V2,
    ...createCatalogAdapters(input),
  });
}

export const PLUGIN_CONTRIBUTION_CATALOG_V2: readonly PluginContributionCatalogEntryV2[] = Object.freeze([
  ...PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((descriptor): PluginContributionCatalogEntryV2 => {
    const policy = FAMILY_POLICIES[descriptor.family];
    return defineCatalogEntry({
      manifestKey: descriptor.family,
      schema: descriptor.schema,
      ...policy,
      identityKind: descriptor.family === 'providers' ? 'delegatedDomain' : 'localId',
      references: Object.freeze([...(REFERENCE_RULES[descriptor.family] ?? [])]),
      extractReferences(value) {
        return Object.freeze([
          ...extractRuleReferences(value, REFERENCE_RULES[descriptor.family] ?? []),
          ...extractNestedReferences(descriptor.family, value),
        ]);
      },
      requiresRegistration(value) { return requiresFamilyRegistration(descriptor.family, value, policy.activationDemand); },
      ...(descriptor.family === 'actions'
        ? {
            runtimeRegistrationTarget: (value: Readonly<Record<string, unknown>>) => {
              const parsed = PluginActionDeclaredExecutionV2Schema.safeParse(value.execution);
              if (!parsed.success) return null;
              if (parsed.data.target === 'daemon') return Object.freeze({ realm: 'daemon' as const });
              return Object.freeze({
                realm: 'client' as const,
                artifactId: parsed.data.client.artifactId,
                modulePath: parsed.data.client.modulePath,
                exportName: parsed.data.client.exportName,
                platforms: Object.freeze([...parsed.data.platforms]),
              });
            },
          }
        : descriptor.family === 'voiceProviders'
        ? {
            runtimeRegistrationTarget: (value: Readonly<Record<string, unknown>>) => {
              if (value.kind === 'speech') return Object.freeze({ realm: 'daemon' as const });
              const client = value.client;
              const platforms = value.platforms;
              if (!client || typeof client !== 'object' || Array.isArray(client) || !Array.isArray(platforms)) return null;
              const clientRecord = client as Readonly<Record<string, unknown>>;
              if (typeof clientRecord.artifactId !== 'string'
                || typeof clientRecord.modulePath !== 'string'
                || typeof clientRecord.exportName !== 'string'
                || !platforms.every((platform): platform is PluginContributionClientPlatform => (
                  platform === 'web' || platform === 'ios' || platform === 'android'
                ))) return null;
              return Object.freeze({
                realm: 'client' as const,
                artifactId: clientRecord.artifactId,
                modulePath: clientRecord.modulePath,
                exportName: clientRecord.exportName,
                platforms: Object.freeze([...platforms]),
              });
            },
            runtimeRegistrationFamily: () => descriptor.family,
            projectPlatforms: (value: Readonly<Record<string, unknown>>) => {
              const parsed = descriptor.schema.safeParse(value);
              return parsed.success ? parsed.data.platforms : policy.platforms;
            },
          }
        : {}),
      fixtureId: `all-family:${descriptor.family}`,
    });
  }),
  defineCatalogEntry({
    manifestKey: 'settings.fields', schema: PluginSettingFieldV2Schema, identityField: 'id', identityKind: 'nestedId',
    disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null,
    references: Object.freeze([]), extractReferences: () => [], requiresRegistration: () => false,
    consumer: 'settings-service', platforms: ALL_PLATFORMS, fixtureId: 'all-family:settings.fields',
    readEntries: (contributes) => readManifestKeyEntries(contributes, 'settings').flatMap((settings) => (
      settings && typeof settings === 'object' && Array.isArray((settings as Readonly<Record<string, unknown>>).fields)
        ? (settings as Readonly<{ fields: readonly unknown[] }>).fields
        : []
    )),
  }),
  defineCatalogEntry({ manifestKey: 'ui.views', schema: PluginUiViewV2Schema, identityField: 'id', identityKind: 'localId', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([{ field: 'renderer', targetFamily: 'ui.renderers' }, { field: 'fallbackRenderers', targetFamily: 'ui.renderers', many: true }]), extractReferences: (value: Readonly<Record<string, unknown>>) => Object.freeze([
    ...extractRuleReferences(value, [{ field: 'renderer', targetFamily: 'ui.renderers' }, { field: 'fallbackRenderers', targetFamily: 'ui.renderers', many: true }]),
    ...extractNestedReferences('ui.views', value),
  ]), requiresRegistration: () => false, consumer: 'ui-surface-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.views' }),
  defineCatalogEntry({ manifestKey: 'ui.renderers', schema: PluginUiRendererV2Schema, identityField: 'id', identityKind: 'localId', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([]), extractReferences: (value: Readonly<Record<string, unknown>>) => extractNestedReferences('ui.renderers', value), requiresRegistration: () => false, consumer: 'ui-renderer-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.renderers' }),
  defineCatalogEntry({ manifestKey: 'ui.settingsGroups', schema: PluginUiSettingsGroupV1Schema, identityField: 'id', identityKind: 'localId', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([]), extractReferences: () => [], requiresRegistration: () => false, consumer: 'settings-catalog', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.settingsGroups' }),
  defineCatalogEntry({ manifestKey: 'ui.settingsPages', schema: PluginUiSettingsPageV1Schema, identityField: 'id', identityKind: 'localId', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([{ field: 'renderer', targetFamily: 'ui.renderers' }, { field: 'group', targetFamily: 'ui.settingsGroups' }]), extractReferences: (value: Readonly<Record<string, unknown>>) => extractNestedReferences('ui.settingsPages', value), requiresRegistration: () => false, consumer: 'settings-catalog', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.settingsPages' }),
  defineCatalogEntry({ manifestKey: 'ui.translations', schema: PluginUiTranslationBundleV2Schema, identityField: 'locale', identityKind: 'locale', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([]), extractReferences: () => [], requiresRegistration: () => false, consumer: 'ui-i18n-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.translations' }),
  defineCatalogEntry({
    manifestKey: 'mcp.servers', schema: PluginMcpServerContributionV1Schema,
    identityField: 'id', identityKind: 'localId', activationDemand: 'declarative', projectionFamily: 'mcp',
    allowedRuntimeRegistration: 'mcp', references: Object.freeze([]), consumer: 'host.mcp',
    extractReferences: (value: Readonly<Record<string, unknown>>) => extractNestedReferences('mcp.servers', value),
    requiresRegistration: (value: Readonly<Record<string, unknown>>) => value.kind === 'dynamic',
    platforms: ALL_PLATFORMS, fixtureId: 'all-family:mcp.servers',
    disposition: 'reshaped',
  }),
  defineCatalogEntry({
    manifestKey: 'mcp.discoverySources', schema: PluginMcpDiscoverySourceContributionV1Schema,
    identityField: 'id', identityKind: 'localId', activationDemand: 'registration', projectionFamily: 'mcp',
    allowedRuntimeRegistration: 'mcp', references: Object.freeze([]), consumer: 'host.mcp',
    extractReferences: () => [],
    requiresRegistration: () => true,
    platforms: ALL_PLATFORMS, fixtureId: 'all-family:mcp.discoverySources',
    disposition: 'reshaped',
  }),
]);

export function getPluginContributionCatalogEntryV2(
  manifestKey: string,
): PluginContributionCatalogEntryV2 | null {
  return PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === manifestKey) ?? null;
}

export function listPluginProjectionFamilyIdsV2(
  catalog: readonly PluginContributionCatalogEntryV2[] = PLUGIN_CONTRIBUTION_CATALOG_V2,
): readonly string[] {
  return Object.freeze([
    ...new Set(catalog.flatMap((entry) => entry.projectionFamily ? [entry.projectionFamily] : [])),
  ]);
}

export function assertPluginProjectionFamilyIdsV2(
  actualFamilyIds: readonly string[],
  catalog: readonly PluginContributionCatalogEntryV2[] = PLUGIN_CONTRIBUTION_CATALOG_V2,
): void {
  const expectedFamilyIds = listPluginProjectionFamilyIdsV2(catalog);
  const duplicateFamilyIds = actualFamilyIds.filter((family, index) => actualFamilyIds.indexOf(family) !== index);
  const missingFamilyIds = expectedFamilyIds.filter((family) => !actualFamilyIds.includes(family));
  const extraFamilyIds = actualFamilyIds.filter((family) => !expectedFamilyIds.includes(family));
  if (duplicateFamilyIds.length > 0 || missingFamilyIds.length > 0 || extraFamilyIds.length > 0) {
    throw new Error([
      'Plugin projection families do not match the contribution catalog',
      ...(duplicateFamilyIds.length > 0 ? [`duplicate: ${[...new Set(duplicateFamilyIds)].join(', ')}`] : []),
      ...(missingFamilyIds.length > 0 ? [`missing: ${missingFamilyIds.join(', ')}`] : []),
      ...(extraFamilyIds.length > 0 ? [`extra: ${extraFamilyIds.join(', ')}`] : []),
    ].join('; '));
  }
}

function readManifestKeyEntries(contributes: Readonly<Record<string, unknown>>, manifestKey: string): readonly unknown[] {
  let current: unknown = contributes;
  for (const segment of manifestKey.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return [];
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return Array.isArray(current) ? current : [];
}

export function derivePluginContributionRegistrationRights(
  contributes: Readonly<Record<string, unknown>>,
): readonly PluginContributionRegistrationRight[] {
  return derivePluginContributionRegistrationRightsForHost(contributes);
}

function derivePluginContributionRegistrationRightsForHost(
  contributes: Readonly<Record<string, unknown>>,
  host?: Exclude<PluginContributionCatalogEntryV2['registrationHost'], null>,
  clientTarget?: Readonly<{
    artifactId: string;
    modulePath: string;
    exportName: string;
    platform: PluginContributionClientPlatform;
  }>,
): readonly PluginContributionRegistrationRight[] {
  return Object.freeze(PLUGIN_CONTRIBUTION_CATALOG_V2.flatMap((entry) => (
    entry.readEntries(contributes).flatMap((value) => {
      if (!value || typeof value !== 'object' || !entry.requiresRegistration(value as Readonly<Record<string, unknown>>)) return [];
      const record = value as Readonly<Record<string, unknown>>;
      const target = entry.runtimeRegistrationTarget(record);
      if (target === null || (host !== undefined && target.realm !== host)) return [];
      if (clientTarget !== undefined && (
        target.realm !== 'client'
        || target.artifactId !== clientTarget.artifactId
        || target.modulePath !== clientTarget.modulePath
        || target.exportName !== clientTarget.exportName
        || !target.platforms.includes(clientTarget.platform)
      )) return [];
      const localId = entry.identityField === null ? null : (value as Readonly<Record<string, unknown>>)[entry.identityField];
      const family = entry.runtimeRegistrationFamily(record);
      if (typeof localId !== 'string') return [];
      if (entry.manifestKey === 'connectedAccountDescriptors') {
        return [{
          family,
          localId,
          target,
          connectedAccountDescriptorDeclaration:
            record as PluginConnectedAccountDescriptorContributionV2,
        }];
      }
      if (entry.manifestKey === 'voiceProviders') {
        return [{
          family,
          localId,
          target,
          voiceProviderDeclaration: record as VoiceProviderContribution,
        }];
      }
      if (entry.manifestKey === 'promptAssets') {
        const promptAssetDescriptor = record.adapterDescriptor;
        return promptAssetDescriptor && typeof promptAssetDescriptor === 'object'
          ? [{ family, localId, target, promptAssetDescriptor: promptAssetDescriptor as PromptAssetTypeDescriptorV1 }]
          : [];
      }
      if (entry.manifestKey === 'composerAttachments') {
        const fields = readComposerAttachmentRuntimeRegistrationFieldsV1(record.runtime);
        return fields.length === 0 ? [] : [{ family, localId, target, requiredFields: fields }];
      }
      if (entry.manifestKey === 'providers') {
        return [{
          family,
          localId,
          target,
          providerArms: Object.freeze({
            managedRuntime: declaresProviderManagedRuntimeV1(record),
            catalogParserIds: readContributedProviderCatalogParserIds(record),
          }),
        }];
      }
      if (entry.manifestKey !== 'agents') return [{ family, localId, target }];
      const fields: ('factory' | 'sessionRunnerFactory' | 'externalSessions')[] = [];
      if ((record.runtime as Readonly<{ kind?: unknown }> | undefined)?.kind === 'custom') {
        fields.push('factory');
        if (declaresAgentSessions(record)) fields.push('sessionRunnerFactory');
      }
      if (declaresAgentExternalSessions(record)) fields.push('externalSessions');
      return [{ family, localId, target, requiredFields: Object.freeze(fields) }];
    })
  )));
}

/**
 * Runtime registrations executed by the daemon plugin host. Client-owned
 * registrations such as web Voice providers are activated from their declared
 * client artifact and must not manufacture a daemon lifecycle merely to make
 * that registration reachable.
 */
export function derivePluginDaemonContributionRegistrationRights(
  contributes: Readonly<Record<string, unknown>>,
): readonly PluginContributionRegistrationRight[] {
  return derivePluginContributionRegistrationRightsForHost(contributes, 'daemon');
}

/**
 * Registration rights assigned to one exact client activation entry. A client
 * module receives no rights belonging to another artifact, module, export, or
 * platform even when both entries are declared by the same plugin.
 */
export function derivePluginClientContributionRegistrationRights(
  contributes: Readonly<Record<string, unknown>>,
  target: Readonly<{
    artifactId: string;
    modulePath: string;
    exportName: string;
    platform: PluginContributionClientPlatform;
  }>,
): readonly PluginContributionRegistrationRight[] {
  return derivePluginContributionRegistrationRightsForHost(contributes, 'client', target);
}

export function listPluginContributionIdentities(
  contributes: Readonly<Record<string, unknown>>,
): readonly Readonly<{ family: string; localId: string }>[] {
  return Object.freeze(PLUGIN_CONTRIBUTION_CATALOG_V2.flatMap((entry) => (
    entry.identityField === null || entry.identityKind !== 'localId' ? [] : entry.readEntries(contributes).flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const localId = (value as Readonly<Record<string, unknown>>)[entry.identityField!];
      return typeof localId === 'string' ? [{ family: entry.manifestKey, localId }] : [];
    })
  )));
}

export function listDeclaredPluginContributionFamilies(
  contributes: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.freeze(PLUGIN_CONTRIBUTION_CATALOG_V2
    .filter((entry) => entry.readEntries(contributes).length > 0)
    .map((entry) => entry.manifestKey));
}
