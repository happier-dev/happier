// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function commandExists(cmd, env) {
  try {
    execFileSync('bash', ['-lc', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], {
      env,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @param {string} xml
 * @returns {string}
 */
function readPlistXmlStringValue(key, xml) {
  const re = new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]*)<\\/string>`, 'm');
  const m = xml.match(re);
  return m ? String(m[1] ?? '').trim() : '';
}

/**
 * @param {string} zipPath
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function listZipEntries(zipPath, env) {
  const out = execFileSync('unzip', ['-Z1', zipPath], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return String(out ?? '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * @param {string} zipPath
 * @param {string} entry
 * @param {Record<string, string>} env
 * @returns {Buffer}
 */
function extractZipEntry(zipPath, entry, env) {
  const out = execFileSync('unzip', ['-p', zipPath, entry], {
    env,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return Buffer.isBuffer(out) ? out : Buffer.from(out ?? '');
}

/**
 * @param {{ ipaPath: string; env: Record<string, string> }} opts
 * @returns {{ bundleIdentifier: string; displayName: string; buildNumber: string; version: string } | null}
 */
export function readIosIpaMetadata(opts) {
  if (!opts.ipaPath.endsWith('.ipa')) return null;
  if (!fs.existsSync(opts.ipaPath)) return null;
  if (!commandExists('unzip', opts.env)) return null;

  const entries = listZipEntries(opts.ipaPath, opts.env);
  const infoEntry = entries.find((entry) => /^Payload\/.+\.app\/Info\.plist$/.test(entry));
  if (!infoEntry) return null;

  const plistBuf = extractZipEntry(opts.ipaPath, infoEntry, opts.env);
  if (!plistBuf || plistBuf.length === 0) return null;

  if (commandExists('plutil', opts.env)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ipa-info-'));
    const plistPath = path.join(dir, 'Info.plist');
    try {
      fs.writeFileSync(plistPath, plistBuf);

      const readKey = (key) => {
        try {
          return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
            env: opts.env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
          }).trim();
        } catch {
          return '';
        }
      };

      return {
        bundleIdentifier: readKey('CFBundleIdentifier'),
        displayName: readKey('CFBundleDisplayName') || readKey('CFBundleName'),
        version: readKey('CFBundleShortVersionString'),
        buildNumber: readKey('CFBundleVersion'),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const asText = plistBuf.toString('utf8');
  if (!asText.includes('<plist') || !asText.includes('CFBundleIdentifier')) return null;
  return {
    bundleIdentifier: readPlistXmlStringValue('CFBundleIdentifier', asText),
    displayName:
      readPlistXmlStringValue('CFBundleDisplayName', asText) || readPlistXmlStringValue('CFBundleName', asText),
    version: readPlistXmlStringValue('CFBundleShortVersionString', asText),
    buildNumber: readPlistXmlStringValue('CFBundleVersion', asText),
  };
}
