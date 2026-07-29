import { PluginManifestV2Schema, type ParsedPluginManifestV2 } from './v2.js';
import { PLUGIN_MANIFEST_INPUT_LIMITS } from './limits.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '../contributions/catalog.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

export type PluginManifestIngestionDiagnostic = Readonly<{
  code:
    | 'plugin_manifest_raw_budget_exceeded'
    | 'plugin_manifest_invalid_json'
    | 'plugin_manifest_aggregate_budget_exceeded'
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

export type PluginManifestSetReferenceResolutionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestIngestionDiagnostic[] }>;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

type DecodeResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; result: PluginManifestIngestionResult }>;

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
    if (activeAncestors.has(value)) return false;
    activeAncestors.add(value);
    stack.push({ value, exit: true });
    if (Array.isArray(value)) {
      for (const entry of value) stack.push({ value: entry, exit: false });
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const entry of Object.values(value)) stack.push({ value: entry, exit: false });
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
  if (bytes.byteLength > PLUGIN_MANIFEST_INPUT_LIMITS.rawBytes) {
    return {
      ok: false,
      result: { ok: false, diagnostics: [{
          code: 'plugin_manifest_raw_budget_exceeded',
          message: `Plugin manifest exceeds the ${PLUGIN_MANIFEST_INPUT_LIMITS.rawBytes}-byte input limit.`,
        }] },
    };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return {
      ok: false,
      result: { ok: false, diagnostics: [{ code: 'plugin_manifest_invalid_json', message: 'Plugin manifest is not valid UTF-8 JSON.' }] },
    };
  }
}

function readAggregateBudgetDiagnostic(root: unknown): PluginManifestIngestionDiagnostic | null {
  let nodes = 0;
  let stringBytes = 0;
  let arrayEntries = 0;
  let recordEntries = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > PLUGIN_MANIFEST_INPUT_LIMITS.nodes || current.depth > PLUGIN_MANIFEST_INPUT_LIMITS.depth) {
      return { code: 'plugin_manifest_aggregate_budget_exceeded', message: 'Plugin manifest exceeds the aggregate JSON node or depth limit.' };
    }
    if (typeof current.value === 'string') {
      stringBytes += utf8Length(current.value);
      if (stringBytes > PLUGIN_MANIFEST_INPUT_LIMITS.stringBytes) {
        return { code: 'plugin_manifest_aggregate_budget_exceeded', message: 'Plugin manifest exceeds the aggregate JSON string-byte limit.' };
      }
    } else if (Array.isArray(current.value)) {
      arrayEntries += current.value.length;
      if (arrayEntries > PLUGIN_MANIFEST_INPUT_LIMITS.arrayEntries) {
        return { code: 'plugin_manifest_aggregate_budget_exceeded', message: 'Plugin manifest exceeds the aggregate JSON array-entry limit.' };
      }
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      recordEntries += entries.length;
      if (recordEntries > PLUGIN_MANIFEST_INPUT_LIMITS.recordEntries) {
        return { code: 'plugin_manifest_aggregate_budget_exceeded', message: 'Plugin manifest exceeds the aggregate JSON record-entry limit.' };
      }
      for (const [key, value] of entries) {
        stringBytes += utf8Length(key);
        if (stringBytes > PLUGIN_MANIFEST_INPUT_LIMITS.stringBytes) {
          return { code: 'plugin_manifest_aggregate_budget_exceeded', message: 'Plugin manifest exceeds the aggregate JSON string-byte limit.' };
        }
        stack.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function readCatalogEntries(contributes: Readonly<Record<string, unknown>>, manifestKey: string): readonly unknown[] {
  let current: unknown = contributes;
  for (const segment of manifestKey.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return [];
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return Array.isArray(current) ? current : [];
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
        const ref = candidate.reference;
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          const structured = ref as Readonly<Record<string, unknown>>;
          if (structured.pluginId !== manifest.id) continue;
          diagnostics.push({
            code: 'plugin_manifest_dangling_reference',
            path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
            message: `Same-plugin references must use a local id string rather than a structured self-reference.`,
          });
          continue;
        }
        if (typeof ref !== 'string' || idsByFamily.get(candidate.targetFamily)?.has(ref)) continue;
        diagnostics.push({
          code: allLocalIds.has(ref) ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
          path: ['contributes', ...catalogEntry.manifestKey.split('.'), index, ...candidate.path],
          message: `${catalogEntry.manifestKey} contribution references undeclared ${candidate.targetFamily} id '${ref}'.`,
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
  const aggregateDiagnostic = readAggregateBudgetDiagnostic(decoded.value);
  if (aggregateDiagnostic) return { ok: false, diagnostics: [aggregateDiagnostic] };
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
      const invalidContributionId = issue.path[0] === 'contributes'
        && issue.path.at(-1) === 'id'
        && issue.message.includes('Contribution local ids');
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

  const diagnostics: PluginManifestIngestionDiagnostic[] = [];
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
          const targetFamilies = index.get(targetPluginId);
          const foundInTarget = targetFamilies?.get(candidate.targetFamily)?.has(targetLocalId) === true;
          if (foundInTarget) continue;
          const foundElsewhere = targetFamilies
            ? [...targetFamilies.values()].some((ids) => ids.has(targetLocalId))
            : false;
          diagnostics.push({
            code: foundElsewhere ? 'plugin_manifest_wrong_family_reference' : 'plugin_manifest_dangling_reference',
            path: ['contributes', ...entry.manifestKey.split('.'), contributionIndex, ...candidate.path],
            message: `${manifest.id} references missing ${candidate.targetFamily} contribution ${targetPluginId}/${targetLocalId}.`,
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
