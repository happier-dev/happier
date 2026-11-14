import { z } from '../zodRuntimePolicy.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';
import type { DaemonContributionRegistryProjectionDescribeResponse } from './contributionRegistryProjection.js';

/**
 * A section index: literal JSON text plus references to content-addressed
 * bodies, which travel separately as section reads. Reassembly still requires
 * the complete describe schema.
 *
 * Reader web tabs outlive daemon updates, so the section envelopes
 * (manifest, index, page) are additive-open: unknown fields are dropped and
 * known discriminators stay closed. The parsed describe still owns admission.
 */
export const DaemonContributionRegistryProjectionSectionsResponseSchema = lazyZodSchema(() => z.object({
  protocolVersion: z.literal(1),
  sectioned: z.literal(true),
  /**
   * Distinct Machine-field values of this index, each once. Parts reference
   * them by position. Absent from older indexes, whose parts carry the text.
   */
  values: z.optional(z.array(z.string())),
  /** Distinct plugin ids of this index's parts, each once. Absent from older indexes. */
  plugins: z.optional(z.array(z.string())),
  parts: z.array(z.union([z.string(), z.object({
    digest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
    values: z.union([z.array(z.string()), z.array(z.number().check(z.int(), z.minimum(0)))]),
    /**
     * UTF-8 bytes this body occupies when a section read includes it beside its
     * carrier. It lets a reader name only the peers one frame can carry; the
     * answering Machine still decides inclusion. Absent from older indexes.
     */
    peerBytes: z.optional(z.number().check(z.int(), z.minimum(1))),
    /**
     * The plugin whose adjacent entries this body groups, as a position in
     * `plugins`. A reader selecting
     * plugins fetches only their bodies. Absent from older indexes, whose
     * parts every reader then reads.
     */
    plugin: z.optional(z.number().check(z.int(), z.minimum(0))),
  })])),
}));
export type DaemonContributionRegistryProjectionSectionsResponse = z.infer<typeof DaemonContributionRegistryProjectionSectionsResponseSchema>;
export type DaemonContributionRegistryProjectionSection = Exclude<DaemonContributionRegistryProjectionSectionsResponse['parts'][number], string>;

// These facts always travel with the answering Machine, even when their current
// values happen to match another Machine. This is byte sharing, not admission.
// Targeted contribution graphs recurse: their occurrence/custody fields stay
// Machine-specific while their declared points and operation layouts share.
const MACHINE_FIELDS = new Set(['executionOrigin', 'availability', 'available',
  'authorization', 'occurrenceId', 'sourceCustody', 'projectionGeneration', 'generation', 'diagnostics',
  'contributionIntrospection', 'targetGeneration', 'desiredGeneration']);

/** SHA-256 over bytes. Hosts inject their native engine; noble is the portable default. */
export type DaemonProjectionSectionSha256 = (bytes: Uint8Array) => Uint8Array;
export type DaemonProjectionSectionSha256Async = (bytes: Uint8Array) => Promise<Uint8Array>;

/**
 * The section content address: lowercase hex SHA-256 of the body's JSON array
 * text encoded as UTF-8. Only the hashing engine varies by platform.
 */
export function computeDaemonProjectionSectionDigest(
  body: readonly string[],
  hash: DaemonProjectionSectionSha256 = sha256,
): string {
  return digestSectionText(JSON.stringify(body), hash);
}

export async function computeDaemonProjectionSectionDigestAsync(
  body: readonly string[],
  hash: DaemonProjectionSectionSha256Async,
): Promise<string> {
  return bytesToHex(await hash(utf8ToBytes(JSON.stringify(body))));
}

