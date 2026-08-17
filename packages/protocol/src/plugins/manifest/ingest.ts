import { PluginManifestV2Schema, type ParsedPluginManifestV2 } from './v2.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '../contributions/catalog.js';
import { isDynamicPluginResourceContributionV2 } from '../contributions/v2.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { isPluginDeclarativeDocumentContentTypeV1 } from '../contributions/ui/declarativeDocumentContentTypeV1.js';
import {
  isPluginTranscriptActivityContentTypeV1,
  MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
} from '../contributions/ui/transcriptActivities.js';
import {
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '../../automations/automationEventHistoryGapResetActionV1.js';

export type PluginManifestIngestionDiagnostic = Readonly<{
  code:
    | 'plugin_manifest_invalid_json'
    | 'plugin_manifest_invalid'
    | 'plugin_manifest_duplicate_contribution_id'
    | 'plugin_manifest_invalid_contribution_id'
    | 'plugin_manifest_dangling_reference'
    | 'plugin_manifest_wrong_family_reference';
  path?: readonly (string | number)[];
  message: string;
}>;

export type PluginManifestIngestionResult =
  | Readonly<{ ok: true; manifest: ParsedPluginManifestV2 }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestIngestionDiagnostic[] }>;

/**
 * Canonical human-readable rendering of one ingestion diagnostic.
 *
 * `path` is the only field that tells an author which manifest node failed, so every
 * surface that turns a diagnostic into a message must go through here rather than
 * reading `message` alone.
 */
export function formatPluginManifestIngestionDiagnostic(
  diagnostic: PluginManifestIngestionDiagnostic,
): string {
  const path = diagnostic.path && diagnostic.path.length > 0 ? `${diagnostic.path.join('.')}: ` : '';
  return `${path}${diagnostic.message}`;
}

export function formatPluginManifestIngestionDiagnostics(
  diagnostics: readonly PluginManifestIngestionDiagnostic[],
): string {
  return diagnostics.map(formatPluginManifestIngestionDiagnostic).join('; ');
}

export type PluginManifestSetReferenceResolutionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestIngestionDiagnostic[] }>;

// Private parser-recursion fail-safe, not an author-visible manifest quota.
const PLUGIN_MANIFEST_SCHEMA_STACK_SAFETY_DEPTH = 1_024;

/** Decodes the manifest's raw file bytes without silently replacing malformed UTF-8. */
export function decodePluginManifestUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

type DecodeResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; result: PluginManifestIngestionResult }>;

function hasReachableToJsonProperty(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (Object.getOwnPropertyDescriptor(current, 'toJSON') !== undefined) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function isPlainJsonValue(root: unknown): boolean {
  const activeAncestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit: boolean }> = [{ value: root, exit: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object') return false;
    if (frame.exit) {
      activeAncestors.delete(value);
      continue;
    }
    if (hasReachableToJsonProperty(value)) return false;
    if (activeAncestors.has(value)) return false;
    activeAncestors.add(value);
    stack.push({ value, exit: true });
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !('value' in property)) return false;
        stack.push({ value: property.value, exit: false });
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property) return false;
        // A non-enumerable own property cannot reach JSON output, whatever its
        // key type, so it cannot make the value non-serializable.
        if (!property.enumerable) continue;
        if (typeof key !== 'string') return false;
        if (!('value' in property)) return false;
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property) return false;
      if (!property.enumerable) continue;
      if (typeof key !== 'string') return false;
      if (!('value' in property)) return false;
      stack.push({ value: property.value, exit: false });
    }
  }
  return true;
}

function readJsonInput(input: unknown): DecodeResult {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    try {
      if (!isPlainJsonValue(input)) throw new TypeError('Value is not plain JSON.');
      const serialized = JSON.stringify(input);
      if (serialized === undefined) throw new TypeError('Value is not JSON serializable.');
      bytes = new TextEncoder().encode(serialized);
    } catch {
      return {
        ok: false,
        result: { ok: false, diagnostics: [{ code: 'plugin_manifest_invalid_json', message: 'Bundled plugin manifest must be JSON serializable.' }] },
      };
    }
  }
  try {
    return { ok: true, value: JSON.parse(decodePluginManifestUtf8(bytes)) as unknown };
  } catch {
    return {
      ok: false,
      result: { ok: false, diagnostics: [{ code: 'plugin_manifest_invalid_json', message: 'Plugin manifest is not valid UTF-8 JSON.' }] },
    };
  }
}

