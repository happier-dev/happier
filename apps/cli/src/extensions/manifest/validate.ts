import { extname } from 'node:path';

import {
  isHookHandlerTargetV1,
} from '@happier-dev/protocol';
import { compareVersions } from '@happier-dev/cli-common/update';

import { configuration } from '../../configuration';

import type { PluginCompatibilityDiagnostic } from '../diagnostics/types';
import { isSupportedBackendRuntimeAdapterOperation } from './adapters';
import { readCanonicalPluginManifest } from './normalize';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readUnsupportedPluginTargetDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  if (!isRecord(input)) {
    return [];
  }

  const targets = input.targets;
  if (!isRecord(targets)) {
    return [];
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  for (const targetKey of ['uiDescriptor', 'serverDescriptor'] as const) {
    if (!Object.prototype.hasOwnProperty.call(targets, targetKey)) {
      continue;
    }

    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Plugin target '${targetKey}' is unsupported by the CLI runtime`,
    });
  }

  return diagnostics;
}

function readUnsupportedBackendRuntimeAdapterTargetDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  if (!isRecord(input)) {
    return [];
  }

  const contributions = input.contributions;
  const backends = Array.isArray(contributions)
    ? contributions.filter((entry) => isRecord(entry) && entry.kind === 'backend')
    : isRecord(contributions) && Array.isArray(contributions.backends)
      ? contributions.backends
      : [];
  if (backends.length === 0) {
    return [];
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  for (const backendDefinition of backends) {
    if (!isRecord(backendDefinition)) {
      continue;
    }

    const runtimeAdapters = backendDefinition.runtimeAdapters;
    if (!Array.isArray(runtimeAdapters)) {
      continue;
    }

    const backendId = typeof backendDefinition.id === 'string' && backendDefinition.id.trim().length > 0
      ? backendDefinition.id.trim()
      : 'unknown';

    for (const runtimeAdapter of runtimeAdapters) {
      if (!isRecord(runtimeAdapter)) {
        continue;
      }

      const handler = runtimeAdapter.handler;
      if (!isRecord(handler)) {
        continue;
      }

      const handlerTarget = typeof handler.target === 'string' ? handler.target : 'unknown';
      if (handlerTarget === 'daemon') {
        continue;
      }

      const runtimeAdapterId = typeof runtimeAdapter.id === 'string' && runtimeAdapter.id.trim().length > 0
        ? runtimeAdapter.id.trim()
        : 'unknown';
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin backend '${backendId}' runtime adapter '${runtimeAdapterId}' uses unsupported handler target '${handlerTarget}'`,
      });
    }
  }

  return diagnostics;
}

function readUnsupportedHookTargetDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  if (!isRecord(input)) {
    return [];
  }

  const contributions = input.contributions;
  const hooks = Array.isArray(contributions)
    ? contributions.filter((entry) => isRecord(entry) && entry.kind === 'hook')
    : isRecord(contributions) && Array.isArray(contributions.hooks)
      ? contributions.hooks
      : [];
  if (hooks.length === 0) {
    return [];
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  for (const hookRegistration of hooks) {
    if (!isRecord(hookRegistration)) {
      continue;
    }

    const handler = hookRegistration.handler;
    if (!isRecord(handler)) {
      continue;
    }

    if (isHookHandlerTargetV1(handler.target)) {
      continue;
    }

    const hookId = typeof hookRegistration.id === 'string' && hookRegistration.id.trim().length > 0
      ? hookRegistration.id.trim()
      : 'unknown';
    const handlerTarget = typeof handler.target === 'string' ? handler.target : 'unknown';
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Plugin hook '${hookId}' uses unsupported hook handler target '${handlerTarget}'`,
    });
  }

  return diagnostics;
}

function pushDuplicateIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  values: readonly string[],
  kind: 'provider' | 'backend' | 'action' | 'tool' | 'command' | 'resource' | 'ui descriptor' | 'hook' | 'lifecycle handler',
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Duplicate ${kind} id: ${value}`,
      });
      continue;
    }
    seen.add(value);
  }
}

function pushDuplicateRuntimeAdapterIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const backend of manifest.contributions.backends) {
    const seen = new Set<string>();
    for (const runtimeAdapter of backend.runtimeAdapters) {
      if (seen.has(runtimeAdapter.id)) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Duplicate runtime adapter id for backend '${backend.id}': ${runtimeAdapter.id}`,
        });
        continue;
      }
      seen.add(runtimeAdapter.id);
    }
  }
}

function pushDuplicateRuntimeAdapterOperationDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const backend of manifest.contributions.backends) {
    const seen = new Set<string>();
    for (const runtimeAdapter of backend.runtimeAdapters) {
      const operationKey = `${runtimeAdapter.kind}:${runtimeAdapter.operation}`;
      if (seen.has(operationKey)) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Duplicate runtime adapter operation for backend '${backend.id}': ${operationKey}`,
        });
        continue;
      }
      seen.add(operationKey);
    }
  }
}