function digestSectionText(text: string, hash: DaemonProjectionSectionSha256): string {
  return bytesToHex(hash(utf8ToBytes(text)));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pluginKey(key: string, value: unknown): string {
  const row = record(value);
  const identity = record(row?.identity) ?? record(row?.contribution) ?? record(record(row?.event)?.identity);
  return typeof row?.pluginId === 'string' ? row.pluginId
    : typeof identity?.pluginId === 'string' ? identity.pluginId : key.split('/')[0]!;
}

function frameProjectionFields(
  response: Record<string, unknown>,
  hash: DaemonProjectionSectionSha256,
  /** Records the body and returns its included-peer byte length. */
  onBody: (digest: string, spans: readonly string[], text: string) => number,
): DaemonContributionRegistryProjectionSectionsResponse {
  const parts: DaemonContributionRegistryProjectionSectionsResponse['parts'] = [];
  // Machine values repeat per entry (one availability per plugin, shared by
  // its Actions): carry each distinct value once and reference it by position.
  const valueTable: string[] = [];
  const valuePositions = new Map<string, number>();
  const valueRef = (text: string) => {
    let position = valuePositions.get(text);
    if (position === undefined) {
      position = valueTable.length;
      valueTable.push(text);
      valuePositions.set(text, position);
    }
    return position;
  };
  const pluginTable: string[] = [];
  const pluginRef = (pluginId: string) => {
    const position = pluginTable.indexOf(pluginId);
    return position < 0 ? pluginTable.push(pluginId) - 1 : position;
  };
  const literal = (text: string) => {
    const last = parts.length - 1;
    if (typeof parts[last] === 'string') parts[last] += text;
    else parts.push(text);
  };
  const section = (entries: readonly (readonly [string, unknown])[], array: boolean, pluginId: string) => {
    const body = [''];
    const values: number[] = [];
    const append = (text: string) => { body[body.length - 1] += text; };
    const write = (value: unknown): void => {
      if (Array.isArray(value)) {
        append('[');
        value.forEach((child, index) => { if (index) append(','); write(child ?? null); });
        append(']');
      } else {
        const object = record(value);
        if (!object) { append(JSON.stringify(value) ?? 'null'); return; }
        append('{');
        let first = true;
        for (const [key, child] of Object.entries(object)) {
          if (child === undefined) continue;
          if (!first) append(',');
          first = false;
          append(`${JSON.stringify(key)}:`);
          if (MACHINE_FIELDS.has(key)) { values.push(valueRef(JSON.stringify(child))); body.push(''); }
          else write(child);
        }
        append('}');
      }
    };
    entries.forEach(([key, value], index) => {
      if (index) append(',');
      if (!array) append(`${JSON.stringify(key)}:`);
      write(value);
    });
    const text = JSON.stringify(body);
    const digest = digestSectionText(text, hash);
    parts.push({ digest, values, peerBytes: onBody(digest, body, text), plugin: pluginRef(pluginId) });
  };
  const groups = (value: unknown, array = false) => {
    const entries = array && Array.isArray(value) ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(record(value) ?? {});
    literal(array ? '[' : '{');
    // Keep source order, including ordered Composer/Event catalogues. Adjacent
    // entries of one plugin form one section; no presentation ordering changes.
    let group: (readonly [string, unknown])[] = [];
    let previous: string | undefined;
    for (const [key, entry] of entries) {
      const plugin = pluginKey(key, entry);
      if (group.length && plugin !== previous) { section(group, array, previous!); literal(','); group = []; }
      group.push([key, entry]);
      previous = plugin;
    }
    if (group.length) section(group, array, previous!);
    literal(array ? ']' : '}');
  };
  const object = (value: Record<string, unknown>, visit: (key: string, child: unknown) => void) => {
    literal('{');
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) literal(',');
      first = false;
      literal(`${JSON.stringify(key)}:`);
      visit(key, child);
    }
    literal('}');
  };
  object(response, (key, value) => {
    if (key === 'projection') object(record(value)!, (field, child) => {
      if (field === 'familiesById') object(record(child)!, (_family, family) => object(record(family)!, (field, child) => {
        if (field === 'entriesById') groups(child);
        else literal(JSON.stringify(child));
      }));
      else if (field.endsWith('ById')) groups(child);
      else literal(JSON.stringify(child));
    });
    else if (key === 'composerSurfaceCatalog' || key === 'automationEligibleEvents') groups(value, true);
    else literal(JSON.stringify(value));
  });
  return { protocolVersion: 1, sectioned: true, ...(valueTable.length ? { values: valueTable } : {}),
    ...(pluginTable.length ? { plugins: pluginTable } : {}), parts };
}

