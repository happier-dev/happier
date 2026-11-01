import { z } from 'zod/mini';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { DaemonContributionRegistryProjectionDescribeResponse } from './contributionRegistryProjection.js';

/** Transport framing only. Reassembly still requires the complete describe schema. */
export const DaemonContributionRegistryProjectionSectionsResponseSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  sectioned: z.literal(true),
  parts: z.array(z.union([z.string(), z.strictObject({
    digest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
    body: z.optional(z.array(z.string())),
    values: z.array(z.string()),
  })])),
}));
export type DaemonContributionRegistryProjectionSectionsResponse = z.infer<typeof DaemonContributionRegistryProjectionSectionsResponseSchema>;
export type DaemonContributionRegistryProjectionSection = Exclude<DaemonContributionRegistryProjectionSectionsResponse['parts'][number], string>;

// These facts always travel with the answering Machine, even when their current
// values happen to match another Machine. This is byte sharing, not admission.
const MACHINE_FIELDS = new Set(['executionOrigin', 'contributorTargetedContributions', 'availability', 'available',
  'authorization', 'occurrenceId', 'sourceCustody', 'projectionGeneration', 'generation', 'diagnostics',
  'contributionIntrospection', 'targetGeneration', 'desiredGeneration']);

export function computeDaemonProjectionSectionDigest(body: readonly string[]): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(body))));
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

/** Built once with the daemon's existing immutable full-response build. */
export function buildDaemonProjectionSections(
  response: DaemonContributionRegistryProjectionDescribeResponse,
): DaemonContributionRegistryProjectionSectionsResponse {
  return frameProjectionFields(response);
}

function frameProjectionFields(response: Record<string, unknown>): DaemonContributionRegistryProjectionSectionsResponse {
  const parts: DaemonContributionRegistryProjectionSectionsResponse['parts'] = [];
  const literal = (text: string) => {
    const last = parts.length - 1;
    if (typeof parts[last] === 'string') parts[last] += text;
    else parts.push(text);
  };
  const section = (entries: readonly (readonly [string, unknown])[], array: boolean) => {
    const body = [''];
    const values: string[] = [];
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
          if (MACHINE_FIELDS.has(key)) { values.push(JSON.stringify(child)); body.push(''); }
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
    parts.push({ digest: computeDaemonProjectionSectionDigest(body), body, values });
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
      if (group.length && plugin !== previous) { section(group, array); literal(','); group = []; }
      group.push([key, entry]);
      previous = plugin;
    }
    if (group.length) section(group, array);
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
  return { protocolVersion: 1, sectioned: true, parts };
}

// ORC's loaded first ACK was 3,148,652 encrypted bytes / 34.4 s. At that
// observed rate, 48 KiB JSON (~64 KiB encrypted) occupies <1 s of the ordered
// path, inside the requested 1–2 s heartbeat acceptance. This bounds a frame,
// never the declaration or operation: larger valid sections page to completion.
export const DAEMON_PROJECTION_SECTION_FRAME_BYTES = 48 * 1024;
/** The current immutable build cannot serve a previously advertised section. */
export const DAEMON_PROJECTION_SECTION_STALE_CODE = 'plugin_projection_section_stale';
const sectionDigest = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));
export const DaemonProjectionDeferredSectionsResponseSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1), deferredSections: z.literal(true), projectionDigest: sectionDigest(),
  /** Present only when the caller offered this version; old manifests remain closed. */
  sectionFrameVersion: z.optional(z.literal(2)),
  sections: z.record(z.string(), sectionDigest()),
}));
export type DaemonProjectionDeferredSectionsResponse = z.infer<typeof DaemonProjectionDeferredSectionsResponseSchema>;
export const DaemonProjectionSectionBodyResponseSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1), sectionBody: z.literal(true), digest: sectionDigest(),
  offset: z.number().check(z.int(), z.minimum(0)), chunk: z.string(),
  nextOffset: z.nullable(z.number().check(z.int(), z.minimum(1))),
  bodies: z.optional(z.array(z.strictObject({ digest: sectionDigest(), body: z.array(z.string()) }))),
}));