function isSafeForPluginManifestSchemaValidation(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > PLUGIN_MANIFEST_SCHEMA_STACK_SAFETY_DEPTH) return false;
    if (Array.isArray(current.value)) {
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const value of Object.values(current.value)) {
        stack.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function readCatalogEntries(contributes: Readonly<Record<string, unknown>>, manifestKey: string): readonly unknown[] {
  let current: unknown = contributes;
  for (const segment of manifestKey.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return [];
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return Array.isArray(current) ? current : [];
}

function isContributionLocalIdIssuePath(path: readonly PropertyKey[]): boolean {
  if (path[0] !== 'contributes') return false;
  return PLUGIN_CONTRIBUTION_CATALOG_V2.some((catalogEntry) => {
    if (catalogEntry.identityKind !== 'localId' || catalogEntry.identityField === null) return false;
    const familyPath = catalogEntry.manifestKey.split('.');
    if (path.length !== familyPath.length + 3) return false;
    if (!familyPath.every((segment, index) => path[index + 1] === segment)) return false;
    return typeof path[familyPath.length + 1] === 'number'
      && path[familyPath.length + 2] === catalogEntry.identityField;
  });
}

function readContributionIds(contributes: Readonly<Record<string, unknown>>): PluginManifestIngestionDiagnostic[] {
  const seen = new Map<string, string>();
  const nestedSeen = new Map<string, string>();
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    if (catalogEntry.identityField === null || !['localId', 'nestedId'].includes(catalogEntry.identityKind)) continue;
    const family = catalogEntry.manifestKey;
    const value = catalogEntry.readEntries(contributes);
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const localId = (entry as Readonly<Record<string, unknown>>)[catalogEntry.identityField!];
      if (typeof localId !== 'string') return;
      if (catalogEntry.identityKind === 'localId' && !PluginContributionLocalIdSchema.safeParse(localId).success) {
        diagnostics.push({
          code: 'plugin_manifest_invalid_contribution_id',
          path: ['contributes', ...family.split('.'), index, catalogEntry.identityField!],
          message: `Contribution local id '${localId}' does not match the canonical local-id grammar.`,
        });
        return;
      }
      const identityNamespace = catalogEntry.identityKind === 'nestedId' ? nestedSeen : seen;
      const prior = identityNamespace.get(localId);
      if (prior) {
        diagnostics.push({
          code: 'plugin_manifest_duplicate_contribution_id',
          path: ['contributes', ...family.split('.'), index, catalogEntry.identityField!],
          message: `Contribution local id '${localId}' is already declared by ${prior}.`,
        });
      } else {
        identityNamespace.set(localId, family);
      }
    });
  }
  return diagnostics;
}

type ManifestReferenceCandidate = Readonly<{
  targetFamily: string;
  reference: unknown;
  path: readonly (string | number)[];
}>;

function readHostAccessReferenceCandidates(manifest: ParsedPluginManifestV2): readonly ManifestReferenceCandidate[] {
  const candidates: ManifestReferenceCandidate[] = [];
  for (const [requirement, requests] of [
    ['required', manifest.hostAccess.required],
    ['optional', manifest.hostAccess.optional],
  ] as const) {
    requests.forEach((request, requestIndex) => {
      const root = ['hostAccess', requirement, requestIndex, 'scope'] as const;
      if (request.capability === 'network' || request.capability === 'network.client') {
        request.scope.targets.forEach((target, targetIndex) => {
          if (target.kind === 'connectedAccountOrigin') candidates.push({
            targetFamily: 'connectedAccountDescriptors', reference: target.service,
            path: [...root, 'targets', targetIndex, 'service'],
          });
          if (target.kind === 'scmProviderOrigin') candidates.push({
            targetFamily: 'scmHostingProviders', reference: target.provider,
            path: [...root, 'targets', targetIndex, 'provider'],
          });
        });
      }
      if (request.capability === 'process') {
        request.scope.executables.forEach((executable, executableIndex) => candidates.push({
          targetFamily: executable.kind === 'managedDependency' ? 'managedDependencies' : 'systemTools',
          reference: executable.id,
          path: [...root, 'executables', executableIndex, 'id'],
        }));
      }
      if (request.capability === 'connectedAccounts') {
        request.scope.serviceRefs.forEach((reference, referenceIndex) => candidates.push({
          targetFamily: 'connectedAccountDescriptors', reference,
          path: [...root, 'serviceRefs', referenceIndex],
        }));
      }
      if (request.capability === 'mcp') {
        request.scope.serverRefs.forEach((reference, referenceIndex) => candidates.push({
          targetFamily: 'mcp.servers', reference,
          path: [...root, 'serverRefs', referenceIndex],
        }));
        request.scope.discoverySourceRefs.forEach((reference, referenceIndex) => candidates.push({
          targetFamily: 'mcp.discoverySources', reference,
          path: [...root, 'discoverySourceRefs', referenceIndex],
        }));
      }
    });
  }
  return candidates;
}