// ORC's loaded first ACK was 3,148,652 encrypted bytes / 34.4 s. At that
// observed rate, 48 KiB JSON (~64 KiB encrypted) occupies <1 s of the ordered
// path, inside the requested 1–2 s heartbeat acceptance. This bounds a frame,
// never the declaration or operation: larger valid sections page to completion.
export const DAEMON_PROJECTION_SECTION_FRAME_BYTES = 48 * 1024;
/** The current immutable build cannot serve a previously advertised section. */
export const DAEMON_PROJECTION_SECTION_STALE_CODE = 'plugin_projection_section_stale';
const sectionDigest = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));
export const DaemonProjectionDeferredSectionsResponseSchema = lazyZodSchema(() => z.object({
  protocolVersion: z.literal(1), deferredSections: z.literal(true), projectionDigest: sectionDigest(),
  /** Section index frames travel as their raw index text, not wrapped in a JSON array. */
  sectionFrameVersion: z.literal(2),
  sections: z.record(z.string(), sectionDigest()),
  /**
   * Plugins with a Session-facing contribution (Session, message or Composer
   * Action placement, Session surfaces, header/info/activity rows, Composer and
   * drag/drop families). A Session reads only these plugins' selectable
   * sections. Absent from older daemons: a Session then reads whole sections.
   */
  sessionPluginIds: z.optional(z.array(z.string())),
}));
export type DaemonProjectionDeferredSectionsResponse = z.infer<typeof DaemonProjectionDeferredSectionsResponseSchema>;
export const DaemonProjectionSectionBodyResponseSchema = lazyZodSchema(() => z.object({
  protocolVersion: z.literal(1), sectionBody: z.literal(true), digest: sectionDigest(),
  offset: z.number().check(z.int(), z.minimum(0)), chunk: z.string(),
  nextOffset: z.nullable(z.number().check(z.int(), z.minimum(1))),
  bodies: z.optional(z.array(z.object({ digest: sectionDigest(), body: z.array(z.string()) }))),
}));

