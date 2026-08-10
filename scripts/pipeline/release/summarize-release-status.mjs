#!/usr/bin/env node

// @ts-check

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const RESULT_VALUES = new Set(['success', 'accepted', 'pending', 'failed', 'skipped']);
const TOP_LEVEL_KEYS = new Set(['operationId', 'run', 'channel', 'sourceSha', 'requestedSurfaces', 'surfaces']);
const REQUESTED_SURFACE_KEYS = new Set(['id', 'requested', 'required', 'evidence']);
const OBSERVED_SURFACE_KEYS = new Set(['id', 'result', 'identity', 'recoveryHint']);
const RUN_KEYS = new Set(['id', 'url', 'name']);
const SURFACE_EVIDENCE_VALUES = new Set(['verified', 'accepted']);
const OPERATION_ID_PATTERN = /^rel_[A-Za-z0-9_-]{8,80}$/u;

const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_ARRAY_ITEMS = 64;
const MAX_METADATA_STRING_LENGTH = 4096;
const MAX_METADATA_NODES = 256;

/** @param {unknown} value */
function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {Record<string, unknown>} record
 * @param {Set<string>} allowed
 * @param {string} label
 */
function rejectUnknownKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`[release] ${label} contains unknown field: ${key}`);
    }
  }
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\s/u.test(value)) {
    throw new Error(`[release] ${label} must be a non-empty whitespace-free string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireTrimmedString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`[release] ${label} must be a non-empty trimmed string`);
  }
  return value;
}

/** @param {unknown} value */
function normalizeOperationId(value) {
  if (value === undefined) return undefined;
  const operationId = requireNonEmptyString(value, 'operationId');
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('[release] operationId must match rel_<8-80 URL-safe characters>');
  }
  return operationId;
}

/** @param {unknown} value @param {string | undefined} operationId */
function normalizeRun(value, operationId) {
  if (!isRecord(value)) throw new Error('[release] run must be a GitHub Actions run object');
  rejectUnknownKeys(value, RUN_KEYS, 'run');
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error('[release] run.id must be a positive safe integer');
  }
  const url = requireNonEmptyString(value.url, 'run.url');
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('[release] run.url must be an HTTPS GitHub Actions run URL');
  }
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.hostname !== 'github.com'
    || parsedUrl.search
    || parsedUrl.hash
    || !new RegExp(`^/[^/]+/[^/]+/actions/runs/${value.id}$`, 'u').test(parsedUrl.pathname)
  ) {
    throw new Error('[release] run.url must identify run.id on github.com');
  }
  const name = requireTrimmedString(value.name, 'run.name');
  if (name.length > 512) throw new Error('[release] run.name exceeds the bounded length');
  if (operationId && !name.includes(operationId)) {
    throw new Error('[release] run.name must contain operationId when an operation is supplied');
  }
  return { id: value.id, url, name };
}

/**
 * Clone a JSON metadata value with a small, explicit bound. Identity and
 * recovery hints are facts emitted by surface owners; this helper preserves
 * those facts without allowing an unbounded nested payload into the summary.
 *
 * @param {unknown} value
 * @param {string} label
 */
function cloneBoundedMetadata(value, label) {
  let nodes = 0;

  /** @param {unknown} current @param {number} depth @param {string} currentLabel */
  function clone(current, depth, currentLabel) {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) {
      throw new Error(`[release] ${label} exceeds the metadata bound`);
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (current.length > MAX_METADATA_STRING_LENGTH) {
        throw new Error(`[release] ${currentLabel} exceeds the metadata string bound`);
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new Error(`[release] ${currentLabel} must contain finite JSON numbers`);
      }
      return current;
    }
    if (depth >= MAX_METADATA_DEPTH) {
      throw new Error(`[release] ${currentLabel} exceeds the metadata depth bound`);
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_METADATA_ARRAY_ITEMS) {
        throw new Error(`[release] ${currentLabel} exceeds the metadata array bound`);
      }
      return current.map((entry, index) => clone(entry, depth + 1, `${currentLabel}[${index}]`));
    }
    if (!isRecord(current)) {
      throw new Error(`[release] ${currentLabel} must contain JSON values`);
    }
    const keys = Object.keys(current);
    if (keys.length > MAX_METADATA_KEYS) {
      throw new Error(`[release] ${currentLabel} exceeds the metadata key bound`);
    }
    const output = {};
    for (const key of keys.sort()) {
      if (key.length > 128) {
        throw new Error(`[release] ${currentLabel} contains an oversized key`);
      }
      output[key] = clone(current[key], depth + 1, `${currentLabel}.${key}`);
    }
    return output;
  }

  return clone(value, 0, label);
}

/** @param {unknown} value @param {string} label */
function normalizeSurfaceId(value, label) {
  return requireNonEmptyString(value, label);
}

/**
 * @typedef {{ id: string; requested: boolean; required: boolean; evidence: 'verified' | 'accepted' }} RequestedSurface
 * @typedef {{ id: string; result: 'success'|'accepted'|'pending'|'failed'|'skipped'; identity?: unknown; recoveryHint?: unknown }} ObservedSurface
 */

/** @param {unknown} value */
function parseRequestedSurfaces(value) {
  if (!Array.isArray(value)) {
    throw new Error('[release] requestedSurfaces must be an array');
  }
  /** @type {RequestedSurface[]} */
  const surfaces = [];
  const ids = new Set();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`[release] requestedSurfaces[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, REQUESTED_SURFACE_KEYS, `requestedSurfaces[${index}]`);
    const id = normalizeSurfaceId(entry.id, `requestedSurfaces[${index}].id`);
    if (ids.has(id)) {
      throw new Error(`[release] duplicate requested surface: ${id}`);
    }
    if (typeof entry.required !== 'boolean') {
      throw new Error(`[release] requestedSurfaces[${index}].required must be boolean`);
    }
    if (typeof entry.evidence !== 'string' || !SURFACE_EVIDENCE_VALUES.has(entry.evidence)) {
      throw new Error(`[release] requestedSurfaces[${index}].evidence must be verified or accepted`);
    }
    const requested = entry.requested === undefined ? true : entry.requested;
    if (typeof requested !== 'boolean') {
      throw new Error(`[release] requestedSurfaces[${index}].requested must be boolean`);
    }
    ids.add(id);
    surfaces.push({
      id,
      requested,
      required: entry.required,
      evidence: /** @type {'verified' | 'accepted'} */ (entry.evidence),
    });
  }
  return surfaces;
}

