import {
  PluginManifestV2Schema,
  readHookRegistrationV1,
  type AgentDefinitionV1,
  type BackendSurfaceDeclarationV1,
  type InstallableDependencyDescriptor,
  type PluginAgentContributionV2,
  type PluginAgentSettingsContributionV1,
  type PluginActionContributionV2,
  type PluginBrowserActionContributionV1,
  type PluginBrowserTargetContributionV1,
  type PluginCommandContributionV2,
  type PluginExecutionRunProfileContributionV2,
  type PluginEventContributionV1,
  type PluginHookContributionV2,
  type PluginHostedWebContributionV1,
  type PluginEmbeddedWebBundleContributionV1,
  type PluginLifecycleHandlerContributionV2,
  type ParsedPluginManifestV2,
  type PluginMcpContributesV1,
  type PluginNotificationCategoryContributionV2,
  type PluginNotificationChannelContributionV2,
  type PluginRequestInterceptorContributionV1,
  type PluginResourceContributionV2,
  type PluginReactNativeBundleContributionV1,
  type PluginSessionHeaderActionDescriptorV1,
  type PluginSettingsContributionV2,
  type PluginStructuredMessageDescriptorV1,
  type PluginSurfacePlacementDescriptorV1,
  type PluginSystemToolContributionV1,
  type PluginToolContributionV2,
  type PluginUiArtifactContributionV1,
  type PluginUiDescriptorContributionV2,
  type PluginUiTranslationsContributionV1,
  type ScmBackendContribution,
  type ScmHostingProviderContribution,
} from '@happier-dev/protocol';

import type { CanonicalPluginAgentRuntimeDefinition, CanonicalPluginManifest } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeHookContributionInput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (value.kind === 'hook') {
    const { kind, ...hookRegistration } = value;
    const normalized = readHookRegistrationV1(hookRegistration) ?? hookRegistration;
    return {
      kind,
      ...normalized,
    };
  }

  return readHookRegistrationV1(value) ?? value;
}

function toCanonicalAgentRuntimeContribution(
  contribution: PluginAgentContributionV2,
): CanonicalPluginAgentRuntimeDefinition {
  const {
    runtime,
    ...backend
  } = contribution;
  const surfaceHandlers = (contribution as Readonly<{ surfaceHandlers?: unknown }>).surfaceHandlers;

  return Object.freeze({
    ...backend,
    agentId: contribution.id,
    runtimeKind: runtime.kind,
    surfaceHandlers: Object.freeze(Array.isArray(surfaceHandlers)
      ? [...surfaceHandlers] as readonly BackendSurfaceDeclarationV1[]
      : []),
    runtime,
  }) as unknown as CanonicalPluginAgentRuntimeDefinition;
}

function toCanonicalAgentContribution(agent: PluginAgentContributionV2): AgentDefinitionV1 {
  return Object.freeze({
    ...agent,
    ownedBackendIds: Object.freeze([...((agent as Readonly<{ ownedBackendIds?: readonly string[] }>).ownedBackendIds ?? [agent.id])]),
  }) as unknown as AgentDefinitionV1;
}

export function normalizeManifestHookRegistrations(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const contributes = input.contributes;
  if (isRecord(contributes) && Array.isArray(contributes.hooks)) {
    return {
      ...input,
      contributes: {
        ...contributes,
        hooks: contributes.hooks.map((entry) => normalizeHookContributionInput(entry)),
      },
    };
  }
  return input;
}