/** Same immutable build and same section bodies as round-7 framing; no second registry/store. */
export function buildDeferredDaemonProjectionSections(
  response: DaemonContributionRegistryProjectionDescribeResponse,
  options: Readonly<{ sha256?: DaemonProjectionSectionSha256 }> = {},
) {
  const hash = options.sha256 ?? sha256;
  const bodies = new Map<string, Readonly<{
    spans: readonly string[]; frame: boolean; text: string; peerByteLength: number;
  }>>();
  const addBody = (digest: string, spans: readonly string[], text: string, frame: boolean) => {
    // Replace the empty [] in the peer envelope with this body's prepared
    // encoding. Rejected peer candidates never need serialization per page.
    const peerByteLength = utf8ToBytes(JSON.stringify({ digest, body: [] })).length - 2 + utf8ToBytes(text).length;
    bodies.set(digest, { spans, frame, text, peerByteLength });
    return peerByteLength;
  };
  const sections: Record<string, string> = {};
  const add = (id: string, fields: Record<string, unknown>) => {
    const index = frameProjectionFields(fields, hash, (digest, spans, text) => addBody(digest, spans, text, false));
    const body = [JSON.stringify(index)];
    const text = JSON.stringify(body);
    const digest = digestSectionText(text, hash);
    addBody(digest, body, text, true);
    sections[id] = digest;
  };
  const { projection, ...siblings } = response;
  add('base', { protocolVersion: response.protocolVersion, projectionDigest: response.projectionDigest,
    projection: { v: projection.v, generation: projection.generation, diagnostics: projection.diagnostics } });
  for (const [field, value] of Object.entries(projection)) {
    if (field === 'v' || field === 'generation' || field === 'diagnostics') continue;
    if (field === 'familiesById') {
      for (const [family, value] of Object.entries(projection.familiesById)) {
        add(`familiesById.${family}`, { projection: { familiesById: { [family]: value } } });
      }
    } else add(field, { projection: { [field]: value } });
  }
  for (const [field, value] of Object.entries(siblings)) {
    if (field !== 'protocolVersion' && field !== 'projectionDigest') add(field, { [field]: value });
  }
  // Narrow Search: the search providers plus exactly the Actions they reference.
  const entriesById = Object.fromEntries(Object.entries(projection.familiesById.pluginUi?.entriesById ?? {})
    .filter(([, entry]) => entry.contributionKind === 'searchProvider'));
  // Select bodies by the providers' exact qualified Action references. Do
  // not hydrate or scan the Action/UI inventories in the consuming client.
  const actionsById: typeof projection.actionsById = {};
  for (const entry of Object.values(entriesById)) {
    // The closed search-provider arm already admitted this qualified reference.
    const { action } = entry as Extract<typeof entry, { contributionKind: 'searchProvider' }>;
    const key = buildQualifiedPluginContributionKey(action);
    if (projection.actionsById[key]) actionsById[key] = projection.actionsById[key]!;
  }
  add('searchProviders', { projection: { actionsById,
    familiesById: { pluginUi: { family: 'pluginUi', entriesById } } } });
  const manifest: DaemonProjectionDeferredSectionsResponse = {
    protocolVersion: 1, deferredSections: true, projectionDigest: response.projectionDigest!, sectionFrameVersion: 2, sections,
    sessionPluginIds: sessionFacingPluginIds(response),
  };
  return { manifest, read(digest: string, offset: number, includeDigests: readonly string[] = []) {
    const body = bodies.get(digest);
    if (!body) return null;
    // An index frame travels as its raw index text; its digest still covers the one-span array.
    const text = body.frame ? body.spans[0]! : body.text;
    if (offset < 0 || offset >= text.length) return null;
    const reply = (end: number) => ({ protocolVersion: 1 as const, sectionBody: true as const, digest, offset,
      chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null });
    // Keep a carrier whole whenever it fits. Reserve only forward progress
    // for a multi-page carrier so it cannot crowd every whole peer out.
    const carrierEnd = text.length - offset <= DAEMON_PROJECTION_SECTION_FRAME_BYTES
      && utf8ToBytes(JSON.stringify(reply(text.length))).length <= DAEMON_PROJECTION_SECTION_FRAME_BYTES
      ? text.length : offset + 1;
    const included: { digest: string; body: readonly string[] }[] = [];
    let includedPeerBytes = 0;
    const bodiesFieldBytes = utf8ToBytes(',"bodies":[]').length;
    const carrierByteLength = utf8ToBytes(JSON.stringify(reply(carrierEnd))).length;
    const seen = new Set([digest]);
    for (const digest of includeDigests) {
      if (seen.has(digest)) continue;
      seen.add(digest);
      const body = bodies.get(digest);
      if (!body) continue;
      // Whole peers take space before the carrier fills the remaining frame.
      // Otherwise a multi-page carrier crowds out every packable peer and
      // turns one shared demand into a singleton read for each declaration.
      if (carrierByteLength + bodiesFieldBytes + includedPeerBytes + body.peerByteLength + included.length <= DAEMON_PROJECTION_SECTION_FRAME_BYTES) {
        included.push({ digest, body: body.spans });
        includedPeerBytes += body.peerByteLength;
      }
    }
    const framedReply = (end: number) => included.length ? { ...reply(end), bodies: included } : reply(end);
    const includedBodiesBytes = included.length ? bodiesFieldBytes + includedPeerBytes + included.length - 1 : 0;
    let low = offset + 1;
    let high = Math.min(text.length, offset + DAEMON_PROJECTION_SECTION_FRAME_BYTES);
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (utf8ToBytes(JSON.stringify(reply(mid))).length + includedBodiesBytes <= DAEMON_PROJECTION_SECTION_FRAME_BYTES) low = mid + 1;
      else high = mid - 1;
    }
    return framedReply(high);
  } };
}

