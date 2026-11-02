import { z } from 'zod/mini';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { DeploymentTemplateV1Schema } from '../../plugins/contributions/deploymentTemplates.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistryContentRefV1, RegistryItemSummaryV1, RegistryItemV1 } from '../registryItemsV1.js';
import type { RegistryPackagedSourceDescriptorV1 } from '../registrySourcesV1.js';

/** Descriptor admission belongs to selected reads, so malformed siblings remain browseable. */
export const HappierAppCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1), apps: z.array(z.unknown()),
}));
const EntryV1Schema = lazyZodSchema(() => z.strictObject({ itemId: z.string().check(z.minLength(1)), app: z.unknown() }));
export type HappierAppCatalogV1 = z.infer<typeof HappierAppCatalogV1Schema>;
type AppReadInputV1 = Readonly<{
  sourceId: string; fetchedAt: number; version?: string; ref?: RegistryContentRefV1;
  packageContent?: RegistryPackagedSourceDescriptorV1['packageContent'];
}>;

function title(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'fallback' in value && typeof value.fallback === 'string' && value.fallback.trim()) return value.fallback;
  return fallback;
}
function entries(catalog: HappierAppCatalogV1) {
  return catalog.apps.flatMap(value => {
    const parsed = EntryV1Schema.safeParse(value);
    const diagnostics: { field: string; reason: string }[] = parsed.success ? []
      : parsed.error.issues.map(issue => ({ field: issue.path.map(String).join('.') || 'app', reason: issue.code }));
    if (parsed.success) return [{ ...parsed.data, diagnostics }];
    if (!value || typeof value !== 'object' || !('itemId' in value)) return [];
    const itemId = EntryV1Schema.shape.itemId.safeParse(value.itemId);
    if (!itemId.success) return [];
    return [{ itemId: itemId.data, app: 'app' in value ? value.app : undefined, diagnostics }];
  });
}
function selectedEntries(catalog: HappierAppCatalogV1, demanded: ReadonlySet<string>): ReadonlyMap<string, unknown[]> {
  const selected = new Map<string, unknown[]>();
  for (const value of catalog.apps) {
    if (!value || typeof value !== 'object' || !('itemId' in value)
      || typeof value.itemId !== 'string' || !demanded.has(value.itemId)) continue;
    const group = selected.get(value.itemId) ?? [];
    group.push(value); selected.set(value.itemId, group);
  }
  return selected;
}
function summary(sourceId: string, entry: Pick<ReturnType<typeof entries>[number], 'itemId' | 'app'>): RegistryItemSummaryV1 {
  const app = entry.app && typeof entry.app === 'object' ? entry.app : {};
  return { sourceId, kind: 'app', itemId: entry.itemId,
    title: title('title' in app ? app.title : undefined, entry.itemId),
    ...('description' in app ? { description: title(app.description, '') } : {}) };
}
export function listHappierAppCatalogV1(input: Readonly<{
  sourceId: string; catalog: HappierAppCatalogV1; fetchedAt: number; query?: string;
}>): RegistryListPageV1 {
  const selected = entries(input.catalog);
  const counts = new Map<string, number>();
  for (const entry of selected) counts.set(entry.itemId, (counts.get(entry.itemId) ?? 0) + 1);
  const query = input.query?.trim().toLocaleLowerCase();
  const items = selected.map(entry => {
    const diagnostics = counts.get(entry.itemId)! > 1
      ? [...entry.diagnostics, { field: 'itemId', reason: 'duplicate_item' }] : entry.diagnostics;
    return { ...summary(input.sourceId, entry), ...(diagnostics.length
      ? { problem: { code: 'needs_review' as const, diagnostics } } : {}) };
  })
    .filter(item => !query || `${item.itemId} ${item.title} ${item.description ?? ''}`.toLocaleLowerCase().includes(query));
  return { sourceId: input.sourceId, status: { state: 'ok', fetchedAt: input.fetchedAt }, items, total: items.length, nextCursor: null };
}
export function readHappierAppCatalogItemV1(input: Readonly<{
  sourceId: string; catalog: HappierAppCatalogV1; fetchedAt: number; itemId: string; version?: string;
  ref?: RegistryContentRefV1;
  packageContent?: RegistryPackagedSourceDescriptorV1['packageContent'];
}>): RegistryItemV1 {
  const matching = selectedEntries(input.catalog, new Set([input.itemId])).get(input.itemId);
  if (matching?.length !== 1) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return readEntry(input, input.itemId, matching[0]);
}

/** A source acquisition is shared; only demanded descriptors are validated and hashed. */
export function latestHappierAppCatalogRefsV1(input: Pick<AppReadInputV1, 'sourceId' | 'fetchedAt' | 'packageContent'> & Readonly<{
  catalog: HappierAppCatalogV1; itemIds: readonly string[];
}>): ReadonlyMap<string, RegistryContentRefV1 | 'removed'> {
  const demanded = new Set(input.itemIds);
  const matching = selectedEntries(input.catalog, demanded);
  const result = new Map<string, RegistryContentRefV1 | 'removed'>();
  for (const itemId of demanded) {
    const group = matching.get(itemId);
    if (!group) { result.set(itemId, 'removed'); continue; }
    if (group.length !== 1) continue;
    try {
      const item = readEntry(input, itemId, group[0]);
      if (item.payload.kind !== 'app') throw new Error('registry_app_payload_missing');
      if (item.payload.state !== 'ready') continue;
      result.set(itemId, item.payload.ref);
    } catch (error) {
      // A malformed selected item stays unchecked without withdrawing healthy siblings.
      if (!(error instanceof RegistryFetchErrorV1) || error.status.state !== 'invalid_source') throw error;
    }
  }
  return result;
}

function readEntry(input: AppReadInputV1, itemId: string, value: unknown): RegistryItemV1 {
  const envelope = EntryV1Schema.safeParse(value);
  const descriptor = envelope.success ? envelope.data.app : undefined;
  const app = DeploymentTemplateV1Schema.safeParse(descriptor);
  const metadata = { itemId, app: envelope.success ? descriptor
    : value && typeof value === 'object' && 'app' in value ? value.app : undefined };
  // The exact selected inert descriptor is the content, not unrelated entries or catalog order.
  let admittedSource;
  try { admittedSource = normalizeStrictJsonValue(envelope.success ? descriptor : value); }
  catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  const digest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(createCanonicalJsonSigningInput(admittedSource))))}`;
  const ref = input.ref ?? (input.packageContent ? { kind: 'packageContent' as const, ...input.packageContent, digest }
    : { kind: 'content' as const, digest });
  const version = ref.kind === 'gitTree' ? ref.commit : ref.kind === 'version' ? ref.version
    : ref.kind === 'packageContent' ? ref.pluginVersion : ref.digest;
  if (input.version !== undefined && input.version !== version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  if (!envelope.success || !app.success) {
    const issues = !envelope.success ? envelope.error.issues : !app.success ? app.error.issues : [];
    const diagnostics = issues.map(issue => ({ field: issue.path.map(String).join('.') || 'app', reason: issue.code }));
    return { summary: { ...summary(input.sourceId, metadata), version, problem: { code: 'needs_review', diagnostics } },
      payload: { kind: 'app', state: 'needs_review', ref, diagnostics }, fetchedAt: input.fetchedAt };
  }
  return { summary: { ...summary(input.sourceId, metadata), version }, payload: { kind: 'app', state: 'ready', app: app.data, ref }, fetchedAt: input.fetchedAt };
}
