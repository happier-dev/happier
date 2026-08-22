import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { z } from 'zod';
import {
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  PluginIdSchema,
  type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

export type PluginAccessScopeComparison =
  | Readonly<{ relation: 'exact'; reason: 'canonical_scope_equal' }>
  | Readonly<{ relation: 'narrower'; reason: 'candidate_scope_narrower' }>
  | Readonly<{ relation: 'broader'; reason: 'candidate_scope_broader' }>
  | Readonly<{
      relation: 'changed';
      reason: 'unknown_capability' | 'comparator_missing' | 'comparator_error' | 'incomparable';
    }>
  | Readonly<{
      relation: 'invalid';
      reason: 'candidate_scope_invalid' | 'previous_scope_invalid' | 'canonicalizer_error';
    }>;

export type PluginAccessScopeRegistration = Readonly<{
  capability: string;
  scopeSchema: z.ZodType<unknown>;
  canonicalize: (scope: unknown) => unknown;
  isSubset?: (candidate: unknown, previous: unknown) => boolean;
}>;

export type PluginAccessSelection = Readonly<{
  pluginId: string;
  accessId: string;
  capability: string;
  normalizedScope: Readonly<Record<string, unknown>>;
  scopeDigest: string;
  selectedAtMs: number;
}>;

const CanonicalPluginIdSchema = z.string().superRefine((value, context) => {
  const parsed = PluginIdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    context.addIssue({ code: 'custom', message: 'Expected a canonical plugin id' });
  }
});

const CanonicalPluginAccessIdSchema = z.string().min(1).superRefine((value, context) => {
  if (value !== value.trim()) {
    context.addIssue({ code: 'custom', message: 'Expected a canonical plugin access id' });
  }
});

export const PluginAccessSelectionSchema = z.object({
  pluginId: CanonicalPluginIdSchema,
  accessId: CanonicalPluginAccessIdSchema,
  capability: z.string().min(1).refine((value) => value === value.trim(), 'Expected a canonical capability id'),
  normalizedScope: z.record(z.string(), z.unknown()),
  scopeDigest: z.string().regex(/^sha256-[A-Za-z0-9+/_=-]+$/),
  selectedAtMs: z.number().int().nonnegative(),
}).strict();

export type PluginAccessScopeRegistry = Readonly<{
  compare: (capability: string, candidateScope: unknown, previousScope: unknown) => PluginAccessScopeComparison;
  createSelection: (params: Readonly<{
    pluginId: string;
    accessId: string;
    capability: string;
    scope: unknown;
    selectedAtMs: number;
  }>) => PluginAccessSelection;
  validateSelection: (selection: unknown) => selection is PluginAccessSelection;
}>;

function canonicalJson(value: unknown): string {
  return JSON.stringify(cloneCanonicalJson(value));
}

type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