/** @param {unknown} value @param {Set<string>} declaredIds */
function parseObservedSurfaces(value, declaredIds) {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) {
    throw new Error('[release] surfaces must be an array');
  }
  /** @type {Map<string, ObservedSurface>} */
  const surfaces = new Map();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`[release] surfaces[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, OBSERVED_SURFACE_KEYS, `surfaces[${index}]`);
    const id = normalizeSurfaceId(entry.id, `surfaces[${index}].id`);
    if (!declaredIds.has(id)) {
      throw new Error(`[release] observed surface is not declared: ${id}`);
    }
    if (surfaces.has(id)) {
      throw new Error(`[release] duplicate observed surface: ${id}`);
    }
    if (typeof entry.result !== 'string' || !RESULT_VALUES.has(entry.result)) {
      throw new Error(`[release] surfaces[${index}].result must be one of ${[...RESULT_VALUES].join(', ')}`);
    }
    if (entry.identity !== undefined && !isRecord(entry.identity) && entry.identity !== null) {
      throw new Error(`[release] surfaces[${index}].identity must be a JSON object or null`);
    }
    if (entry.recoveryHint !== undefined) {
      // cloneBoundedMetadata validates and bounds the hint now; it is cloned
      // again while projecting so output key order is deterministic.
      cloneBoundedMetadata(entry.recoveryHint, `surfaces[${index}].recoveryHint`);
    }
    if (entry.identity !== undefined) {
      cloneBoundedMetadata(entry.identity, `surfaces[${index}].identity`);
    }
    surfaces.set(id, /** @type {ObservedSurface} */ ({
      id,
      result: /** @type {ObservedSurface['result']} */ (entry.result),
      ...(Object.hasOwn(entry, 'identity') ? { identity: entry.identity } : {}),
      ...(Object.hasOwn(entry, 'recoveryHint') ? { recoveryHint: entry.recoveryHint } : {}),
    }));
  }
  return surfaces;
}

/** @param {RequestedSurface} requested @param {ObservedSurface | undefined} observed */
function hasRequiredEvidence(requested, observed) {
  if (observed === undefined) return false;
  if (requested.evidence === 'accepted') return observed.result === 'accepted';
  return observed.result === 'success'
    && isRecord(observed.identity)
    && observed.identity.verified === true;
}

/** @param {RequestedSurface} requested @param {ObservedSurface | undefined} observed */
function deriveSurfaceState(requested, observed) {
  if (!requested.requested) return 'not_requested';
  if (observed === undefined) return requested.required ? 'failed' : 'partial';
  if (hasRequiredEvidence(requested, observed)) {
    return requested.evidence === 'accepted' ? 'published' : 'complete';
  }
  if (observed.result === 'failed') return 'failed';
  if (observed.result === 'skipped') return requested.required ? 'failed' : 'partial';
  return 'partial';
}

/**
 * @param {RequestedSurface[]} requestedSurfaces
 * @param {Map<string, ObservedSurface>} observedSurfaces
 */
function projectSurfaces(requestedSurfaces, observedSurfaces) {
  let hasSelectedFailure = false;
  let hasPartial = false;
  let hasPublished = false;
  const surfaces = requestedSurfaces.map((requested) => {
    const observed = observedSurfaces.get(requested.id);
    const state = deriveSurfaceState(requested, observed);
    /** @type {Record<string, unknown>} */
    const projected = {
      id: requested.id,
      requested: requested.requested,
      required: requested.required,
      evidence: requested.evidence,
      state,
    };
    if (requested.requested && observed !== undefined) {
      projected.result = observed.result;
      if (Object.hasOwn(observed, 'identity')) {
        projected.identity = cloneBoundedMetadata(observed.identity, `surfaces.${requested.id}.identity`);
      }
      if (Object.hasOwn(observed, 'recoveryHint')) {
        projected.recoveryHint = cloneBoundedMetadata(observed.recoveryHint, `surfaces.${requested.id}.recoveryHint`);
      }
    }
    if (requested.requested && state === 'failed') {
      hasSelectedFailure = true;
    }
    if (requested.requested && state === 'published') {
      hasPublished = true;
    }
    if (requested.requested && (state === 'partial' || (!requested.required && state === 'failed'))) {
      hasPartial = true;
    }
    return projected;
  });
  return {
    surfaces,
    terminal: hasSelectedFailure ? 'failed' : hasPartial ? 'partial' : hasPublished ? 'published' : 'complete',
  };
}

/**
 * Summarize one explicit release observation set. The requested surface
 * catalog is authoritative: observations may not introduce another surface,
 * and output order follows that catalog exactly.
 *
 * @param {unknown} value
 */
export function summarizeReleaseStatus(value) {
  if (!isRecord(value)) throw new Error('[release] input must be a JSON object');
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, 'input');
  const operationId = normalizeOperationId(value.operationId);
  const run = normalizeRun(value.run, operationId);
  const channel = requireNonEmptyString(value.channel, 'channel');
  const sourceSha = requireNonEmptyString(value.sourceSha, 'sourceSha');
  const requestedSurfaces = parseRequestedSurfaces(value.requestedSurfaces);
  const declaredIds = new Set(requestedSurfaces.map((surface) => surface.id));
  const observedSurfaces = parseObservedSurfaces(value.surfaces, declaredIds);
  const projection = projectSurfaces(requestedSurfaces, observedSurfaces);

  return {
    schemaVersion: 1,
    kind: 'happier.release-status.v1',
    ...(operationId ? { operationId } : {}),
    run,
    channel,
    sourceSha,
    surfaces: projection.surfaces,
    terminal: projection.terminal,
  };
}

/** @param {string} inputPath */
async function readJsonInput(inputPath) {
  let text;
  if (inputPath && inputPath !== '-') {
    text = await readFile(inputPath, 'utf8');
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text.trim()) throw new Error('[release] JSON input is empty');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`[release] invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} outputPath @param {string} text */
async function writeJsonOutput(outputPath, text) {
  if (outputPath && outputPath !== '-') {
    await writeFile(outputPath, text, 'utf8');
    return;
  }
  process.stdout.write(text);
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const inputPath = values.input === undefined ? '-' : String(values.input);
  const outputPath = values.out === undefined ? '-' : String(values.out);
  const summary = summarizeReleaseStatus(await readJsonInput(inputPath));
  await writeJsonOutput(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
