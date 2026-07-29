import type { z } from 'zod';

import { PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 } from './v2.js';
import {
  PluginMcpDiscoveryProviderContributionV1Schema,
  PluginMcpServerContributionV1Schema,
} from './mcp.js';
import { PluginUiRendererV2Schema, PluginUiTranslationBundleV2Schema, PluginUiViewV2Schema } from './ui/v2.js';
import { PluginSettingFieldV2Schema } from './settings.js';

export type PluginContributionReferenceRuleV2 = Readonly<{
  field: string;
  targetFamily: string;
  many?: boolean;
}>;
export type PluginContributionReferenceCandidateV2 = Readonly<{
  targetFamily: string;
  reference: unknown;
  path: readonly (string | number)[];
}>;
export type PluginContributionRegistrationRight = Readonly<{
  family: string;
  localId: string;
  requiredFields?: readonly ('factory' | 'externalSessions')[];
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
  stability: 'stable' | 'experimental' | 'delegated';
  activationDemand: 'none' | 'declarative' | 'registration' | 'conditional';
  projectionFamily: string | null;
  allowedRuntimeRegistration: string | null;
  registrationHost: 'daemon' | 'client' | 'discriminated' | null;
  runtimeRegistrationHost(value: Readonly<Record<string, unknown>>): 'daemon' | 'client' | null;
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
    stability: PluginContributionCatalogEntryV2['stability'];
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
  commands: [{ field: 'action', targetFamily: 'actions' }],
  tools: [{ field: 'action', targetFamily: 'actions' }],
  structuredMessages: [
    { field: 'renderer', targetFamily: 'ui.renderers' },
    { field: 'actions', targetFamily: 'actions', many: true },
  ],
  sessionHeaderActions: [{ field: 'action', targetFamily: 'actions' }],
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
});

const ALL_PLATFORMS = Object.freeze(['cli', 'web', 'ios', 'android', 'desktop'] as const);
const CLI_PLATFORMS = Object.freeze(['cli', 'desktop'] as const);
type CoreFamily = typeof PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2[number]['family'];
type FamilyPolicy = Pick<PluginContributionCatalogEntryV2,
  'identityField' | 'stability' | 'disposition' | 'activationDemand' | 'projectionFamily' | 'allowedRuntimeRegistration' | 'consumer' | 'platforms'> &
  Readonly<{ registrationHost?: Exclude<PluginContributionCatalogEntryV2['registrationHost'], null> }>;