/** Sections a reader may read for selected plugins only: `${section}#${pluginId}`. */
export const DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS = ['actionsById', 'resourcesById', 'familiesById.pluginUi'] as const;
/** Plugin token resolved against the manifest's `sessionPluginIds`. Never a plugin id (they start with a letter). */
export const DAEMON_PROJECTION_SESSION_PLUGINS = '@session';
export function daemonProjectionPluginSectionId(section: (typeof DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS)[number], pluginId: string): string {
  return `${section}#${pluginId}`;
}
function parsePluginSectionId(id: string): Readonly<{ section: string; pluginId: string | null }> {
  const at = id.indexOf('#');
  return at < 0 ? { section: id, pluginId: null } : { section: id.slice(0, at), pluginId: id.slice(at + 1) };
}

// Input types are not Session-facing by themselves: an open picker reads its own catalogue.
const SESSION_FAMILIES = ['composerControls', 'composerRegions', 'composerAttachments',
  'dropTargets', 'dragSources', 'workItems'] as const;
const SESSION_UI_KINDS = new Set(['sessionHeaderAction', 'sessionInfoSection', 'transcriptActivity']);
/** The one producer rule for which plugins a Session presents. */
function sessionFacingPluginIds(response: DaemonContributionRegistryProjectionDescribeResponse): string[] {
  const plugins = new Set<string>();
  for (const [key, action] of Object.entries(response.projection.actionsById)) {
    if (action.scopes.some(scope => scope === 'session' || scope === 'message')
      || (action.placementBindings ?? []).some(binding => binding.startsWith('composer.') || binding.startsWith('message.'))) {
      plugins.add(pluginKey(key, action));
    }
  }
  for (const [key, entry] of Object.entries(response.projection.familiesById.pluginUi?.entriesById ?? {})) {
    const row = record(entry);
    const binding = record(row?.binding);
    if (SESSION_UI_KINDS.has(String(row?.contributionKind))
      || (row?.contributionKind === 'surfacePlacement' && binding?.targetKind === 'session')) plugins.add(pluginKey(key, entry));
  }
  for (const family of SESSION_FAMILIES) {
    for (const [key, entry] of Object.entries(record(record(record(response.projection.familiesById)?.[family])?.entriesById) ?? {})) {
      plugins.add(pluginKey(key, entry));
    }
  }
  for (const [index, entry] of (response.composerSurfaceCatalog ?? []).entries()) plugins.add(pluginKey(String(index), entry));
  return [...plugins].sort();
}

/** Demand is explicit; absent declarations are never advertised as complete. */
export function demandedDaemonProjectionSections(manifest: DaemonProjectionDeferredSectionsResponse, sections?: readonly string[]): readonly string[] {
  const requested = sections === undefined ? Object.keys(manifest.sections).filter(id => id !== 'searchProviders') : sections;
  // A Session token reads the manifest's Session plugins; an older manifest without them reads the section.
  const demand = requested.flatMap(id => {
    const { section, pluginId } = parsePluginSectionId(id);
    if (pluginId !== DAEMON_PROJECTION_SESSION_PLUGINS) return [id];
    return manifest.sessionPluginIds ? manifest.sessionPluginIds.map(plugin => `${section}#${plugin}`) : [section];
  });
  const whole = new Set(demand.filter(id => parsePluginSectionId(id).pluginId === null));
  // Overlapping narrow fragments assemble first so a combined demand keeps
  // the complete Action/UI catalogues, regardless of the caller's order.
  return [...new Set(['base', 'installedPackagesById',
    ...(demand.includes('searchProviders') ? ['searchProviders'] : []), ...demand])].filter(id => {
    const { section, pluginId } = parsePluginSectionId(id);
    return section in manifest.sections && (pluginId === null || !whole.has(section));
  });
}

