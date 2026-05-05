import {
  PluginManifestV2Schema,
  readHookRegistrationV1,
  type AgentDefinitionV1,
  type BackendRuntimeAdapterV1,
  type PluginActionContributionV2,
  type PluginBackendContributionV2,
  type PluginCommandContributionV2,
  type PluginHookContributionV2,
  type PluginLifecycleHandlerContributionV2,
  type PluginManifestV2,
  type PluginNotificationCategoryContributionV2,
  type PluginNotificationChannelContributionV2,
  type PluginResourceContributionV2,
  type PluginToolContributionV2,
  type PluginUiDescriptorContributionV2,
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
  const runtimeCoreHooks = (contribution as Readonly<{ runtimeCoreHooks?: unknown }>).runtimeCoreHooks;

  return Object.freeze({
    ...backend,
    providerId: agentId,
    providerAgentId: catalogAgentId,
    runtimeKind: engine.kind,
    runtimeCoreHooks: Object.freeze(Array.isArray(runtimeCoreHooks)
      ? [...runtimeCoreHooks] as readonly BackendRuntimeAdapterV1[]
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
    providerCliRuntime: agentCliRuntime,
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

function toCanonicalPluginManifestFromV2(manifest: PluginManifestV2): CanonicalPluginManifest {
  const source = (manifest as PluginManifestV2 & { source?: CanonicalPluginManifest['source'] }).source;
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
    scmHostingProviders?: readonly ScmHostingProviderContribution[];
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
      scmHostingProviders: Object.freeze([...(contributes.scmHostingProviders ?? [])]),
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
