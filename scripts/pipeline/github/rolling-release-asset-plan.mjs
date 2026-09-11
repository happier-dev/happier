// @ts-check

import { basename } from 'node:path';

function fail(message) {
  throw new Error(message);
}

function isInstallablePayload(name) {
  return !name.endsWith('.sig')
    && !name.endsWith('.minisig')
    && !name.endsWith('.sha256')
    && !name.endsWith('.json')
    && !name.endsWith('.txt');
}

/**
 * Rolling stable and preview releases retain every immutable, signed asset and add
 * predictable aliases for installable payloads whose filename embeds the exact release version.
 * Signed manifests, signatures, checksum sidecars, and updater metadata remain canonical
 * under their immutable names because renaming them would make their contents misleading.
 * The caller must upload each alias from sourceName and audit the two byte-for-byte.
 *
 * @param {{
 *   immutableNames: readonly string[];
 *   payloadNames: readonly string[];
 *   version: string;
 *   rollingTag: string;
 * }} params
 */
export function buildRollingAssetPlan({ immutableNames, payloadNames, version, rollingTag }) {
  const plan = immutableNames.map((name) => ({ name, sourceName: name }));
  if (!rollingTag.endsWith('-stable') && !rollingTag.endsWith('-preview')) return plan;

  const versionToken = `-v${version}`;
  const occupied = new Set(immutableNames);
  for (const sourceName of payloadNames) {
    if (!isInstallablePayload(sourceName)) continue;
    if (rollingTag === 'ui-mobile-stable' && sourceName === `happier-production-android-v${version}.apk`) {
      const name = 'happier-android.apk';
      if (occupied.has(name)) {
        fail(`Stable asset name collides with another release asset: ${name}`);
      }
      occupied.add(name);
      plan.push({ name, sourceName });
    }
    if (rollingTag === 'ui-mobile-preview' && sourceName === 'happier-preview-android.apk') {
      const name = 'happier-preview.apk';
      if (occupied.has(name)) {
        fail(`Stable asset name collides with another release asset: ${name}`);
      }
      occupied.add(name);
      plan.push({ name, sourceName });
    }
    const first = sourceName.indexOf(versionToken);
    if (first < 0) continue;
    if (sourceName.indexOf(versionToken, first + versionToken.length) >= 0) {
      fail(`Immutable asset contains the version token more than once: ${sourceName}`);
    }
    const name = `${sourceName.slice(0, first)}${sourceName.slice(first + versionToken.length)}`;
    if (!name || basename(name) !== name || name === '.' || name === '..') {
      fail(`Unable to derive a safe stable asset name from ${sourceName}.`);
    }
    if (occupied.has(name)) {
      fail(`Stable asset name collides with another release asset: ${name}`);
    }
    occupied.add(name);
    plan.push({ name, sourceName });
  }
  return plan.sort((left, right) => left.name.localeCompare(right.name));
}
