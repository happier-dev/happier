// @ts-check
// Deterministic web boot weight of a built web export: what loads before Home
// (modules, JS/CSS bytes, brotli transfer bytes), every route's own chunk and the
// shared chunks it needs first, plus all emitted JS/CSS bytes, compared with the
// exact base commit's measurement when one is supplied.
// Measurement and comparison belong to apps/stack/scripts/perf/regression.mjs
// (the same owner perf-validate uses); this entry only reads the release
// tarball or export directory, writes the small JSON and the Markdown diff.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessBundleBudget, readProductionBundleSize, readWebBootWeight, renderPerfComparison } from '../../../apps/stack/scripts/perf/regression.mjs';

/**
 * Bump when the measurement definition changes; older baselines are then not compared.
 * v2: counts the shared `__common` chunk the Home route chunks require (no longer an
 * index.html script) and adds the per-route table.
 */
export const WEB_BOOT_WEIGHT_VERSION = 2;

/** @param {string} root */
export async function measureWebExport(root, sha = null) {
  const { bytes } = await readProductionBundleSize(root);
  return { version: WEB_BOOT_WEIGHT_VERSION, sha, bytes, boot: await readWebBootWeight(root) };
}

const fileName = (/** @type {string} */ file) => file.split('/').at(-1);

/**
 * Route rows: in the PR comment only routes whose own chunk changed against the base
 * (a comment holds at most 65,536 characters; an export has hundreds of routes); the
 * full table on request (job summary, nightly).
 * @param {any} candidate @param {any} baseline @param {boolean} allRoutes
 */
function renderRoutes(candidate, baseline, allRoutes) {
  const routes = candidate.boot.routes ?? {};
  const keys = Object.keys(routes);
  const lines = [];
  const before = baseline?.boot?.routes;
  if (before) {
    const changed = [...new Set([...keys, ...Object.keys(before)])]
      .filter(key => routes[key]?.bytes !== before[key]?.bytes || routes[key]?.brotliBytes !== before[key]?.brotliBytes);
    lines.push(`Routes whose own chunk changed: ${changed.length} of ${keys.length}.`, '');
    if (changed.length) {
      lines.push('| Route | Base bytes | Bytes | Delta | Base brotli | Brotli |', '| --- | ---: | ---: | ---: | ---: | ---: |');
      for (const key of changed) {
        const a = before[key], b = routes[key];
        lines.push(`| \`${key}\` | ${a?.bytes ?? 'unavailable'} | ${b?.bytes ?? 'unavailable'} | ${a && b ? b.bytes - a.bytes : 'unavailable'} | ${a?.brotliBytes ?? 'unavailable'} | ${b?.brotliBytes ?? 'unavailable'} |`);
      }
      lines.push('');
    }
  } else lines.push(`Routes: ${keys.length}; no exact-base route measurement, so no route deltas.`, '');
  if (allRoutes && keys.length) {
    lines.push('<details><summary>Every route: own chunk and the shared chunks it needs first</summary>', '',
      '| Route | Own chunk | Modules | Bytes | Brotli bytes | Shared chunks |', '| --- | --- | ---: | ---: | ---: | --- |');
    for (const key of keys) {
      const row = routes[key];
      const list = (/** @type {string[]} */ files) => files.length ? files.map(file => `\`${fileName(file)}\``).join(', ') : 'none';
      lines.push(`| \`${key}\` | ${row.files.length ? list(row.files) : 'in the entry'} | ${row.modules} | ${row.bytes} | ${row.brotliBytes ?? 'unavailable'} | ${list(row.shared)} |`);
    }
    lines.push('', '</details>', '');
  }
  return lines;
}