function readReferenceDiagnostics(manifest: ParsedPluginManifestV2): PluginManifestIngestionDiagnostic[] {
  const contributes = manifest.contributes as Readonly<Record<string, unknown>>;
  const idsByFamily = new Map<string, Set<string>>();
  const allLocalIds = new Set<string>();
  idsByFamily.set('manifest.hostAccess', new Set([
    ...manifest.hostAccess.required.map((request) => request.id),
    ...manifest.hostAccess.optional.map((request) => request.id),
  ]));
  for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    const family = catalogEntry.manifestKey;
    const value = catalogEntry.readEntries(contributes);
    const ids = new Set<string>();
    for (const entry of value) {
      if (entry && typeof entry === 'object' && catalogEntry.identityField !== null
        && typeof (entry as Readonly<Record<string, unknown>>)[catalogEntry.identityField] === 'string') {
        const id = (entry as Readonly<Record<string, string>>)[catalogEntry.identityField];
        ids.add(id);
        allLocalIds.add(id);
      }
    }
    idsByFamily.set(family, ids);
  }
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    const entries = catalogEntry.readEntries(contributes);
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Readonly<Record<string, unknown>>;
      for (const candidate of catalogEntry.extractReferences(record)) {
        if (candidate.targetFamily.startsWith('generated.')) continue;
        const targetFamilies = candidate.targetFamilies ?? [candidate.targetFamily];
        const targetFamilyLabel = targetFamilies.join(' or ');
        const ref = candidate.reference;
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          const structured = ref as Readonly<Record<string, unknown>>;
          if (candidate.allowQualifiedCrossPlugin === false && structured.pluginId !== manifest.id) {
            diagnostics.push({
              code: 'plugin_manifest_dangling_reference',
              path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
              message: 'This declarative contribution reference must target the declaring plugin.',
            });
            continue;
          }
          if (structured.pluginId !== manifest.id) continue;
          if (candidate.allowQualifiedSamePlugin === true) {
            const localId = structured.localId;
            if (typeof localId === 'string' && targetFamilies.some((family) => idsByFamily.get(family)?.has(localId))) {
              continue;
            }
            diagnostics.push({
              code: typeof localId === 'string' && allLocalIds.has(localId)
                ? 'plugin_manifest_wrong_family_reference'
                : 'plugin_manifest_dangling_reference',
              path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
              message: `${catalogEntry.manifestKey} contribution references undeclared ${targetFamilyLabel} id '${String(localId)}'.`,
            });
            continue;
          }
          diagnostics.push({
            code: 'plugin_manifest_dangling_reference',
            path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
            message: `Same-plugin references must use a local id string rather than a structured self-reference.`,
          });
          continue;
        }
        if (typeof ref !== 'string' || targetFamilies.some((family) => idsByFamily.get(family)?.has(ref))) continue;
        diagnostics.push({
          code: allLocalIds.has(ref) ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
          path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
          message: `${catalogEntry.manifestKey} contribution references undeclared ${targetFamilyLabel} id '${ref}'.`,
        });
      }
    });
  }
  for (const candidate of readHostAccessReferenceCandidates(manifest)) {
    const ref = candidate.reference;
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      const structured = ref as Readonly<Record<string, unknown>>;
      if (structured.pluginId !== manifest.id) continue;
      diagnostics.push({
        code: 'plugin_manifest_dangling_reference',
        path: candidate.path,
        message: 'Same-plugin host-access references must use a local id string rather than a structured self-reference.',
      });
      continue;
    }
    if (typeof ref !== 'string' || idsByFamily.get(candidate.targetFamily)?.has(ref)) continue;
    diagnostics.push({
      code: allLocalIds.has(ref) ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
      path: candidate.path,
      message: `Host access references undeclared ${candidate.targetFamily} id '${ref}'.`,
    });
  }
  return diagnostics;
}