function cloneCanonicalJson(value: unknown, ancestors = new WeakSet<object>()): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Scope canonicalizer produced a non-JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error('Scope canonicalizer produced a non-JSON value');
  if (ancestors.has(value)) throw new Error('Scope canonicalizer produced cyclic JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
        throw new Error('Scope canonicalizer produced a non-canonical JSON array');
      }
      return value.map((_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Scope canonicalizer produced a non-canonical JSON array');
        }
        return cloneCanonicalJson(descriptor.value, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Scope canonicalizer produced a non-plain JSON object');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new Error('Scope canonicalizer produced a non-JSON object key');
    }
    const output: { [key: string]: CanonicalJsonValue } = Object.create(null) as { [key: string]: CanonicalJsonValue };
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Scope canonicalizer produced a non-canonical JSON object');
      }
      output[key] = cloneCanonicalJson(descriptor.value, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function scopeDigest(value: unknown): string {
  return `sha256-${createHash('sha256').update(canonicalJson(value)).digest('base64')}`;
}

export function createPluginAccessScopeRegistry(
  registrations: readonly PluginAccessScopeRegistration[],
): PluginAccessScopeRegistry {
  const byCapability = new Map<string, PluginAccessScopeRegistration>();
  for (const registration of registrations) {
    const capability = registration.capability;
    if (
      typeof capability !== 'string'
      || capability.length === 0
      || capability.length > 128
      || capability !== capability.trim()
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)
      || byCapability.has(capability)
    ) {
      throw new Error(`Duplicate or empty PluginAccessScopeRegistry capability '${registration.capability}'`);
    }
    byCapability.set(capability, Object.freeze({
      capability,
      scopeSchema: registration.scopeSchema,
      canonicalize: registration.canonicalize,
      ...(registration.isSubset ? { isSubset: registration.isSubset } : {}),
    }));
  }

  function normalize(registration: PluginAccessScopeRegistration, scope: unknown): Readonly<{
    ok: true;
    value: unknown;
  }> | Readonly<{ ok: false; kind: 'schema' | 'canonicalizer' }> {
    try {
      const parsed = registration.scopeSchema.safeParse(scope);
      if (!parsed.success) return { ok: false, kind: 'schema' };
      const firstValue = cloneCanonicalJson(registration.canonicalize(deepFreeze(parsed.data)));
      const reparsed = registration.scopeSchema.safeParse(firstValue);
      if (!reparsed.success || canonicalJson(reparsed.data) !== canonicalJson(firstValue)) {
        return { ok: false, kind: 'canonicalizer' };
      }
      const secondValue = cloneCanonicalJson(registration.canonicalize(deepFreeze(reparsed.data)));
      if (canonicalJson(firstValue) !== canonicalJson(secondValue)) {
        return { ok: false, kind: 'canonicalizer' };
      }
      return { ok: true, value: deepFreeze(firstValue) };
    } catch {
      return { ok: false, kind: 'canonicalizer' };
    }
  }

  function compare(capability: string, candidateScope: unknown, previousScope: unknown): PluginAccessScopeComparison {
    const registration = byCapability.get(capability);
    if (!registration) return { relation: 'changed', reason: 'unknown_capability' };
    const candidate = normalize(registration, candidateScope);
    if (!candidate.ok) {
      return candidate.kind === 'schema'
        ? { relation: 'invalid', reason: 'candidate_scope_invalid' }
        : { relation: 'invalid', reason: 'canonicalizer_error' };
    }
    const previous = normalize(registration, previousScope);
    if (!previous.ok) {
      return previous.kind === 'schema'
        ? { relation: 'invalid', reason: 'previous_scope_invalid' }
        : { relation: 'invalid', reason: 'canonicalizer_error' };
    }
    if (canonicalJson(candidate.value) === canonicalJson(previous.value)) {
      return { relation: 'exact', reason: 'canonical_scope_equal' };
    }
    if (!registration.isSubset) return { relation: 'changed', reason: 'comparator_missing' };
    try {
      const candidateIsSubset = registration.isSubset(candidate.value, previous.value);
      const candidateIsSubsetAgain = registration.isSubset(candidate.value, previous.value);
      const previousIsSubset = registration.isSubset(previous.value, candidate.value);
      const previousIsSubsetAgain = registration.isSubset(previous.value, candidate.value);
      if (
        typeof candidateIsSubset !== 'boolean'
        || typeof candidateIsSubsetAgain !== 'boolean'
        || typeof previousIsSubset !== 'boolean'
        || typeof previousIsSubsetAgain !== 'boolean'
        || candidateIsSubset !== candidateIsSubsetAgain
        || previousIsSubset !== previousIsSubsetAgain
      ) {
        return { relation: 'changed', reason: 'comparator_error' };
      }
      if (candidateIsSubset && !previousIsSubset) return { relation: 'narrower', reason: 'candidate_scope_narrower' };
      if (previousIsSubset && !candidateIsSubset) return { relation: 'broader', reason: 'candidate_scope_broader' };
      return { relation: 'changed', reason: 'incomparable' };
    } catch {
      return { relation: 'changed', reason: 'comparator_error' };
    }
  }

  return Object.freeze({
    compare,
    createSelection(params): PluginAccessSelection {
      const pluginId = params.pluginId.trim();
      const accessId = params.accessId.trim();
      const registration = byCapability.get(params.capability);
      if (!PluginIdSchema.safeParse(pluginId).success || !accessId || !registration || !Number.isSafeInteger(params.selectedAtMs) || params.selectedAtMs < 0) {
        throw new Error('Invalid plugin optional access selection identity');
      }
      const normalized = normalize(registration, params.scope);
      if (!normalized.ok) throw new Error('Invalid plugin optional access selection scope');
      if (!normalized.value || typeof normalized.value !== 'object' || Array.isArray(normalized.value)) {
        throw new Error('Plugin optional access canonical scope must be an object');
      }
      return deepFreeze({
        pluginId,
        accessId,
        capability: params.capability,
        normalizedScope: normalized.value as Readonly<Record<string, unknown>>,
        scopeDigest: scopeDigest(normalized.value),
        selectedAtMs: params.selectedAtMs,
      });
    },
    validateSelection(selection: unknown): selection is PluginAccessSelection {
      try {
        const parsed = PluginAccessSelectionSchema.safeParse(selection);
        if (!parsed.success) return false;
        const registration = byCapability.get(parsed.data.capability);
        if (!registration) return false;
        const normalized = normalize(registration, parsed.data.normalizedScope);
        return normalized.ok
          && canonicalJson(normalized.value) === canonicalJson(parsed.data.normalizedScope)
          && scopeDigest(normalized.value) === parsed.data.scopeDigest;
      } catch {
        return false;
      }
    },
  });
}

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function sortStructured<T>(values: readonly T[]): T[] {
  const byCanonicalValue = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byCanonicalValue.entries()].sort(([leftJson], [rightJson]) => {
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  }).map(([, value]) => value);
}

