import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '../contributions/catalog.js';
import type { PluginManifestIngestionDiagnostic } from './ingest.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';

type Path = readonly (string | number)[];

/** Copy only withdrawn declarations' ancestors; opaque admitted schema leaves stay intact. */
function withoutAtPath(input: unknown, path: Path): unknown {
  const [key, ...rest] = path;
  if (key === undefined || input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    const copy = [...input];
    if (typeof key !== 'number') return copy;
    if (rest.length === 0) copy.splice(key, 1);
    else copy[key] = withoutAtPath(copy[key], rest);
    return copy;
  }
  const copy = { ...input };
  if (rest.length === 0) Reflect.deleteProperty(copy, key);
  else Reflect.set(copy, key, withoutAtPath(Reflect.get(copy, key), rest));
  return copy;
}

function readAtPath(root: unknown, path: Path): unknown {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

/** Return the whole declaration, never an unknown field that might restrict it. */
function contributionPath(path: Path): Path | null {
  if (path[0] !== 'contributes' || path.length < 2) return null;
  for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    const family = ['contributes', ...entry.manifestKey.split('.')];
    if (!family.every((key, index) => path[index] === key)) continue;
    return typeof path[family.length] === 'number'
      ? path.slice(0, family.length + 1)
      : family;
  }
  // Unknown families have no registration rights. A malformed known container
  // is withdrawn as a whole; the strict schema supplies its empty defaults.
  let familyDepth = 2;
  for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    const container = ['contributes', ...entry.manifestKey.split('.')].slice(0, -1);
    if (container.length < path.length && container.every((key, index) => path[index] === key)) {
      familyDepth = Math.max(familyDepth, container.length + 1);
    }
  }
  return path.slice(0, familyDepth);
}

/**
 * Schema and semantic checks remain at their existing owners; this only
 * withdraws failed declarations without mutating the caller's value.
 * Any plugin-wide diagnostic is fatal, even alongside skippable diagnostics.
 */
export function skipInvalidPluginContributions(
  input: unknown,
  diagnostics: readonly PluginManifestIngestionDiagnostic[],
): Readonly<{ input: unknown; diagnostics: readonly PluginManifestIngestionDiagnostic[] }> | null {
  const removals = new Map<string, Path>();
  for (const diagnostic of diagnostics) {
    const path = diagnostic.path && contributionPath(diagnostic.path);
    if (!path || readAtPath(input, path) === undefined) return null;
    removals.set(JSON.stringify(path), path);
  }
  if (removals.size === 0) return null;
  // Siblings are removed backwards so diagnostic indices cannot shift a later
  // removal onto a healthy declaration. Parent removals subsume children.
  const paths = [...removals.values()].filter(path => ![...removals.values()].some(parent => (
    parent.length < path.length && parent.every((part, index) => path[index] === part)
  ))).sort((left, right) => {
    const leftIndex = left.at(-1);
    const rightIndex = right.at(-1);
    return typeof leftIndex === 'number' && typeof rightIndex === 'number' ? rightIndex - leftIndex : 0;
  });
  const pluginId = PluginIdSchema.safeParse(readAtPath(input, ['id']));
  const skipped = paths.map(path => {
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => (
      ['contributes', ...entry.manifestKey.split('.')].every((key, index) => path[index] === key)
    ));
    const localId = family?.identityField
      ? PluginContributionLocalIdSchema.safeParse(readAtPath(input, [...path, family.identityField]))
      : undefined;
    const failure = diagnostics.find(diagnostic => path.every((key, index) => diagnostic.path?.[index] === key));
    return {
      code: 'plugin_contribution_skipped' as const,
      path: failure?.path ?? path,
      ...(pluginId.success ? { pluginId: pluginId.data } : {}),
      ...(localId?.success ? { contributionId: localId.data } : {}),
      ...(failure ? { reason: failure.code } : {}),
      message: 'Contribution skipped because its declaration is unknown, invalid, or references an unavailable contribution.',
    };
  });
  return { input: paths.reduce(withoutAtPath, input), diagnostics: skipped };
}