/** Complete catalogues cover narrow Search and every plugin slice; a slice never claims the whole section. */
export function daemonProjectionSectionsCover(
  manifest: DaemonProjectionDeferredSectionsResponse,
  loaded: readonly string[],
  requested?: readonly string[],
): boolean {
  return demandedDaemonProjectionSections(manifest, requested).every(id => loaded.includes(id)
    || (parsePluginSectionId(id).pluginId !== null && loaded.includes(parsePluginSectionId(id).section))
    || (id === 'searchProviders' && loaded.includes('actionsById') && loaded.includes('familiesById.pluginUi')));
}

/**
 * Which plugins a loaded answer holds for one selectable section: `'all'`,
 * the loaded plugin slices, or null when the section was not read. A plugin
 * outside a slice set is not loaded, never absent.
 */
export function readDaemonProjectionSectionPlugins(loaded: readonly string[], section: string): 'all' | ReadonlySet<string> | null {
  if (loaded.includes(section)) return 'all';
  const plugins = loaded.flatMap(id => {
    const parsed = parsePluginSectionId(id);
    return parsed.section === section && parsed.pluginId !== null ? [parsed.pluginId] : [];
  });
  return plugins.length ? new Set(plugins) : null;
}

/** The plugin whose bodies an index part groups; undefined for an older untagged part. */
export function readDaemonProjectionSectionPartPlugin(
  index: DaemonContributionRegistryProjectionSectionsResponse,
  part: DaemonContributionRegistryProjectionSection,
): string | undefined {
  return part.plugin === undefined ? undefined : index.plugins?.[part.plugin];
}

/** The section a (possibly plugin-sliced) demand id reads, and the plugin it selects. */
export function readDaemonProjectionSectionDemand(id: string): Readonly<{ section: string; pluginId: string | null }> {
  return parsePluginSectionId(id);
}

/**
 * Bodies come only from the caller's digest-verified holdings. No property
 * writes or evaluation: the canonical describe parser admits the result.
 */
export function reassembleDaemonProjectionSections(
  response: DaemonContributionRegistryProjectionSectionsResponse,
  held: ReadonlyMap<string, readonly string[]>,
  /** Assemble only these plugins' bodies; untagged (older) parts always assemble. */
  pluginIds?: ReadonlySet<string>,
): Readonly<{ response: unknown }> | null {
  const text: string[] = [];
  // Adjacent plugin bodies are separated by exactly one "," literal. A
  // selected run re-joins its kept bodies so dropped plugins leave no gap.
  let run: string[] | null = null;
  const flush = () => { if (run) { text.push(run.join(',')); run = null; } };
  const parts = response.parts;
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at]!;
    if (typeof part === 'string') {
      const next = parts[at + 1];
      if (part === ',' && run && next !== undefined && typeof next !== 'string') continue;
      flush();
      text.push(part);
      continue;
    }
    run ??= [];
    const plugin = readDaemonProjectionSectionPartPlugin(response, part);
    if (pluginIds && part.plugin !== undefined && (plugin === undefined || !pluginIds.has(plugin))) continue;
    const body = held.get(part.digest);
    if (!body || body.length !== part.values.length + 1) return null;
    const assembled: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
      assembled.push(body[index]!);
      if (index === part.values.length) break;
      const value = part.values[index]!;
      const resolved = typeof value === 'number' ? response.values?.[value] : value;
      if (resolved === undefined) return null;
      assembled.push(resolved);
    }
    run.push(assembled.join(''));
  }
  flush();
  try { return { response: JSON.parse(text.join('')) }; } catch { return null; }
}