const FAMILY_POLICIES = {
  agents: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'agents', consumer: 'agent-runtime', platforms: CLI_PLATFORMS },
  providers: { identityField: 'id', stability: 'delegated', disposition: 'delegated', activationDemand: 'none', projectionFamily: 'providers', allowedRuntimeRegistration: null, consumer: 'providers-first-class', platforms: CLI_PLATFORMS },
  actions: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'actions', consumer: 'action-dispatch', platforms: ALL_PLATFORMS },
  commands: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'cli-commands', platforms: CLI_PLATFORMS },
  tools: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'agent-tools', platforms: CLI_PLATFORMS },
  resources: { identityField: 'id', stability: 'experimental', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'resource-service', platforms: ALL_PLATFORMS },
  structuredMessages: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'structured-message-host', platforms: ALL_PLATFORMS },
  sessionHeaderActions: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, consumer: 'session-header-host', platforms: ALL_PLATFORMS },
  browserTargets: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginBrowser', allowedRuntimeRegistration: null, consumer: 'browser-host', platforms: ALL_PLATFORMS },
  browserActions: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginBrowser', allowedRuntimeRegistration: null, consumer: 'browser-host', platforms: ALL_PLATFORMS },
  settings: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'settings-service', platforms: ALL_PLATFORMS },
  events: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'conditional', projectionFamily: null, allowedRuntimeRegistration: 'events', consumer: 'event-broker', platforms: CLI_PLATFORMS },
  executionRunProfiles: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'execution-run-host', platforms: CLI_PLATFORMS },
  notifications: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'notification-service', platforms: ALL_PLATFORMS },
  notificationChannels: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'notifications', consumer: 'notification-service', platforms: CLI_PLATFORMS },
  scmHostingProviders: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'scmHostingProviders', allowedRuntimeRegistration: 'scm', consumer: 'scm-host', platforms: CLI_PLATFORMS },
  scmBackends: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'scmBackends', allowedRuntimeRegistration: 'scm', consumer: 'scm-host', platforms: CLI_PLATFORMS },
  connectedAccountDescriptors: { identityField: 'id', stability: 'experimental', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: 'connectedAccounts', allowedRuntimeRegistration: 'connectedAccounts', consumer: 'connected-account-service', platforms: CLI_PLATFORMS },
  managedDependencies: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'managedDependencies', allowedRuntimeRegistration: null, consumer: 'managed-dependency-service', platforms: CLI_PLATFORMS },
  systemTools: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'system-tool-service', platforms: CLI_PLATFORMS },
  promptAssets: { identityField: 'id', stability: 'experimental', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null, consumer: 'prompt-service', platforms: CLI_PLATFORMS },
  hooks: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'hooks', consumer: 'hook-dispatch', platforms: CLI_PLATFORMS },
  requestInterceptors: { identityField: 'id', stability: 'stable', disposition: 'reshaped', activationDemand: 'registration', projectionFamily: null, allowedRuntimeRegistration: 'interceptors', consumer: 'fetch-service', platforms: CLI_PLATFORMS },
  voiceModelPacks: { identityField: 'id', stability: 'experimental', disposition: 'retained', activationDemand: 'none', projectionFamily: 'voiceModelPacks', allowedRuntimeRegistration: null, consumer: 'voice-model-catalog', platforms: ALL_PLATFORMS },
  voiceProviders: { identityField: 'id', stability: 'experimental', disposition: 'retained', activationDemand: 'registration', projectionFamily: 'voiceProviders', allowedRuntimeRegistration: 'voiceProviders', registrationHost: 'discriminated', consumer: 'voice-host', platforms: Object.freeze(['web', 'ios', 'android'] as const) },
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
    const stack: Array<{ node: unknown; path: (string | number)[] }> = [{ node: value.root, path: ['root'] }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!current.node || typeof current.node !== 'object') continue;
      const node = current.node as Record<string, unknown>;
      if (node.kind === 'action') found.push({ targetFamily: 'actions', reference: node.action, path: [...current.path, 'action'] });
      if (node.kind === 'field') {
        const control = node.control && typeof node.control === 'object' ? node.control as Record<string, unknown> : null;
        if (typeof control?.settingId === 'string') found.push({ targetFamily: 'settings.fields', reference: control.settingId, path: [...current.path, 'control', 'settingId'] });
      }
      if (Array.isArray(node.children)) node.children.forEach((child, index) => stack.push({ node: child, path: [...current.path, 'children', index] }));
    }
    return found;
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
  return false;
}