/** Same immutable build and same section bodies as round-7 framing; no second registry/store. */
export function buildDeferredDaemonProjectionSections(response: DaemonContributionRegistryProjectionDescribeResponse) {
  const bodies = new Map<string, Readonly<{ spans: readonly string[]; frame: boolean }>>();
  const sections: Record<string, string> = {};
  const add = (id: string, fields: Record<string, unknown>) => {
    const framed = frameProjectionFields(fields);
    const reference = omitKnownDaemonProjectionSectionBodies(framed,
      framed.parts.flatMap(part => typeof part === 'string' ? [] : [part.digest]));
    for (const part of framed.parts) if (typeof part !== 'string' && part.body) bodies.set(part.digest, { spans: part.body, frame: false });
    const body = [JSON.stringify(reference)];
    const digest = computeDaemonProjectionSectionDigest(body);
    bodies.set(digest, { spans: body, frame: true });
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
  const manifest: DaemonProjectionDeferredSectionsResponse = {
    protocolVersion: 1, deferredSections: true, projectionDigest: response.projectionDigest!, sections,
  };
  // Body text is prepared only on first use, once per current immutable build.
  const texts = new Map<string, string>();
  return { manifest, read(digest: string, offset: number, includeDigests: readonly string[] = [], sectionFrameVersion?: 2) {
    const body = bodies.get(digest);
    if (!body) return null;
    const rawFrame = body.frame && sectionFrameVersion === 2;
    const textKey = rawFrame ? `${digest}:2` : digest;
    let text = texts.get(textKey);
    // Version 2 avoids the redundant JSON-array wrapper around an index.
    // Keep the prior encoding for UI-ahead-of-daemon QA and old UI readers;
    // remove it once both sides on every QA stack negotiate version 2.
    if (text === undefined) { text = rawFrame ? body.spans[0]! : JSON.stringify(body.spans); texts.set(textKey, text); }
    if (offset < 0 || offset >= text.length) return null;
    const reply = (end: number) => ({ protocolVersion: 1 as const, sectionBody: true as const, digest, offset,
      chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null });
    // Keep a carrier whole whenever it fits. Reserve only forward progress
    // for a multi-page carrier so it cannot crowd every whole peer out.
    const carrierEnd = text.length - offset <= DAEMON_PROJECTION_SECTION_FRAME_BYTES
      && utf8ToBytes(JSON.stringify(reply(text.length))).length <= DAEMON_PROJECTION_SECTION_FRAME_BYTES
      ? text.length : offset + 1;
    const included: { digest: string; body: readonly string[] }[] = [];
    const seen = new Set([digest]);
    for (const digest of includeDigests) {
      if (seen.has(digest)) continue;
      seen.add(digest);
      const body = bodies.get(digest)?.spans;
      if (!body) continue;
      const candidate = [...included, { digest, body }];
      // Whole peers take space before the carrier fills the remaining frame.
      // Otherwise a multi-page carrier crowds out every packable peer and
      // turns one shared demand into a singleton read for each declaration.
      if (utf8ToBytes(JSON.stringify({ ...reply(carrierEnd), bodies: candidate })).length <= DAEMON_PROJECTION_SECTION_FRAME_BYTES) {
        included.push({ digest, body });
      }
    }
    const framedReply = (end: number) => included.length ? { ...reply(end), bodies: included } : reply(end);
    let low = offset + 1;
    let high = Math.min(text.length, offset + DAEMON_PROJECTION_SECTION_FRAME_BYTES);
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (utf8ToBytes(JSON.stringify(framedReply(mid))).length <= DAEMON_PROJECTION_SECTION_FRAME_BYTES) low = mid + 1;
      else high = mid - 1;
    }
    return framedReply(high);
  } };
}

/** Demand is explicit; absent declarations are never advertised as complete. */
export function demandedDaemonProjectionSections(manifest: DaemonProjectionDeferredSectionsResponse, sections?: readonly string[]): readonly string[] {
  return sections === undefined ? Object.keys(manifest.sections)
    : [...new Set(['base', 'installedPackagesById', ...sections])].filter(id => id in manifest.sections);
}

export function omitKnownDaemonProjectionSectionBodies(
  response: DaemonContributionRegistryProjectionSectionsResponse,
  knownDigests: readonly string[],
): DaemonContributionRegistryProjectionSectionsResponse {
  const known = new Set(knownDigests);
  return { ...response, parts: response.parts.map(part => typeof part === 'string' || !known.has(part.digest)
    ? part : { digest: part.digest, values: part.values }) };
}

/** No property writes or evaluation: the canonical describe parser admits the result. */
export function reassembleDaemonProjectionSections(
  response: DaemonContributionRegistryProjectionSectionsResponse,
  held: ReadonlyMap<string, readonly string[]>,
): Readonly<{ response: unknown; bodies: ReadonlyMap<string, readonly string[]> }> | null {
  const bodies = new Map<string, readonly string[]>();
  const text: string[] = [];
  for (const part of response.parts) {
    if (typeof part === 'string') { text.push(part); continue; }
    const previous = bodies.get(part.digest) ?? held.get(part.digest);
    const body = part.body ?? previous;
    if (!body || body.length !== part.values.length + 1
      || (part.body && computeDaemonProjectionSectionDigest(part.body) !== part.digest)) return null;
    bodies.set(part.digest, previous ?? body);
    body.forEach((span, index) => { text.push(span); if (index < part.values.length) text.push(part.values[index]!); });
  }
  try { return { response: JSON.parse(text.join('')), bodies }; } catch { return null; }
}