function toCanonicalPluginManifestFromV2(manifest: ParsedPluginManifestV2): CanonicalPluginManifest {
  const source = (manifest as ParsedPluginManifestV2 & { source?: CanonicalPluginManifest['source'] }).source;
  const contributes = manifest.contributes as Readonly<{
    agents?: readonly PluginAgentContributionV2[];
    actions?: readonly PluginActionContributionV2[];
    tools?: readonly PluginToolContributionV2[];
    commands?: readonly PluginCommandContributionV2[];
    resources?: readonly PluginResourceContributionV2[];
    uiDescriptors?: readonly PluginUiDescriptorContributionV2[];
    uiTranslations?: readonly PluginUiTranslationsContributionV1[];
    structuredMessages?: readonly PluginStructuredMessageDescriptorV1[];
    sessionHeaderActions?: readonly PluginSessionHeaderActionDescriptorV1[];
    surfacePlacements?: readonly PluginSurfacePlacementDescriptorV1[];
    hostedWeb?: readonly PluginHostedWebContributionV1[];
    embeddedWebBundles?: readonly PluginEmbeddedWebBundleContributionV1[];
    reactNativeBundles?: readonly PluginReactNativeBundleContributionV1[];
    uiArtifacts?: readonly PluginUiArtifactContributionV1[];
    browserTargets?: readonly PluginBrowserTargetContributionV1[];
    browserActions?: readonly PluginBrowserActionContributionV1[];
    settings?: readonly PluginSettingsContributionV2[];
    notifications?: readonly PluginNotificationCategoryContributionV2[];
    notificationChannels?: readonly PluginNotificationChannelContributionV2[];
    events?: readonly PluginEventContributionV1[];
    executionRunProfiles?: readonly PluginExecutionRunProfileContributionV2[];
    mcp?: PluginMcpContributesV1;
    scmHostingProviders?: readonly ScmHostingProviderContribution[];
    scmBackends?: readonly ScmBackendContribution[];
    managedDependencies?: readonly InstallableDependencyDescriptor[];
    agentSettings?: readonly PluginAgentSettingsContributionV1[];
    systemTools?: readonly PluginSystemToolContributionV1[];
    requestInterceptors?: readonly PluginRequestInterceptorContributionV1[];
    hooks?: readonly PluginHookContributionV2[];
    lifecycleHandlers?: readonly PluginLifecycleHandlerContributionV2[];
  }>;

  return Object.freeze({
    schemaVersion: 2,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    engines: Object.freeze({
      happier: manifest.engines.happier,
    }),
    activationEvents: Object.freeze([...manifest.activationEvents]),
    uses: Object.freeze([...manifest.uses]),
    entrypoints: Object.freeze({
      main: manifest.entrypoints.main,
      ...(manifest.entrypoints.dev ? { dev: manifest.entrypoints.dev } : {}),
    }),
    permissions: Object.freeze([...manifest.permissions.required]),
    optionalPermissions: Object.freeze([...manifest.permissions.optional]),
    ...(source ? { source } : {}),
    ...(manifest.marketplace ? { marketplace: manifest.marketplace } : {}),
    contributes: Object.freeze({
      agents: Object.freeze((contributes.agents ?? []).map(toCanonicalAgentContribution)),
      agentRuntimes: Object.freeze((contributes.agents ?? []).map(toCanonicalAgentRuntimeContribution)),
      actions: Object.freeze([...(contributes.actions ?? [])]),
      tools: Object.freeze([...(contributes.tools ?? [])]),
      commands: Object.freeze([...(contributes.commands ?? [])]),
      resources: Object.freeze([...(contributes.resources ?? [])]),
      uiDescriptors: Object.freeze([...(contributes.uiDescriptors ?? [])]),
      uiTranslations: Object.freeze([...(contributes.uiTranslations ?? [])]),
      structuredMessages: Object.freeze([...(contributes.structuredMessages ?? [])]),
      sessionHeaderActions: Object.freeze([...(contributes.sessionHeaderActions ?? [])]),
      surfacePlacements: Object.freeze([...(contributes.surfacePlacements ?? [])]),
      hostedWeb: Object.freeze([...(contributes.hostedWeb ?? [])]),
      embeddedWebBundles: Object.freeze([...(contributes.embeddedWebBundles ?? [])]),
      reactNativeBundles: Object.freeze([...(contributes.reactNativeBundles ?? [])]),
      uiArtifacts: Object.freeze([...(contributes.uiArtifacts ?? [])]),
      browserTargets: Object.freeze([...(contributes.browserTargets ?? [])]),
      browserActions: Object.freeze([...(contributes.browserActions ?? [])]),
      settings: Object.freeze([...(contributes.settings ?? [])]),
      notifications: Object.freeze([...(contributes.notifications ?? [])]),
      notificationChannels: Object.freeze([...(contributes.notificationChannels ?? [])]),
      events: Object.freeze([...(contributes.events ?? [])]),
      executionRunProfiles: Object.freeze([...(contributes.executionRunProfiles ?? [])]),
      mcp: Object.freeze({
        servers: Object.freeze([...(contributes.mcp?.servers ?? [])]),
        discoveryProviders: Object.freeze([...(contributes.mcp?.discoveryProviders ?? [])]),
      }),
      scmHostingProviders: Object.freeze([...(contributes.scmHostingProviders ?? [])]),
      scmBackends: Object.freeze([...(contributes.scmBackends ?? [])]),
      managedDependencies: Object.freeze([...(contributes.managedDependencies ?? [])]),
      agentSettings: Object.freeze([...(contributes.agentSettings ?? [])]),
      systemTools: Object.freeze([...(contributes.systemTools ?? [])]),
      requestInterceptors: Object.freeze([...(contributes.requestInterceptors ?? [])]),
      hooks: Object.freeze([...(contributes.hooks ?? [])]),
      lifecycleHandlers: Object.freeze([...(contributes.lifecycleHandlers ?? [])]),
    }),
  });
}

export function readCanonicalPluginManifest(input: unknown): CanonicalPluginManifest | null {
  const normalizedInput = normalizeManifestHookRegistrations(input);

  const parsedV2 = PluginManifestV2Schema.safeParse(normalizedInput);
  if (parsedV2.success) {
    return toCanonicalPluginManifestFromV2(parsedV2.data);
  }

  return null;
}

export function normalizePluginManifestSourceForArtifact(input: unknown): ParsedPluginManifestV2 | null {
  const normalizedInput = normalizeManifestHookRegistrations(input);
  const parsedV2 = PluginManifestV2Schema.safeParse(normalizedInput);
  return parsedV2.success ? parsedV2.data : null;
}