function createCatalogAdapters(input: Readonly<{
  manifestKey: string;
  schema: z.ZodTypeAny;
  identityField: string | null;
  identityKind: PluginContributionCatalogEntryV2['identityKind'];
  stability: PluginContributionCatalogEntryV2['stability'];
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
      family: input.manifestKey, stability: input.stability,
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
  'registrationHost' | 'runtimeRegistrationHost' | 'runtimeRegistrationFamily' | 'lifecycleStages' | 'readEntries' | 'canonicalize' | 'projectJsonSchema' | 'conflictKey' | 'merge' | 'projectIntrospection'> &
  Readonly<{
    registrationHost?: Exclude<PluginContributionCatalogEntryV2['registrationHost'], null>;
    runtimeRegistrationHost?: (value: Readonly<Record<string, unknown>>) => 'daemon' | 'client' | null;
    runtimeRegistrationFamily?: (value: Readonly<Record<string, unknown>>) => string;
    projectPlatforms?: (value: Readonly<Record<string, unknown>>) => PluginContributionCatalogEntryV2['platforms'];
    readEntries?: (contributes: Readonly<Record<string, unknown>>) => readonly unknown[];
  }>;
function defineCatalogEntry(input: PluginContributionCatalogEntryDefinitionV2): PluginContributionCatalogEntryV2 {
  if (input.registrationHost === 'discriminated' && !input.runtimeRegistrationHost) {
    throw new Error(`Contribution family '${input.manifestKey}' must resolve its discriminated runtime registration host`);
  }
  return Object.freeze({
    ...input,
    registrationHost: input.allowedRuntimeRegistration === null
      ? null
      : input.registrationHost ?? 'daemon',
    runtimeRegistrationHost: input.runtimeRegistrationHost ?? (() => (
      input.allowedRuntimeRegistration === null
        ? null
        : input.registrationHost === 'client' ? 'client' : 'daemon'
    )),
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
      ...(descriptor.family === 'voiceProviders'
        ? {
            runtimeRegistrationHost: (value: Readonly<Record<string, unknown>>) => (
              value.kind === 'speech' ? 'daemon' as const : 'client' as const
            ),
            runtimeRegistrationFamily: (value: Readonly<Record<string, unknown>>) => (
              value.kind === 'speech' ? 'voiceProviders.speech' : descriptor.family
            ),
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
    stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: null, allowedRuntimeRegistration: null,
    references: Object.freeze([]), extractReferences: () => [], requiresRegistration: () => false,
    consumer: 'settings-service', platforms: ALL_PLATFORMS, fixtureId: 'all-family:settings.fields',
    readEntries: (contributes) => readManifestKeyEntries(contributes, 'settings').flatMap((settings) => (
      settings && typeof settings === 'object' && Array.isArray((settings as Readonly<Record<string, unknown>>).fields)
        ? (settings as Readonly<{ fields: readonly unknown[] }>).fields
        : []
    )),
  }),
  defineCatalogEntry({ manifestKey: 'ui.views', schema: PluginUiViewV2Schema, identityField: 'id', identityKind: 'localId', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([{ field: 'renderer', targetFamily: 'ui.renderers' }, { field: 'fallbackRenderers', targetFamily: 'ui.renderers', many: true }]), extractReferences: (value: Readonly<Record<string, unknown>>) => extractRuleReferences(value, [{ field: 'renderer', targetFamily: 'ui.renderers' }, { field: 'fallbackRenderers', targetFamily: 'ui.renderers', many: true }]), requiresRegistration: () => false, consumer: 'ui-surface-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.views' }),
  defineCatalogEntry({ manifestKey: 'ui.renderers', schema: PluginUiRendererV2Schema, identityField: 'id', identityKind: 'localId', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([]), extractReferences: (value: Readonly<Record<string, unknown>>) => extractNestedReferences('ui.renderers', value), requiresRegistration: () => false, consumer: 'ui-renderer-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.renderers' }),
  defineCatalogEntry({ manifestKey: 'ui.translations', schema: PluginUiTranslationBundleV2Schema, identityField: 'locale', identityKind: 'locale', stability: 'stable', disposition: 'reshaped', activationDemand: 'none', projectionFamily: 'pluginUi', allowedRuntimeRegistration: null, references: Object.freeze([]), extractReferences: () => [], requiresRegistration: () => false, consumer: 'ui-i18n-host', platforms: ALL_PLATFORMS, fixtureId: 'all-family:ui.translations' }),
  defineCatalogEntry({
    manifestKey: 'mcp.servers', schema: PluginMcpServerContributionV1Schema,
    identityField: 'id', identityKind: 'localId', stability: 'stable', activationDemand: 'declarative', projectionFamily: 'mcp',
    allowedRuntimeRegistration: 'mcp', references: Object.freeze([]), consumer: 'host.mcp',
    extractReferences: (value: Readonly<Record<string, unknown>>) => extractNestedReferences('mcp.servers', value),
    requiresRegistration: (value: Readonly<Record<string, unknown>>) => value.kind === 'dynamic',
    platforms: ALL_PLATFORMS, fixtureId: 'all-family:mcp.servers',
    disposition: 'reshaped',
  }),
  defineCatalogEntry({
    manifestKey: 'mcp.discoveryProviders', schema: PluginMcpDiscoveryProviderContributionV1Schema,
    identityField: 'id', identityKind: 'localId', stability: 'stable', activationDemand: 'registration', projectionFamily: 'mcp',
    allowedRuntimeRegistration: 'mcp', references: Object.freeze([]), consumer: 'host.mcp',
    extractReferences: () => [],
    requiresRegistration: () => true,
    platforms: ALL_PLATFORMS, fixtureId: 'all-family:mcp.discoveryProviders',
    disposition: 'reshaped',
  }),
]);

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
): readonly PluginContributionRegistrationRight[] {
  return Object.freeze(PLUGIN_CONTRIBUTION_CATALOG_V2.flatMap((entry) => (
    entry.readEntries(contributes).flatMap((value) => {
      if (!value || typeof value !== 'object' || !entry.requiresRegistration(value as Readonly<Record<string, unknown>>)) return [];
      const record = value as Readonly<Record<string, unknown>>;
      const registrationHost = entry.runtimeRegistrationHost(record);
      if (host !== undefined && registrationHost !== host) return [];
      const localId = entry.identityField === null ? null : (value as Readonly<Record<string, unknown>>)[entry.identityField];
      const family = entry.runtimeRegistrationFamily(record);
      if (typeof localId !== 'string') return [];
      if (entry.manifestKey !== 'agents') return [{ family, localId }];
      const fields: ('factory' | 'externalSessions')[] = [];
      if ((record.runtime as Readonly<{ kind?: unknown }> | undefined)?.kind === 'custom') fields.push('factory');
      if (declaresAgentExternalSessions(record)) fields.push('externalSessions');
      return [{ family, localId, requiredFields: Object.freeze(fields) }];
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