function pushUnsupportedRuntimeAdapterOperationIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  // Runtime-adapter operations are the stable plugin-facing ABI names.
  // Protocol parsing stays additive; host semantic validation fails closed when
  // the current runtime does not execute the declared operation for that kind.
  for (const backend of manifest.contributions.backends) {
    for (const runtimeAdapter of backend.runtimeAdapters) {
      if (
        !isSupportedBackendRuntimeAdapterOperation({
          kind: runtimeAdapter.kind,
          operation: runtimeAdapter.operation,
        })
      ) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Plugin backend '${backend.id}' uses unsupported runtime adapter operation '${runtimeAdapter.operation}' for kind '${runtimeAdapter.kind}'`,
        });
      }
    }
  }
}

function pushUnsupportedDaemonEntryDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  const daemonEntry = manifest.targets.daemon?.entry;
  if (!daemonEntry) {
    return;
  }

  const extension = extname(daemonEntry).toLowerCase();
  if (SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extension)) {
    return;
  }

  diagnostics.push({
    code: 'plugin_manifest_semantic_invalid',
    message: `Plugin daemon target entry '${daemonEntry}' uses unsupported extension '${extension || '<none>'}'`,
  });
}

function parseStableSemver(version: string): string | null {
  const normalized = String(version ?? '').trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-.]+)?$/.exec(normalized);
  if (!match) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function isCompatibleHappierEngineRange(range: string, currentVersion: string): boolean {
  const normalizedRange = String(range ?? '').trim();
  if (!normalizedRange) {
    return false;
  }

  const normalizedCurrentVersion = parseStableSemver(currentVersion);
  if (!normalizedCurrentVersion) {
    return false;
  }

  if (!normalizedRange.startsWith('^')) {
    const normalizedExactRange = parseStableSemver(normalizedRange);
    return normalizedExactRange !== null && compareVersions(normalizedCurrentVersion, normalizedExactRange) === 0;
  }

  const baseVersion = parseStableSemver(normalizedRange.slice(1));
  if (!baseVersion) {
    return false;
  }

  const [majorRaw, minorRaw, patchRaw] = baseVersion.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  if (![major, minor, patch].every((value) => Number.isInteger(value))) {
    return false;
  }

  const upperBound =
    major > 0
      ? `${major + 1}.0.0`
      : minor > 0
        ? `0.${minor + 1}.0`
        : `0.0.${patch + 1}`;

  return compareVersions(normalizedCurrentVersion, baseVersion) >= 0
    && compareVersions(normalizedCurrentVersion, upperBound) < 0;
}

export function validatePluginManifest(input: unknown): PluginManifestValidationResult {
  const unsupportedTargetDiagnostics = [
    ...readUnsupportedPluginTargetDiagnostics(input),
    ...readUnsupportedBackendRuntimeAdapterTargetDiagnostics(input),
    ...readUnsupportedHookTargetDiagnostics(input),
  ];
  if (unsupportedTargetDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: unsupportedTargetDiagnostics,
    };
  }

  const manifest = readCanonicalPluginManifest(input);
  if (!manifest) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_invalid',
          message: 'Plugin manifest does not match the canonical extension manifest contract',
        },
      ],
    };
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  const hasExecutableContributions =
    manifest.contributions.backends.length > 0
    || manifest.contributions.actions.length > 0
    || manifest.contributions.tools.length > 0
    || manifest.contributions.commands.length > 0
    || manifest.contributions.hooks.length > 0
    || manifest.contributions.lifecycleHandlers.length > 0;

  if (hasExecutableContributions && !manifest.targets.daemon) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: 'Daemon target is required for executable extension contributions',
    });
  }

  if (!isCompatibleHappierEngineRange(manifest.engines.happier, configuration.currentCliVersion)) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Plugin manifest requires happier ${manifest.engines.happier} but current CLI version is ${configuration.currentCliVersion}`,
    });
  }

  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.providers.map((definition) => definition.id), 'provider');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.backends.map((definition) => definition.id), 'backend');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.actions.map((definition) => definition.id), 'action');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.tools.map((definition) => definition.id), 'tool');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.commands.map((definition) => definition.id), 'command');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.resources.map((definition) => definition.id), 'resource');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.uiDescriptors.map((definition) => definition.id), 'ui descriptor');
  pushDuplicateIdDiagnostics(diagnostics, manifest.contributions.hooks.map((registration) => registration.id), 'hook');
  pushDuplicateIdDiagnostics(
    diagnostics,
    manifest.contributions.lifecycleHandlers.flatMap((definition) => (
      typeof definition.id === 'string' && definition.id.trim().length > 0 ? [definition.id.trim()] : []
    )),
    'lifecycle handler',
  );
  pushDuplicateRuntimeAdapterIdDiagnostics(diagnostics, manifest);
  pushDuplicateRuntimeAdapterOperationDiagnostics(diagnostics, manifest);
  pushUnsupportedRuntimeAdapterOperationIdDiagnostics(diagnostics, manifest);
  pushUnsupportedDaemonEntryDiagnostics(diagnostics, manifest);

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
    };
  }

  return {
    ok: true,
    manifest,
  };
}