function canonicalizeFilesystemPathPrefix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slashNormalized = value.replaceAll('\\', '/');
  if (/^[A-Za-z]:/u.test(slashNormalized) || slashNormalized.startsWith('/') || /[\0\r\n]/u.test(slashNormalized)) {
    throw new Error('Plugin filesystem path prefix must be relative');
  }
  const normalized = posix.normalize(slashNormalized).replace(/\/$/u, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Plugin filesystem path prefix must stay within its structured root');
  }
  return normalized === '.' ? undefined : normalized;
}

function canonicalizeFilesystemLocation(
  location: Extract<PluginHostAccessRequestV2, { capability: 'filesystem' }>['scope']['locations'][number],
): Extract<PluginHostAccessRequestV2, { capability: 'filesystem' }>['scope']['locations'][number] {
  const pathPrefix = canonicalizeFilesystemPathPrefix(location.pathPrefix);
  const { pathPrefix: _ignored, ...rest } = location;
  return {
    ...rest,
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

function asScopeRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function canonicalizeHttpOriginInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && url.pathname === '/' && !url.search
      ? url.origin
      : value;
  } catch {
    return value;
  }
}

function canonicalizeNetworkTargetInput(value: unknown): unknown {
  const target = asScopeRecord(value);
  return target?.kind === 'fixedOrigin'
    ? { ...target, origin: canonicalizeHttpOriginInput(target.origin) }
    : value;
}

function canonicalizeStringSetInput(value: unknown): unknown {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? sortStrings(value)
    : value;
}

function canonicalizeStructuredSetInput(value: unknown, mapEntry: (entry: unknown) => unknown = (entry) => entry): unknown {
  return Array.isArray(value) ? sortStructured(value.map(mapEntry)) : value;
}

