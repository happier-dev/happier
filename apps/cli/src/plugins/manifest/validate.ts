import { extname } from 'node:path';
import { createRequire } from 'node:module';

import {
  BackendSurfaceOperationCatalogV1,
  PluginManifestV2Schema,
  isHookHandlerTargetV1,
  isReservedHappierPluginId,
} from '@happier-dev/protocol';
import type { z } from 'zod';

import { configuration } from '../../configuration';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { isSupportedBackendSurfaceOperation } from './adapters';
import { normalizeManifestHookRegistrations, readCanonicalPluginManifest } from './normalize';
import type { CanonicalPluginManifest } from './types';

const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const require = createRequire(import.meta.url);

type SemverModule = Readonly<{
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, options?: Readonly<{ includePrerelease?: boolean }>): boolean;
}>;

// Boundary import: semver is CommonJS and does not expose project-local ESM types.
const semver = require('semver') as SemverModule;

export type PluginManifestValidationResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>;

export type PluginManifestValidationOptions = Readonly<{
  allowReservedHappierPluginId?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatManifestJsonPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return '<manifest>';
  }

  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === 'number') {
      return `${formatted}[${segment}]`;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      return formatted ? `${formatted}.${segment}` : segment;
    }

    const escaped = JSON.stringify(segment);
    return formatted ? `${formatted}[${escaped}]` : escaped;
  }, '');
}

function formatManifestSchemaIssue(issue: z.ZodIssue): PluginCompatibilityDiagnostic {
  return {
    code: 'plugin_manifest_invalid',
    message: `${formatManifestJsonPath(issue.path.filter((seg): seg is string | number => typeof seg !== 'symbol'))}: ${issue.message}`,
  };
}

function readManifestSchemaDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  const parsed = PluginManifestV2Schema.safeParse(normalizeManifestHookRegistrations(input));
  return parsed.success ? [] : parsed.error.issues.map(formatManifestSchemaIssue);
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

function readUnsupportedBackendSurfaceTargetDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  if (!isRecord(input)) {
    return [];
  }

  const contributes = input.contributes;
  const backends = Array.isArray(contributes)
    ? contributes.filter((entry) => isRecord(entry) && entry.kind === 'backend')
    : isRecord(contributes) && Array.isArray(contributes.agents)
      ? contributes.agents
      : [];
  if (backends.length === 0) {
    return [];
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  for (const backendDefinition of backends) {
    if (!isRecord(backendDefinition)) {
      continue;
    }

    const surfaceHandlers = backendDefinition.surfaceHandlers;
    if (!Array.isArray(surfaceHandlers)) {
      continue;
    }

      const backendId = typeof backendDefinition.id === 'string' && backendDefinition.id.trim().length > 0
      ? backendDefinition.id.trim()
      : 'unknown';

    for (const surfaceHandler of surfaceHandlers) {
      if (!isRecord(surfaceHandler)) {
        continue;
      }

      const handler = surfaceHandler.handler;
      if (!isRecord(handler)) {
        continue;
      }

      const handlerTarget = typeof handler.target === 'string' ? handler.target : 'unknown';
      if (handlerTarget === 'daemon') {
        continue;
      }

      const surfaceHandlerId = typeof surfaceHandler.id === 'string' && surfaceHandler.id.trim().length > 0
        ? surfaceHandler.id.trim()
        : 'unknown';
      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin backend '${backendId}' backend surface handler '${surfaceHandlerId}' uses unsupported handler target '${handlerTarget}'`,
      });
    }
  }

  return diagnostics;
}

function readUnsupportedHookTargetDiagnostics(input: unknown): PluginCompatibilityDiagnostic[] {
  if (!isRecord(input)) {
    return [];
  }

  const contributes = input.contributes;
  const hooks = Array.isArray(contributes)
    ? contributes.filter((entry) => isRecord(entry) && entry.kind === 'hook')
    : isRecord(contributes) && Array.isArray(contributes.hooks)
      ? contributes.hooks
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
  kind: 'agent' | 'agent runtime' | 'action' | 'tool' | 'command' | 'resource' | 'ui descriptor' | 'notification category' | 'notification channel' | 'event' | 'SCM hosting provider' | 'SCM backend' | 'managed dependency' | 'request interceptor' | 'hook' | 'lifecycle handler',
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

function readDefinitionIds(definitions: readonly unknown[]): readonly string[] {
  return definitions.flatMap((definition) => {
    if (!isRecord(definition)) {
      return [];
    }

    const id = definition.id;
    return typeof id === 'string' ? [id] : [];
  });
}

function pushMissingLifecycleHandlerIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const definition of manifest.contributes.lifecycleHandlers) {
    const hasId = typeof definition.id === 'string' && definition.id.trim().length > 0;
    if (hasId) {
      continue;
    }
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Lifecycle handler for event '${definition.event}' must declare a stable id`,
    });
  }
}

function pushDuplicateSurfaceHandlerIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const backend of manifest.contributes.agentRuntimes) {
    const seen = new Set<string>();
    for (const surfaceHandler of backend.surfaceHandlers) {
      if (seen.has(surfaceHandler.id)) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Duplicate backend surface handler id for backend '${backend.id}': ${surfaceHandler.id}`,
        });
        continue;
      }
      seen.add(surfaceHandler.id);
    }
  }
}

function pushDuplicateSurfaceHandlerOperationDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const backend of manifest.contributes.agentRuntimes) {
    const seen = new Set<string>();
    for (const surfaceHandler of backend.surfaceHandlers) {
      const operationKey = `${surfaceHandler.kind}:${surfaceHandler.operation}`;
      if (seen.has(operationKey)) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Duplicate backend surface handler operation for backend '${backend.id}': ${operationKey}`,
        });
        continue;
      }
      seen.add(operationKey);
    }
  }
}

function pushUnsupportedSurfaceHandlerOperationIdDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  // Backend-surface operations are the stable plugin-facing ABI names.
  // Protocol parsing stays additive; host semantic validation fails closed when
  // the current runtime does not execute the declared operation for that kind.
  for (const backend of manifest.contributes.agentRuntimes) {
    for (const surfaceHandler of backend.surfaceHandlers) {
      if (
        !isSupportedBackendSurfaceOperation({
          kind: surfaceHandler.kind,
          operation: surfaceHandler.operation,
        })
      ) {
        diagnostics.push({
          code: 'plugin_manifest_semantic_invalid',
          message: `Plugin backend '${backend.id}' uses unsupported backend surface operation '${surfaceHandler.operation}' for kind '${surfaceHandler.kind}'`,
        });
      }
    }
  }
}

function pushConditionalSurfaceAvailabilityDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  for (const backend of manifest.contributes.agentRuntimes) {
    const availabilityHandlerKinds = new Set(
      backend.surfaceHandlers
        .filter((surfaceHandler) => (
          surfaceHandler.operation === BackendSurfaceOperationCatalogV1[surfaceHandler.kind].evaluateAvailability
          && surfaceHandler.support !== 'unsupported'
          && surfaceHandler.handler.target === 'daemon'
        ))
        .map((surfaceHandler) => surfaceHandler.kind),
    );

    for (const surfaceHandler of backend.surfaceHandlers) {
      if (
        surfaceHandler.support !== 'conditional'
        || surfaceHandler.operation === BackendSurfaceOperationCatalogV1[surfaceHandler.kind].evaluateAvailability
      ) {
        continue;
      }

      if (availabilityHandlerKinds.has(surfaceHandler.kind)) {
        continue;
      }

      diagnostics.push({
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin backend '${backend.id}' declares conditional backend surface operation '${surfaceHandler.kind}:${surfaceHandler.operation}' without a daemon evaluateAvailability handler for surface '${surfaceHandler.kind}'`,
      });
    }
  }
}

function pushUnsupportedDaemonEntryDiagnostics(
  diagnostics: PluginCompatibilityDiagnostic[],
  manifest: CanonicalPluginManifest,
): void {
  const daemonEntry = manifest.entrypoints.main;
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

function isValidHappierEngineRange(range: string): boolean {
  return semver.validRange(String(range ?? '').trim()) !== null;
}

function isCompatibleHappierEngineRange(range: string, currentVersion: string): boolean {
  const normalizedRange = String(range ?? '').trim();
  if (!normalizedRange) {
    return false;
  }

  const normalizedCurrentVersion = semver.valid(String(currentVersion ?? '').trim());
  if (!normalizedCurrentVersion) {
    return false;
  }

  return semver.satisfies(normalizedCurrentVersion, normalizedRange, { includePrerelease: true });
}

export function validatePluginManifest(
  input: unknown,
  options: PluginManifestValidationOptions = {},
): PluginManifestValidationResult {
  const unsupportedTargetDiagnostics = [
    ...readUnsupportedPluginTargetDiagnostics(input),
    ...readUnsupportedBackendSurfaceTargetDiagnostics(input),
    ...readUnsupportedHookTargetDiagnostics(input),
  ];
  if (unsupportedTargetDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: unsupportedTargetDiagnostics,
    };
  }

  const schemaDiagnostics = readManifestSchemaDiagnostics(input);
  if (schemaDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: schemaDiagnostics,
    };
  }

  const manifest = readCanonicalPluginManifest(input);
  if (!manifest) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_invalid',
          message: 'Plugin manifest does not match the canonical plugin manifest contract',
        },
      ],
    };
  }

  const diagnostics: PluginCompatibilityDiagnostic[] = [];
  if (isReservedHappierPluginId(manifest.id) && options.allowReservedHappierPluginId !== true) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Plugin id '${manifest.id}' uses the reserved happier.* namespace`,
    });
  }

  const hasExecutableContributes =
    manifest.contributes.agents.length > 0
    || manifest.contributes.agentRuntimes.length > 0
    || manifest.contributes.actions.length > 0
    || manifest.contributes.tools.length > 0
    || manifest.contributes.commands.length > 0
    || (manifest.contributes.scmBackends ?? []).length > 0
    || (manifest.contributes.requestInterceptors ?? []).length > 0
    || manifest.contributes.hooks.length > 0
    || manifest.contributes.lifecycleHandlers.length > 0;

  if (hasExecutableContributes && !manifest.entrypoints.main) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: 'Entrypoint main is required for executable plugin contributes',
    });
  }

  if (!isValidHappierEngineRange(manifest.engines.happier)) {
    diagnostics.push({
      code: 'plugin_manifest_engine_range_invalid',
      message: `Plugin manifest engines.happier range '${manifest.engines.happier}' is not valid npm semver range syntax`,
    });
  } else if (!isCompatibleHappierEngineRange(manifest.engines.happier, configuration.currentCliVersion)) {
    diagnostics.push({
      code: 'plugin_manifest_semantic_invalid',
      message: `Plugin manifest requires happier ${manifest.engines.happier} but current CLI version is ${configuration.currentCliVersion}`,
    });
  }

  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.agents), 'agent');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.agentRuntimes), 'agent runtime');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.actions), 'action');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.tools), 'tool');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.commands), 'command');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.resources), 'resource');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.uiDescriptors), 'ui descriptor');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.notifications ?? []), 'notification category');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.notificationChannels ?? []), 'notification channel');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.events ?? []), 'event');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.scmHostingProviders ?? []), 'SCM hosting provider');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.scmBackends ?? []), 'SCM backend');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.managedDependencies ?? []), 'managed dependency');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.requestInterceptors ?? []), 'request interceptor');
  pushDuplicateIdDiagnostics(diagnostics, readDefinitionIds(manifest.contributes.hooks), 'hook');
  pushDuplicateIdDiagnostics(
    diagnostics,
    manifest.contributes.lifecycleHandlers.flatMap((definition) => (
      typeof definition.id === 'string' && definition.id.trim().length > 0 ? [definition.id.trim()] : []
    )),
    'lifecycle handler',
  );
  pushMissingLifecycleHandlerIdDiagnostics(diagnostics, manifest);
  pushDuplicateSurfaceHandlerIdDiagnostics(diagnostics, manifest);
  pushDuplicateSurfaceHandlerOperationDiagnostics(diagnostics, manifest);
  pushUnsupportedSurfaceHandlerOperationIdDiagnostics(diagnostics, manifest);
  pushConditionalSurfaceAvailabilityDiagnostics(diagnostics, manifest);
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