/** @param {any} candidate @param {any} baseline @param {{ allRoutes?: boolean }} [options] */
export function compareWebBootWeight(candidate, baseline, { allRoutes = false } = {}) {
  const comparable = baseline?.version === WEB_BOOT_WEIGHT_VERSION;
  const size = assessBundleBudget(comparable ? baseline : undefined, candidate);
  const reason = !baseline ? 'No exact-base measurement is available; showing this commit only.'
    : comparable ? '' : `The base measurement uses definition v${baseline.version}; this commit uses v${WEB_BOOT_WEIGHT_VERSION}, so no deltas are shown.`;
  const changed = size.boot.filter(row => row.delta).map(row => `${row.metric} ${row.delta > 0 ? '+' : ''}${row.delta}`);
  const routeFiles = candidate.boot.files.map(row => `| ${row.kind} | \`${row.file}\` | ${row.modules} | ${row.bytes} | ${row.brotliBytes ?? 'unavailable'} |`);
  const markdown = [
    '## Web boot weight', '',
    changed.length ? `Changed against base: ${changed.join('; ')}.` : comparable ? 'No change against base.' : reason, '',
    renderPerfComparison({ status: size.status, bundleSize: size,
      sources: { baseline: { sha: comparable ? baseline.sha : null, dirty: false }, candidate: { sha: candidate.sha, dirty: false } } })
      .replace('# Performance comparison', '').trim(), '',
    '<details><summary>Files loaded before Home</summary>', '',
    '| Kind | File | Modules | Bytes | Brotli bytes |', '| --- | --- | ---: | ---: | ---: |', ...routeFiles, '', '</details>', '',
    '### Routes', '', ...renderRoutes(candidate, comparable ? baseline : null, allRoutes),
  ].join('\n');
  return { ...size, markdown };
}

/** Marks the one sticky PR comment that the trusted follow-up workflow updates. */
export const WEB_BOOT_WEIGHT_COMMENT_MARKER = '<!-- happier-web-boot-weight -->';

// Measurement artifacts come from runs that executed pull-request code. Only finite numbers,
// booleans, null and plain path-like identifiers are accepted, so a posted comment can carry
// no links, markup, mentions or table breaks.
const PLAIN_TEXT = /^[A-Za-z0-9_./+\-[\]()]{0,300}$/u;
/** @param {unknown} value @returns {any} */
function assertPlainMeasurement(value, depth = 0) {
  const plain = depth < 8 && (value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && PLAIN_TEXT.test(value))
    || (Array.isArray(value) && value.length <= 500 && value.every(item => assertPlainMeasurement(item, depth + 1) !== undefined))
    || (typeof value === 'object' && !Array.isArray(value) && Object.entries(value)
      .every(([key, item]) => PLAIN_TEXT.test(key) && assertPlainMeasurement(item, depth + 1) !== undefined)));
  if (!plain) throw new Error('Web boot weight measurement is not plain measurement data');
  return value ?? true;
}

/** The sticky PR comment: the candidate must be plain data; an unusable base is dropped. @param {unknown} candidate @param {unknown} baseline */
export function renderWebBootWeightComment(candidate, baseline) {
  assertPlainMeasurement(candidate);
  let base = null;
  try { if (baseline) { assertPlainMeasurement(baseline); base = baseline; } } catch { base = null; }
  return `${WEB_BOOT_WEIGHT_COMMENT_MARKER}\n${compareWebBootWeight(candidate, base).markdown}`;
}

/** @param {string} input */
function exportRoot(input) {
  const path = resolve(input);
  if (statSync(path).isDirectory()) return { root: path, cleanup: () => {} };
  const scratch = mkdtempSync(join(tmpdir(), 'happier-web-boot-weight-'));
  execFileSync('tar', ['-xzf', path, '-C', scratch]);
  const [bundle] = readdirSync(scratch);
  return { root: join(scratch, bundle), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

async function main() {
  const { values } = parseArgs({ options: {
    export: { type: 'string' }, candidate: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' }, summary: { type: 'string' }, sha: { type: 'string' },
  }, allowPositionals: false });
  if (values.candidate) {
    // Trusted follow-up workflow: render the sticky comment from downloaded artifacts only.
    const read = (/** @type {string | undefined} */ file) => {
      try { return file ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
    };
    const comment = renderWebBootWeightComment(read(values.candidate), read(values.baseline));
    if (values.summary) writeFileSync(values.summary, comment);
    else console.log(comment);
    return;
  }
  if (!values.export) throw new Error('--export <web export directory or release .tar.gz> is required');
  const { root, cleanup } = exportRoot(values.export);
  try {
    const measurement = await measureWebExport(root, values.sha ?? process.env.GITHUB_SHA ?? null);
    if (values.out) writeFileSync(values.out, `${JSON.stringify(measurement, null, 2)}\n`);
    const baseline = values.baseline ? JSON.parse(readFileSync(values.baseline, 'utf8')) : null;
    const { markdown } = compareWebBootWeight(measurement, baseline, { allRoutes: true });
    if (values.summary) writeFileSync(values.summary, markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
  } finally { cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
