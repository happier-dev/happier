import {
  PluginManifestV2Schema,
  readHookRegistrationV1,
  type AgentDefinitionV1,
  type BackendSurfaceDeclarationV1,
  type InstallableDependencyDescriptor,
  type PluginActionContributionV2,
  type PluginBackendContributionV2,
  type PluginCommandContributionV2,
  type PluginExecutionRunProfileContributionV2,
  type PluginEventContributionV1,
  type PluginHookContributionV2,
  type PluginLifecycleHandlerContributionV2,
  type ParsedPluginManifestV2,
  type PluginMcpContributesV1,
  type PluginNotificationCategoryContributionV2,
  type PluginNotificationChannelContributionV2,
  type PluginRequestInterceptorContributionV1,
  type PluginResourceContributionV2,
  type PluginSystemToolContributionV1,
  type PluginToolContributionV2,
  type PluginUiDescriptorContributionV2,
  type ScmBackendContribution,
  type ScmHostingProviderContribution,
  type ProviderDefinitionV1,
} from '@happier-dev/protocol';

import type { CanonicalPluginBackendDefinition, CanonicalPluginManifest } from './types';

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

function toCanonicalBackendContribution(
  contribution: PluginBackendContributionV2,
): CanonicalPluginBackendDefinition {
  const {
    engine,
    agentId,
    catalogAgentId,
    ...backend
  } = contribution;
  const surfaceHandlers = (contribution as Readonly<{ surfaceHandlers?: unknown }>).surfaceHandlers;

  return Object.freeze({
    ...backend,
    providerId: agentId,
    providerAgentId: catalogAgentId,
    runtimeKind: engine.kind,
    surfaceHandlers: Object.freeze(Array.isArray(surfaceHandlers)
      ? [...surfaceHandlers] as readonly BackendSurfaceDeclarationV1[]
      : []),
    engine,
  }) as unknown as CanonicalPluginBackendDefinition;
}

function toCanonicalProviderContribution(agent: AgentDefinitionV1): ProviderDefinitionV1 {
  const {
    agentCliRuntime,
    catalogAgentId,
    ...provider
  } = agent;

  return Object.freeze({
    ...provider,
    providerAgentId: catalogAgentId,
    ...(agentCliRuntime ? { agentCliRuntime } : {}),
  }) as ProviderDefinitionV1;
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
    agents?: readonly AgentDefinitionV1[];
    backends?: readonly PluginBackendContributionV2[];
    actions?: readonly PluginActionContributionV2[];
    tools?: readonly PluginToolContributionV2[];
    commands?: readonly PluginCommandContributionV2[];
    resources?: readonly PluginResourceContributionV2[];
    uiDescriptors?: readonly PluginUiDescriptorContributionV2[];
    notifications?: readonly PluginNotificationCategoryContributionV2[];
    notificationChannels?: readonly PluginNotificationChannelContributionV2[];
    events?: readonly PluginEventContributionV1[];
    executionRunProfiles?: readonly PluginExecutionRunProfileContributionV2[];
    mcp?: PluginMcpContributesV1;
    scmHostingProviders?: readonly ScmHostingProviderContribution[];
    scmBackends?: readonly ScmBackendContribution[];
    installables?: readonly InstallableDependencyDescriptor[];
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
    runtime: Object.freeze({
      apiVersion: manifest.runtime.apiVersion,
      capabilities: Object.freeze([...manifest.runtime.capabilities]),
    }),
    targets: Object.freeze({
      ...(manifest.targets.daemon ? {
        daemon: Object.freeze({
          entry: manifest.targets.daemon.entry,
        }),
      } : {}),
    }),
    permissions: Object.freeze([...manifest.capabilities.permissions]),
    optionalPermissions: Object.freeze([...manifest.capabilities.optionalPermissions]),
    ...(source ? { source } : {}),
    ...(manifest.marketplace ? { marketplace: manifest.marketplace } : {}),
    contributes: Object.freeze({
      providers: Object.freeze((contributes.agents ?? []).map(toCanonicalProviderContribution)),
      backends: Object.freeze((contributes.backends ?? []).map(toCanonicalBackendContribution)),
      actions: Object.freeze([...(contributes.actions ?? [])]),
      tools: Object.freeze([...(contributes.tools ?? [])]),
      commands: Object.freeze([...(contributes.commands ?? [])]),
      resources: Object.freeze([...(contributes.resources ?? [])]),
      uiDescriptors: Object.freeze([...(contributes.uiDescriptors ?? [])]),
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
      installables: Object.freeze([...(contributes.installables ?? [])]),
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
