import {
  ExtensionManifestV2Schema,
  readHookRegistrationV1,
  type ExtensionManifestV2,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';

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

export function normalizeManifestHookRegistrations(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const contributions = input.contributions;
  if (Array.isArray(contributions)) {
    return {
      ...input,
      contributions: contributions.map((entry) => normalizeHookContributionInput(entry)),
    };
  }
  return input;
}

function toCanonicalPluginManifestFromV2(manifest: ExtensionManifestV2): CanonicalPluginManifest {
  const source = (manifest as ExtensionManifestV2 & { source?: CanonicalPluginManifest['source'] }).source;
  const providers: Array<CanonicalPluginManifest['contributions']['providers'][number]> = [];
  const backends: Array<CanonicalPluginManifest['contributions']['backends'][number]> = [];
  const actions: Array<CanonicalPluginManifest['contributions']['actions'][number]> = [];
  const tools: Array<CanonicalPluginManifest['contributions']['tools'][number]> = [];
  const commands: Array<CanonicalPluginManifest['contributions']['commands'][number]> = [];
  const resources: Array<CanonicalPluginManifest['contributions']['resources'][number]> = [];
  const uiDescriptors: Array<CanonicalPluginManifest['contributions']['uiDescriptors'][number]> = [];
  const hooks: Array<CanonicalPluginManifest['contributions']['hooks'][number]> = [];
  const lifecycleHandlers: Array<CanonicalPluginManifest['contributions']['lifecycleHandlers'][number]> = [];

  for (const contribution of manifest.contributions) {
    switch (contribution.kind) {
      case 'provider':
        providers.push(contribution);
        break;
      case 'backend':
        backends.push(contribution);
        break;
      case 'action':
        actions.push(contribution);
        break;
      case 'tool':
        tools.push(contribution);
        break;
      case 'command':
        commands.push(contribution);
        break;
      case 'resource':
        resources.push(contribution);
        break;
      case 'uiDescriptor':
        uiDescriptors.push(contribution);
        break;
      case 'hook':
        hooks.push(contribution);
        break;
      case 'lifecycleHandler':
        lifecycleHandlers.push(contribution);
        break;
      default:
        contribution satisfies never;
    }
  }

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
    permissions: Object.freeze([...manifest.permissions]),
    ...(source ? { source } : {}),
    ...(manifest.marketplace ? { marketplace: manifest.marketplace } : {}),
    contributions: Object.freeze({
      providers: Object.freeze(providers),
      backends: Object.freeze(backends),
      actions: Object.freeze(actions),
      tools: Object.freeze(tools),
      commands: Object.freeze(commands),
      resources: Object.freeze(resources),
      uiDescriptors: Object.freeze(uiDescriptors),
      hooks: Object.freeze(hooks),
      lifecycleHandlers: Object.freeze(lifecycleHandlers),
    }),
  });
}

export function readCanonicalPluginManifest(input: unknown): CanonicalPluginManifest | null {
  const normalizedInput = normalizeManifestHookRegistrations(input);

  const parsedV2 = ExtensionManifestV2Schema.safeParse(normalizedInput);
  if (parsedV2.success) {
    return toCanonicalPluginManifestFromV2(parsedV2.data);
  }

  return null;
}
