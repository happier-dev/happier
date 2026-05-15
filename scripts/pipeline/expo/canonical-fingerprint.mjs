// @ts-check

import { createHash } from 'node:crypto';

const GENERATED_NATIVE_ARTIFACT_PATH_MARKERS = Object.freeze([
  'node_modules/@more-tech/react-native-libsodium/libsodium/build',
  'node_modules/react-native-enriched-markdown/android/generated',
  'node_modules/react-native-enriched-markdown/ios/generated',
  'node_modules/react-native-unistyles/nitrogen/generated',
]);

/**
 * @typedef {{
 *   type?: string;
 *   filePath?: string;
 *   id?: string;
 *   reasons?: string[];
 *   hash?: string | null;
 *   overrideHashKey?: string;
 * }} ExpoFingerprintSource
 */

/**
 * @param {string} value
 * @returns {string}
 */
function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * @param {ExpoFingerprintSource} source
 * @returns {string}
 */
function sourceId(source) {
  if (source.type === 'contents') return String(source.id ?? '');
  return String(source.overrideHashKey ?? source.filePath ?? '');
}

/**
 * @param {ExpoFingerprintSource} a
 * @param {ExpoFingerprintSource} b
 * @returns {number}
 */
function compareSource(a, b) {
  const order = { file: 0, dir: 1, contents: 2 };
  const aOrder = order[/** @type {'file' | 'dir' | 'contents'} */ (a.type)] ?? 99;
  const bOrder = order[/** @type {'file' | 'dir' | 'contents'} */ (b.type)] ?? 99;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return sourceId(a).localeCompare(sourceId(b));
}

/**
 * Expo's default fingerprint is intentionally broad. For Happier release runtime decisions, we
 * keep native source/config/package inputs but remove generated build/codegen output that can
 * appear or differ only because a local build/postinstall has already run.
 *
 * @param {ExpoFingerprintSource} source
 * @returns {boolean}
 */
export function shouldExcludeCanonicalFingerprintSource(source) {
  const filePath = normalizePath(source.filePath ?? '');
  if (!filePath) return false;

  const reasons = Array.isArray(source.reasons) ? source.reasons.map((reason) => String(reason)) : [];
  if (source.type === 'dir' && reasons.includes('bareNativeDir') && (filePath === 'ios' || filePath === 'android')) {
    return true;
  }

  return GENERATED_NATIVE_ARTIFACT_PATH_MARKERS.some(
    (marker) => filePath === marker || filePath.startsWith(`${marker}/`),
  );
}

/**
 * @param {{ hash?: string; sources?: ExpoFingerprintSource[] }} fingerprint
 * @param {{ hashAlgorithm?: string }} [opts]
 * @returns {{ hash: string; sources: ExpoFingerprintSource[]; rawHash: string }}
 */
export function createCanonicalFingerprintFromExpoFingerprint(fingerprint, opts = {}) {
  const hashAlgorithm = String(opts.hashAlgorithm ?? 'sha1').trim() || 'sha1';
  const sources = (Array.isArray(fingerprint?.sources) ? fingerprint.sources : [])
    .filter((source) => !shouldExcludeCanonicalFingerprintSource(source))
    .sort(compareSource);

  const hasher = createHash(hashAlgorithm);
  for (const source of sources) {
    if (source.hash == null) continue;
    hasher.update(sourceId(source));
    hasher.update(String(source.hash));
  }

  return {
    hash: hasher.digest('hex'),
    rawHash: String(fingerprint?.hash ?? '').trim(),
    sources,
  };
}
