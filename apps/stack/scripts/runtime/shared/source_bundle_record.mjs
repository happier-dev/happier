import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readSourceRuntimeBundleRecord(entrypoint) {
  return entrypoint
    ? await readOptionalJson(join(resolve(dirname(entrypoint), '../../..'), 'source-bundle.json'))
    : null;
}

export async function readSelectedSourceRuntimeRecord({ stackBaseDir, component, required = true }) {
  const selected = await readOptionalJson(join(stackBaseDir, 'source-runtime', `selected-${component}.json`));
  if (!selected && !required) return null;
  const record = await readSourceRuntimeBundleRecord(selected?.entrypoint);
  if (!record?.identity || record.entrypoint !== selected?.entrypoint || !existsSync(record.entrypoint)) {
    throw Object.assign(
      new Error(`[source-bundle] selected source ${component} bundle is unavailable; explicitly restart the Stack to select current source`),
      { code: 'source_bundle_unavailable' },
    );
  }
  return record;
}

function normalizeSourceCapture(value) {
  if (!value || typeof value !== 'object' || typeof value.inputIdentity !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.inputIdentity) || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))) return null;
  return { inputIdentity: value.inputIdentity, capturedAt: new Date(value.capturedAt).toISOString() };
}

/** Capture metadata belongs to the exact immutable product, never its file mtime. */
async function readSourceRuntimeSourceCapture({ stackBaseDir, component, identity, entrypoint, uiDir }) {
  try {
    if (uiDir) {
      const completionPath = join(dirname(resolve(uiDir)), 'source-bundle.json');
      const record = await readOptionalJson(completionPath);
      if (record?.component !== 'web' || record.uiDir !== resolve(uiDir)) return null;
      return normalizeSourceCapture(record.sourceCapture);
    }
    if (!identity) return null;
    const record = entrypoint ? await readSourceRuntimeBundleRecord(entrypoint)
      : await readSelectedSourceRuntimeRecord({ stackBaseDir, component, required: false });
    if (record?.identity !== identity) return null;
    return normalizeSourceCapture(record?.sourceCapture);
  } catch { return null; }
}

export async function readSourceRuntimeSourceTime(input) {
  return (await readSourceRuntimeSourceCapture(input))?.capturedAt ?? null;
}

export function formatSourceRuntimeSourceTimes(sourceTimes, sourceCaptures = {}) {
  const entries = Object.entries(sourceTimes ?? {});
  if (!entries.length) return '';
  const identities = Object.entries(sourceCaptures).map(([component, capture]) =>
    `${component}=${normalizeSourceCapture(capture)?.inputIdentity ?? 'unknown'}`);
  return `sourceTime ${entries.map(([component, time]) => `${component}=${time ?? 'unknown'}`).join(' ')}`
    + (identities.length ? ` inputIdentity ${identities.join(' ')}` : '');
}

const SOURCE_TIMES_MARKER = 'HSTACK_SOURCE_RELOAD_SOURCE_TIMES=';

function normalizeSourceTimes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(['server', 'daemon', 'ui'].filter(component => Object.hasOwn(value, component))
    .map(component => [component, typeof value[component] === 'string' && Number.isFinite(Date.parse(value[component]))
      ? new Date(value[component]).toISOString() : null]));
}

/** Additive metadata on the existing prepared worker pipe; older workers omit it. */
export function parseSourceRuntimeSourceTimesLine(line) {
  if (!line.startsWith(SOURCE_TIMES_MARKER)) return null;
  try { return normalizeSourceTimes(JSON.parse(line.slice(SOURCE_TIMES_MARKER.length))); }
  catch { return null; }
}

export function parseSourceRuntimeSourceCapturesLine(line) {
  if (!line.startsWith(SOURCE_TIMES_MARKER)) return null;
  try { return normalizeSourceCaptures(JSON.parse(line.slice(SOURCE_TIMES_MARKER.length)).sourceCaptures); }
  catch { return null; }
}

function normalizeSourceCaptures(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(['server', 'daemon', 'ui'].flatMap(component => {
    const capture = normalizeSourceCapture(value[component]);
    return capture ? [[component, capture]] : [];
  }));
}

export function emitSourceRuntimeSourceTimes(sourceTimes, sourceCaptures = {}) {
  process.stdout.write(`${SOURCE_TIMES_MARKER}${JSON.stringify({ ...normalizeSourceTimes(sourceTimes),
    sourceCaptures: normalizeSourceCaptures(sourceCaptures) })}\n`);
}
