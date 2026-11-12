// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readPublishablePlugins } from '../../plugins/publishable.mjs';

/** @param {readonly {id: string}[]} plugins @param {string[]} targets */
export function selectPluginPublications(plugins, targets) {
  const known = new Set(plugins.map(({ id }) => `plugin:${id}`));
  for (const target of targets) {
    if (target.startsWith('plugin:') && !known.has(target)) throw new Error(`Unknown publishable plugin target: ${target}`);
  }
  return plugins.filter(({ id }) => targets.includes(`plugin:${id}`)).map(({ id }) => id);
}

/** @param {unknown} input @returns {string[]} */
export function parsePluginSelection(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) throw new Error('publish_plugins must be a JSON array of plugin ids');
  return parsed;
}

/** @param {unknown} input @returns {Record<string, string>} */
export function parsePluginVersions(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((version) => typeof version !== 'string')) {
    throw new Error('plugin_versions must be a JSON object mapping plugin ids to exact version strings');
  }
  return parsed;
}

/** @param {unknown} input @param {string[]} selected */
export function selectPluginVersions(input, selected) {
  const versions = parsePluginVersions(input);
  return Object.fromEntries(selected.filter((id) => versions[id] !== undefined).map((id) => [id, versions[id]]));
}

/** @param {readonly {id: string; packageName: string}[]} plugins @param {string[]} selected @param {{id: string; packageName: string; result: string; version: string; integrity: string}[]} records */
export function aggregatePluginPublications(plugins, selected, records) {
  return selected.map((id) => {
    const record = records.find((entry) => entry.id === id);
    return recordPluginPublication(plugins, id, record?.result ?? 'failed', record?.version ?? '', record?.integrity ?? '');
  });
}

/** @param {readonly {id: string; packageName: string}[]} plugins @param {string} id @param {string} result @param {string} version @param {string} integrity */
export function recordPluginPublication(plugins, id, result, version, integrity) {
  const plugin = plugins.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`Unknown publishable plugin: ${id}`);
  return { id, packageName: plugin.packageName, result: result === 'success' && version !== '' && integrity !== '' ? 'success' : 'failed', version, integrity };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: {
    'select-input': { type: 'string' }, 'select-targets': { type: 'string' }, aggregate: { type: 'string' }, plugins: { type: 'string', default: '[]' },
    'record-status': { type: 'string' }, plugin: { type: 'string' }, result: { type: 'string', default: 'failed' }, version: { type: 'string', default: '' }, integrity: { type: 'string', default: '' },
    'repo-root': { type: 'string', default: process.cwd() },
    'github-output': { type: 'string', default: process.env.GITHUB_OUTPUT ?? '' },
    versions: { type: 'string', default: '{}' },
  } });
  const publishablePlugins = readPublishablePlugins(values['repo-root']);
  let output;
  if (values['record-status'] !== undefined) {
    const record = recordPluginPublication(publishablePlugins, values.plugin ?? '', values.result, values.version, values.integrity);
    mkdirSync(dirname(resolve(values['record-status'])), { recursive: true });
    writeFileSync(values['record-status'], `${JSON.stringify(record)}\n`);
    output = {};
  } else if (values.aggregate !== undefined) {
    const dir = resolve(values.aggregate);
    const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'))) : [];
    output = { plugins_json: JSON.stringify(aggregatePluginPublications(publishablePlugins, parsePluginSelection(values.plugins), records)) };
  } else {
    const targets = values['select-input'] !== undefined
      ? parsePluginSelection(values['select-input']).map((id) => `plugin:${id}`)
      : String(values['select-targets'] ?? '').split(',').map((target) => target.trim());
    const selected = selectPluginPublications(publishablePlugins, targets);
    output = {
      publish_plugins: JSON.stringify(selected),
      plugin_versions: JSON.stringify(selectPluginVersions(values.versions, selected)),
    };
  }
  if (values['github-output']) appendFileSync(values['github-output'], `${Object.entries(output).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  else process.stdout.write(`${JSON.stringify(output)}\n`);
}