function canonicalizeBuiltInScopeInput(capability: string, value: unknown): unknown {
  const scope = asScopeRecord(value);
  if (!scope) return value;
  switch (capability) {
    case 'network':
      return {
        ...scope,
        targets: canonicalizeStructuredSetInput(scope.targets, canonicalizeNetworkTargetInput),
        ...(scope.methods !== undefined ? { methods: canonicalizeStringSetInput(scope.methods) } : {}),
      };
    case 'externalLinks':
      return { ...scope, origins: canonicalizeStructuredSetInput(scope.origins, canonicalizeHttpOriginInput) };
    case 'network.client':
      return {
        ...scope,
        targets: canonicalizeStructuredSetInput(scope.targets, canonicalizeNetworkTargetInput),
        transports: canonicalizeStringSetInput(scope.transports),
      };
    case 'filesystem':
      return {
        ...scope,
        locations: Array.isArray(scope.locations)
          ? sortStructured(scope.locations.map((location) => {
            const record = asScopeRecord(location);
            if (!record || typeof record.pathPrefix !== 'string') return location;
            const pathPrefix = canonicalizeFilesystemPathPrefix(record.pathPrefix);
            const { pathPrefix: _ignored, ...rest } = record;
            return { ...rest, ...(pathPrefix ? { pathPrefix } : {}) };
          }))
          : scope.locations,
        access: canonicalizeStringSetInput(scope.access),
      };
    case 'process':
      return {
        ...scope,
        executables: canonicalizeStructuredSetInput(scope.executables),
        ...(scope.envKeys !== undefined ? { envKeys: canonicalizeStringSetInput(scope.envKeys) } : {}),
      };
    case 'environment':
      return { ...scope, keys: canonicalizeStringSetInput(scope.keys) };
    case 'connectedAccounts':
      return {
        ...scope,
        serviceRefs: canonicalizeStructuredSetInput(scope.serviceRefs),
        ...(scope.accountScopes !== undefined ? { accountScopes: canonicalizeStringSetInput(scope.accountScopes) } : {}),
        operations: canonicalizeStringSetInput(scope.operations),
        ...(scope.materializationKinds !== undefined
          ? { materializationKinds: canonicalizeStringSetInput(scope.materializationKinds) }
          : {}),
      };
    case 'sessions':
      return {
        ...scope,
        access: canonicalizeStringSetInput(scope.access),
        ...(scope.machineIds !== undefined ? { machineIds: canonicalizeStringSetInput(scope.machineIds) } : {}),
        ...(scope.projectIds !== undefined ? { projectIds: canonicalizeStringSetInput(scope.projectIds) } : {}),
      };
    case 'terminal':
      return { ...scope, operations: canonicalizeStringSetInput(scope.operations) };
    case 'browser':
      return {
        ...scope,
        operations: canonicalizeStringSetInput(scope.operations),
        ...(scope.origins !== undefined ? { origins: canonicalizeStructuredSetInput(scope.origins, canonicalizeHttpOriginInput) } : {}),
      };
    case 'clipboard':
      return { ...scope, access: canonicalizeStringSetInput(scope.access) };
    case 'storage.account':
      return value;
    case 'mcp':
      return {
        ...scope,
        serverRefs: canonicalizeStructuredSetInput(scope.serverRefs),
        discoverySourceRefs: canonicalizeStructuredSetInput(scope.discoverySourceRefs),
        operations: canonicalizeStringSetInput(scope.operations),
      };
    default:
      return value;
  }
}

function canonicalizeBuiltInScope(capability: string, value: unknown): unknown {
  switch (capability) {
    case 'network': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'network' }>['scope'];
      return {
        targets: sortStructured(scope.targets),
        ...(scope.methods ? { methods: sortStrings(scope.methods) } : {}),
        ...(scope.privateNetwork === true ? { privateNetwork: true } : {}),
      };
    }
    case 'network.client': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'network.client' }>['scope'];
      return {
        targets: sortStructured(scope.targets),
        transports: sortStrings(scope.transports),
        privateNetwork: scope.privateNetwork,
      };
    }
    case 'filesystem': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'filesystem' }>['scope'];
      return { locations: sortStructured(scope.locations.map(canonicalizeFilesystemLocation)), access: sortStrings(scope.access) };
    }
    case 'process': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'process' }>['scope'];
      return { executables: sortStructured(scope.executables), ...(scope.envKeys ? { envKeys: sortStrings(scope.envKeys) } : {}) };
    }
    case 'environment': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'environment' }>['scope'];
      return { keys: sortStrings(scope.keys) };
    }
    case 'connectedAccounts': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'connectedAccounts' }>['scope'];
      return {
        serviceRefs: sortStructured(scope.serviceRefs),
        ...(scope.accountScopes ? { accountScopes: sortStrings(scope.accountScopes) } : {}),
        operations: sortStrings(scope.operations),
        ...(scope.materializationKinds
          ? { materializationKinds: sortStrings(scope.materializationKinds) }
          : {}),
      };
    }
    case 'sessions': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'sessions' }>['scope'];
      return { access: sortStrings(scope.access), ...(scope.machineIds ? { machineIds: sortStrings(scope.machineIds) } : {}), ...(scope.projectIds ? { projectIds: sortStrings(scope.projectIds) } : {}) };
    }
    case 'terminal': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'terminal' }>['scope'];
      return { operations: sortStrings(scope.operations) };
    }
    case 'browser': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'browser' }>['scope'];
      return { operations: sortStrings(scope.operations), ...(scope.origins ? { origins: sortStrings(scope.origins) } : {}) };
    }
    case 'clipboard': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'clipboard' }>['scope'];
      return { access: sortStrings(scope.access) };
    }
    case 'externalLinks': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'externalLinks' }>['scope'];
      return { origins: sortStrings(scope.origins) };
    }
    case 'storage.account':
      return { enabled: true };
    case 'mcp': {
      const scope = value as Extract<PluginHostAccessRequestV2, { capability: 'mcp' }>['scope'];
      return {
        serverRefs: sortStructured(scope.serverRefs),
        discoverySourceRefs: sortStructured(scope.discoverySourceRefs),
        operations: sortStrings(scope.operations),
      };
    }
    default:
      throw new Error(`Unknown built-in plugin host access capability '${capability}'`);
  }
}

