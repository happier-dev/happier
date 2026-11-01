// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePublicReleaseChannel } from '../release/lib/public-release-rings.mjs';

/** @param {string} environment */
export function resolveTauriChannelConfigFile(environment) {
  const channel = normalizePublicReleaseChannel(environment);
  if (!channel) throw new Error(`unsupported Tauri environment: ${environment}`);
  if (channel === 'stable') return 'tauri.conf.json';
  return channel === 'publicdev' ? 'tauri.publicdev.conf.json' : 'tauri.preview.conf.json';
}

/** @param {{ environment: string; tauriDir?: string }} options */
export function readTauriMainBinaryName({ environment, tauriDir = fileURLToPath(new URL('../../../apps/ui/src-tauri', import.meta.url)) }) {
  const configFile = resolveTauriChannelConfigFile(environment);
  const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(path.join(tauriDir, file), 'utf8'));
  const name = read(configFile).mainBinaryName ?? read('tauri.conf.json').mainBinaryName;
  if (typeof name !== 'string' || !name.trim()) throw new Error(`no mainBinaryName configured for ${environment}`);
  return name;
}