/**
 * Event Automation setup remains a declaration-to-declaration binding.  The
 * Event owns the source contract; the Action owns its executable result.  This
 * manifest owner proves their exact shared shape without activating either
 * contribution or giving a consumer an Action-search fallback.
 */
function readEventAutomationSetupActionDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const actionsById = new Map(manifest.contributes.actions.map((action) => [action.id, action] as const));
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.events.forEach((event, eventIndex) => {
    if (event.kind !== 'event') return;
    const source = event.automation?.source;
    const setupActionRef = source?.setupActionRef;
    if (!source || !setupActionRef || setupActionRef.pluginId !== manifest.id) return;
    const path = ['contributes', 'events', eventIndex, 'automation', 'source', 'setupActionRef'] as const;
    const action = actionsById.get(setupActionRef.localId);
    // Generic nested-reference diagnostics own missing and wrong-family refs.
    if (!action) return;
    if (!action.surfaces.includes('plugin')) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Event Automation setup Action '${setupActionRef.localId}' must declare the plugin surface.`,
      });
      return;
    }
    const expectedResultSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        v: { type: 'integer', const: 1 },
        sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
        sourceContractVersion: { type: 'integer', const: source.sourceContractVersion },
        sourceConfig: source.sourceConfigSchema,
        displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
    };
    if (hasExactCanonicalJsonSchema(action.resultSchema, expectedResultSchema)) {
      return;
    }
    diagnostics.push({
      code: 'plugin_manifest_invalid',
      path,
      message: `Event Automation setup Action '${setupActionRef.localId}' must declare the exact canonical setup-result schema.`,
    });
  });
  return diagnostics;
}

function hasExactCanonicalJsonSchema(actual: unknown, expected: unknown): boolean {
  return actual !== undefined
    && createCanonicalJsonSigningInput(actual) === createCanonicalJsonSigningInput(expected);
}

/**
 * The history-gap recovery remains an ordinary same-plugin Action. The Event
 * declaration binds its exact host-filled input and typed result before any
 * cold projection can expose a recovery handle.
 */
function readEventAutomationHistoryGapResetActionDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const actionsById = new Map(manifest.contributes.actions.map((action) => [action.id, action] as const));
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.events.forEach((event, eventIndex) => {
    if (event.kind !== 'event') return;
    const source = event.automation?.source;
    const actionRef = source?.historyGapResetActionRef;
    if (!source || !actionRef || actionRef.pluginId !== manifest.id) return;
    const path = ['contributes', 'events', eventIndex, 'automation', 'source', 'historyGapResetActionRef'] as const;
    const action = actionsById.get(actionRef.localId);
    // Generic nested-reference diagnostics own missing and wrong-family refs.
    if (!action) return;
    if (!action.surfaces.includes('plugin')) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Event Automation history-gap recovery Action '${actionRef.localId}' must declare the plugin surface.`,
      });
      return;
    }
    if (!hasExactCanonicalJsonSchema(
      action.inputSchema,
      PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    )) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Event Automation history-gap recovery Action '${actionRef.localId}' must declare the exact canonical input schema.`,
      });
      return;
    }
    if (!hasExactCanonicalJsonSchema(
      action.resultSchema,
      PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    )) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Event Automation history-gap recovery Action '${actionRef.localId}' must declare the exact canonical result schema.`,
      });
    }
  });
  return diagnostics;
}

function readDynamicResourceHostAccessDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const requestsById = new Map([
    ...manifest.hostAccess.required,
    ...manifest.hostAccess.optional,
  ].map((request) => [request.id, request] as const));
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.resources.forEach((resource, resourceIndex) => {
    if (!isDynamicPluginResourceContributionV2(resource)) return;
    resource.hostAccess?.forEach((requestId, requestIndex) => {
      const request = requestsById.get(requestId);
      // Generic reference diagnostics own absent request ids.
      if (!request || request.capability === 'storage.account') return;
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'resources', resourceIndex, 'hostAccess', requestIndex],
        message: `Dynamic Resource HostAccess request '${requestId}' must use the storage.account capability.`,
      });
    });
  });
  return diagnostics;
}