function stringSetIsSubset(candidate: readonly string[], previous: readonly string[]): boolean {
  const previousValues = new Set(previous);
  return candidate.every((value) => previousValues.has(value));
}

function structuredSetIsSubset(candidate: readonly unknown[], previous: readonly unknown[]): boolean {
  const previousValues = new Set(previous.map(canonicalJson));
  return candidate.every((value) => previousValues.has(canonicalJson(value)));
}

function optionalStringSetIsSubset(
  candidate: readonly string[] | undefined,
  previous: readonly string[] | undefined,
): boolean {
  if (previous === undefined) return true;
  return candidate !== undefined && stringSetIsSubset(candidate, previous);
}

function optionalEmptyStringSetIsSubset(
  candidate: readonly string[] | undefined,
  previous: readonly string[] | undefined,
): boolean {
  return stringSetIsSubset(candidate ?? [], previous ?? []);
}

function builtInSubsetComparator(capability: string): ((candidate: unknown, previous: unknown) => boolean) | undefined {
  switch (capability) {
    case 'network':
      return (candidate, previous) => {
        const candidateScope = candidate as Extract<PluginHostAccessRequestV2, { capability: 'network' }>['scope'];
        const previousScope = previous as Extract<PluginHostAccessRequestV2, { capability: 'network' }>['scope'];
        return structuredSetIsSubset(candidateScope.targets, previousScope.targets)
          && optionalStringSetIsSubset(candidateScope.methods, previousScope.methods)
          && (candidateScope.privateNetwork !== true || previousScope.privateNetwork === true);
      };
    case 'connectedAccounts':
      return (candidate, previous) => {
        const candidateScope = candidate as Extract<PluginHostAccessRequestV2, { capability: 'connectedAccounts' }>['scope'];
        const previousScope = previous as Extract<PluginHostAccessRequestV2, { capability: 'connectedAccounts' }>['scope'];
        return structuredSetIsSubset(candidateScope.serviceRefs, previousScope.serviceRefs)
          && optionalStringSetIsSubset(candidateScope.accountScopes, previousScope.accountScopes)
          && stringSetIsSubset(candidateScope.operations, previousScope.operations)
          && optionalEmptyStringSetIsSubset(
            candidateScope.materializationKinds,
            previousScope.materializationKinds,
          );
      };
    case 'sessions':
      return (candidate, previous) => {
        const candidateScope = candidate as Extract<PluginHostAccessRequestV2, { capability: 'sessions' }>['scope'];
        const previousScope = previous as Extract<PluginHostAccessRequestV2, { capability: 'sessions' }>['scope'];
        return stringSetIsSubset(candidateScope.access, previousScope.access)
          && optionalStringSetIsSubset(candidateScope.machineIds, previousScope.machineIds)
          && optionalStringSetIsSubset(candidateScope.projectIds, previousScope.projectIds);
      };
    case 'storage.account':
      return () => true;
    case 'mcp':
      return (candidate, previous) => {
        const candidateScope = candidate as Extract<PluginHostAccessRequestV2, { capability: 'mcp' }>['scope'];
        const previousScope = previous as Extract<PluginHostAccessRequestV2, { capability: 'mcp' }>['scope'];
        return structuredSetIsSubset(candidateScope.serverRefs, previousScope.serverRefs)
          && structuredSetIsSubset(
            candidateScope.discoverySourceRefs,
            previousScope.discoverySourceRefs,
          )
          && stringSetIsSubset(candidateScope.operations, previousScope.operations);
      };
    default:
      return undefined;
  }
}

export function createDefaultPluginAccessScopeRegistry(): PluginAccessScopeRegistry {
  return createPluginAccessScopeRegistry(PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => ({
    capability: entry.capability,
    scopeSchema: z.preprocess(
      (scope) => canonicalizeBuiltInScopeInput(entry.capability, scope),
      entry.schema.shape.scope,
    ),
    canonicalize: (scope: unknown) => canonicalizeBuiltInScope(entry.capability, scope),
    ...(entry.authorizationClass === 'hostResourceSelection' && builtInSubsetComparator(entry.capability)
      ? { isSubset: builtInSubsetComparator(entry.capability) }
      : {}),
  })));
}
