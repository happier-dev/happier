// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  MOBILE_RELEASE_ENVIRONMENT_CHOICES,
  normalizeMobileReleaseEnvironment,
  resolveMobileReleaseMetadata,
  supportsMobileApkReleasePublishing,
} from './mobile-release-environments.mjs';

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

  const requestedEnvironment = String(values.environment ?? '').trim();
  const environment = normalizeMobileReleaseEnvironment(requestedEnvironment);
  if (!environment) {
    fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
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
  } else if (!supportsMobileApkReleasePublishing(environment)) {
    meta = {
      publish: false,
      tag: '',
      title: '',
      prerelease: false,
      rolling_tag: false,
      generate_notes: false,
      notes: '',
    };
  } else {
    if (environment === 'production' && !appVersion) fail('--app-version is required when --download-ok true');
    const resolved = resolveMobileReleaseMetadata({ environment, appVersion });
    meta = {
      publish: resolved.publish,
      tag: resolved.tag,
      title: resolved.title,
      prerelease: resolved.prerelease,
      rolling_tag: resolved.rollingTag,
      generate_notes: resolved.generateNotes,
      notes: resolved.notes,
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