/**
 * Openable-content bindings are host-custodied workspace-file viewer mounts.
 * The details destination persists only the qualified destination identity, so
 * a multiple-instance view has no safe durable per-file instance key.
 */
function readOpenableContentViewerDestinationDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const viewsById = new Map(manifest.contributes.ui.views.map((view) => [view.id, view]));
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.openableContentViewers.forEach((viewer, viewerIndex) => {
    const destination = viewsById.get(viewer.destination);
    // Generic reference diagnostics own absent and wrong-family destinations.
    if (!destination || destination.instancePolicy === 'singleton') return;
    diagnostics.push({
      code: 'plugin_manifest_invalid',
      path: ['contributes', 'openableContentViewers', viewerIndex, 'destination'],
      message: 'Openable-content viewer destinations must use singleton instance policy.',
    });
  });
  return diagnostics;
}

/**
 * A declarative document source is a live Resource binding, not merely a
 * generic Resource reference. The Resource contribution remains the sole
 * source/type authority; this manifest owner only rejects the packaged arm,
 * which cannot supply the document's required invalidation lifecycle.
 */
function readDeclarativeDocumentSourceDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const resourcesById = new Map(
    manifest.contributes.resources.map((resource) => [resource.id, resource]),
  );
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.ui.renderers.forEach((renderer, rendererIndex) => {
    if (renderer.kind !== 'declarative' || !renderer.documentSource) return;
    const resource = resourcesById.get(renderer.documentSource.resourceId);
    // Generic reference diagnostics own missing/wrong-family Resource ids.
    if (!resource) return;
    if (!isDynamicPluginResourceContributionV2(resource)) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', rendererIndex, 'documentSource', 'resourceId'],
        message: `Declarative document source '${renderer.documentSource.resourceId}' must reference a dynamic Resource.`,
      });
      return;
    }
    if (!isPluginDeclarativeDocumentContentTypeV1(resource.contentType)) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', rendererIndex, 'documentSource', 'resourceId'],
        message: `Declarative document source '${renderer.documentSource.resourceId}' must declare the exact V1 document content type.`,
      });
    }
  });
  return diagnostics;
}

