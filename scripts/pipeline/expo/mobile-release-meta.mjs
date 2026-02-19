// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} outPath
 * @param {unknown} value
 */
function writeJson(outPath, value) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'download-ok': { type: 'string', default: 'false' },
      'app-version': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
      'out-json': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (!environment) fail('--environment is required');
  if (environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'preview' or 'production' (got: ${environment})`);
  }

  const downloadOk = parseBool(values['download-ok'], '--download-ok');
  const appVersion = String(values['app-version'] ?? '').trim();
  const githubOutput = String(values['github-output'] ?? '').trim();
  const outJson = String(values['out-json'] ?? '').trim();

  /** @type {{ publish: boolean; tag: string; title: string; prerelease: boolean; rolling_tag: boolean; generate_notes: boolean; notes: string }} */
  let meta;

  if (!downloadOk) {
    meta = {
      publish: false,
      tag: '',
      title: '',
      prerelease: false,
      rolling_tag: false,
      generate_notes: false,
      notes: '',
    };
  } else if (environment === 'production') {
    if (!appVersion) fail('--app-version is required when --download-ok true');
    meta = {
      publish: true,
      tag: `ui-mobile-v${appVersion}`,
      title: `Happier UI Mobile v${appVersion}`,
      prerelease: false,
      rolling_tag: false,
      generate_notes: true,
      notes: '',
    };
  } else {
    meta = {
      publish: true,
      tag: 'ui-mobile-preview',
      title: 'Happier UI Mobile Preview',
      prerelease: true,
      rolling_tag: true,
      generate_notes: false,
      notes: 'Rolling preview build.',
    };
  }

  writeGithubOutput(githubOutput, {
    publish: meta.publish ? 'true' : 'false',
    tag: meta.tag,
    title: meta.title,
    prerelease: meta.prerelease ? 'true' : 'false',
    rolling_tag: meta.rolling_tag ? 'true' : 'false',
    generate_notes: meta.generate_notes ? 'true' : 'false',
    notes: meta.notes,
  });
  writeJson(outJson, meta);

  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

main();