/** A transcript activity binds a narrowly typed, same-plugin live Resource. */
function readTranscriptActivityDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const resourcesById = new Map(manifest.contributes.resources.map((resource) => [resource.id, resource]));
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  manifest.contributes.transcriptActivities.forEach((activity, activityIndex) => {
    const resource = resourcesById.get(activity.resourceId);
    // The generic catalog diagnostics owns dangling/wrong-family ids.
    if (!resource) return;
    const path = ['contributes', 'transcriptActivities', activityIndex, 'resourceId'];
    if (!isDynamicPluginResourceContributionV2(resource)) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Transcript activity '${activity.id}' must reference a dynamic Resource.`,
      });
      return;
    }
    if (resource.scope !== 'session') {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Transcript activity '${activity.id}' must reference a session-scoped dynamic Resource.`,
      });
      return;
    }
    if (!isPluginTranscriptActivityContentTypeV1(resource.contentType)) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Transcript activity '${activity.id}' must reference the exact V1 activity Resource content type.`,
      });
    }
    if (
      resource.maxBytes === undefined
      || resource.maxBytes > MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1
    ) {
      diagnostics.push({
        code: 'plugin_manifest_invalid',
        path,
        message: `Transcript activity '${activity.id}' Resource maxBytes must be declared and no greater than ${MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1}.`,
      });
    }
  });
  return diagnostics;
}

/**
 * A brand icon is intentionally narrower than an arbitrary Resource consumer:
 * it is a same-plugin, packaged PNG asset. Byte existence, decoding, and
 * bounds remain with packaged-resource admission, so a release can retain a
 * textual fallback when the file later becomes unavailable.
 */
function readBrandIconDiagnostics(
  manifest: ParsedPluginManifestV2,
): PluginManifestIngestionDiagnostic[] {
  const brand = manifest.brand;
  if (!brand) return [];
  const resource = manifest.contributes.resources.find((candidate) => (
    candidate.id === brand.iconResourceId
  ));
  if (!resource) {
    const localIdExistsInAnotherFamily = PLUGIN_CONTRIBUTION_CATALOG_V2.some((entry) => (
      entry.manifestKey !== 'resources'
      && entry.readEntries(manifest.contributes as Readonly<Record<string, unknown>>).some((candidate) => (
        candidate !== null
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && (candidate as Readonly<Record<string, unknown>>).id === brand.iconResourceId
      ))
    ));
    return [{
      code: localIdExistsInAnotherFamily
        ? 'plugin_manifest_wrong_family_reference'
        : 'plugin_manifest_dangling_reference',
      path: ['brand', 'iconResourceId'],
      message: `Brand icon Resource '${brand.iconResourceId}' is not declared.`,
    }];
  }
  if (
    isDynamicPluginResourceContributionV2(resource)
    || resource.kind !== 'asset'
    || resource.contentType !== 'image/png'
  ) {
    return [{
      code: 'plugin_manifest_invalid',
      path: ['brand', 'iconResourceId'],
      message: `Brand icon Resource '${brand.iconResourceId}' must be a packaged image/png asset.`,
    }];
  }
  return [];
}

function readVoiceModelPackOriginDiagnostics(manifest: ParsedPluginManifestV2): PluginManifestIngestionDiagnostic[] {
  const covered = new Set<string>();
  for (const request of [...manifest.hostAccess.required, ...manifest.hostAccess.optional]) {
    if (request.capability !== 'network') continue;
    for (const target of request.scope.targets) if (target.kind === 'fixedOrigin') covered.add(target.origin);
  }
  const packs = manifest.contributes.voiceModelPacks;
  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
  packs.forEach((pack, packIndex) => {
    const urls: Array<{ value: unknown; path: readonly (string | number)[] }> = [
      { value: pack.manifest.provenance.source, path: ['manifest', 'provenance', 'source'] },
      { value: pack.manifest.license.url, path: ['manifest', 'license', 'url'] },
      ...pack.manifest.files.map((file, fileIndex) => ({ value: file.url, path: ['manifest', 'files', fileIndex, 'url'] })),
    ];
    for (const candidate of urls) {
      if (typeof candidate.value !== 'string') continue;
      let origin: string;
      try {
        const parsed = new URL(candidate.value);
        if (parsed.protocol !== 'https:') continue;
        origin = parsed.origin;
      } catch {
        continue;
      }
      if (!covered.has(origin)) diagnostics.push({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'voiceModelPacks', packIndex, ...candidate.path],
        message: `Voice model-pack HTTPS origin '${origin}' is not covered by hostAccess.network.`,
      });
    }
  });
  return diagnostics;
}

export function ingestPluginManifestV2(input: unknown): PluginManifestIngestionResult {
  const decoded = readJsonInput(input);
  if (!decoded.ok) return decoded.result;
  if (!isSafeForPluginManifestSchemaValidation(decoded.value)) {
    return {
      ok: false,
      diagnostics: [{
        code: 'plugin_manifest_invalid',
        message: 'Plugin manifest is too deeply nested to validate safely.',
      }],
    };
  }
  const parsed = PluginManifestV2Schema.safeParse(decoded.value);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => ({
          code: 'plugin_manifest_invalid' as const,
          path: [...issue.path.filter((part): part is string | number => typeof part !== 'symbol'), key],
          message: `Unrecognized key: ${JSON.stringify(key)}`,
        }));
      }
      const invalidContributionId = isContributionLocalIdIssuePath(issue.path);
      return [{
        code: invalidContributionId
            ? 'plugin_manifest_invalid_contribution_id' as const
            : 'plugin_manifest_invalid' as const,
        path: issue.path.filter((part): part is string | number => typeof part !== 'symbol'),
        message: issue.message,
      }];
    });
    return {
      ok: false,
      diagnostics,
    };
  }
  const semanticDiagnostics = [
    ...readContributionIds(parsed.data.contributes as Readonly<Record<string, unknown>>),
    ...readReferenceDiagnostics(parsed.data),
    ...readEventAutomationSetupActionDiagnostics(parsed.data),
    ...readEventAutomationHistoryGapResetActionDiagnostics(parsed.data),
    ...readDynamicResourceHostAccessDiagnostics(parsed.data),
    ...readOpenableContentViewerDestinationDiagnostics(parsed.data),
    ...readDeclarativeDocumentSourceDiagnostics(parsed.data),
    ...readTranscriptActivityDiagnostics(parsed.data),
    ...readBrandIconDiagnostics(parsed.data),
    ...readVoiceModelPackOriginDiagnostics(parsed.data),
  ];
  return semanticDiagnostics.length > 0
    ? { ok: false, diagnostics: semanticDiagnostics }
    : { ok: true, manifest: parsed.data };
}

export function resolvePluginManifestSetReferencesV2(
  manifests: readonly ParsedPluginManifestV2[],
): PluginManifestSetReferenceResolutionResult {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const manifest of manifests) {
    const families = new Map<string, Set<string>>();
    for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      const ids = new Set<string>();
      for (const value of entry.readEntries(manifest.contributes as Readonly<Record<string, unknown>>)) {
        if (!value || typeof value !== 'object' || entry.identityField === null) continue;
        const id = (value as Readonly<Record<string, unknown>>)[entry.identityField];
        if (typeof id === 'string') ids.add(id);
      }
      families.set(entry.manifestKey, ids);
    }
    index.set(manifest.id, families);
  }

  const diagnostics: PluginManifestIngestionDiagnostic[] = manifests.flatMap(
    readOpenableContentViewerDestinationDiagnostics,
  );
  diagnostics.push(...manifests.flatMap(readEventAutomationSetupActionDiagnostics));
  diagnostics.push(...manifests.flatMap(readEventAutomationHistoryGapResetActionDiagnostics));
  for (const manifest of manifests) {
    for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      entry.readEntries(manifest.contributes as Readonly<Record<string, unknown>>).forEach((value, contributionIndex) => {
        if (!value || typeof value !== 'object') return;
        for (const candidate of entry.extractReferences(value as Readonly<Record<string, unknown>>)) {
          if (!candidate.reference || typeof candidate.reference !== 'object' || Array.isArray(candidate.reference)) continue;
          const reference = candidate.reference as Readonly<{ pluginId?: unknown; localId?: unknown }>;
          if (typeof reference.pluginId !== 'string' || typeof reference.localId !== 'string') continue;
          const targetPluginId = reference.pluginId;
          const targetLocalId = reference.localId;
          if (candidate.allowQualifiedCrossPlugin === false && targetPluginId !== manifest.id) {
            diagnostics.push({
              code: 'plugin_manifest_dangling_reference',
              path: ['contributes', ...entry.manifestKey.split('.'), contributionIndex, ...candidate.path],
              message: 'This declarative Action reference must use a same-plugin local id string.',
            });
            continue;
          }
          const targetFamilyIndex = index.get(targetPluginId);
          const targetFamilies = candidate.targetFamilies ?? [candidate.targetFamily];
          const foundInTarget = targetFamilies.some((targetFamily) => (
            targetFamilyIndex?.get(targetFamily)?.has(targetLocalId) === true
          ));
          if (foundInTarget) continue;
          const foundElsewhere = targetFamilyIndex
            ? [...targetFamilyIndex.values()].some((ids) => ids.has(targetLocalId))
            : false;
          diagnostics.push({
            code: foundElsewhere ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
            path: ['contributes', ...entry.manifestKey.split('.'), contributionIndex, ...candidate.path],
            message: `${manifest.id} references missing ${targetFamilies.join(' or ')} contribution ${targetPluginId}/${targetLocalId}.`,
          });
        }
      });
    }
    for (const candidate of readHostAccessReferenceCandidates(manifest)) {
      if (!candidate.reference || typeof candidate.reference !== 'object' || Array.isArray(candidate.reference)) continue;
      const reference = candidate.reference as Readonly<{ pluginId?: unknown; localId?: unknown }>;
      if (typeof reference.pluginId !== 'string' || typeof reference.localId !== 'string') continue;
      const targetPluginId = reference.pluginId;
      const targetLocalId = reference.localId;
      const targetFamilies = index.get(targetPluginId);
      const foundInTarget = targetFamilies?.get(candidate.targetFamily)?.has(targetLocalId) === true;
      if (foundInTarget) continue;
      const foundElsewhere = targetFamilies
        ? [...targetFamilies.values()].some((ids) => ids.has(targetLocalId))
        : false;
      diagnostics.push({
        code: foundElsewhere ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
        path: candidate.path,
        message: `${manifest.id} references missing ${candidate.targetFamily} contribution ${targetPluginId}/${targetLocalId}.`,
      });
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}
