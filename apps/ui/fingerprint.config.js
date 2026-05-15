/**
 * Fingerprint configuration for EAS + runtimeVersion({ policy: 'fingerprint' }).
 *
 * Goal: avoid unnecessary native rebuilds for one lane when unrelated lanes change.
 * Example: updating internaldev bundle IDs should not invalidate the public dev ("publicdev") fingerprint.
 *
 * We do this by canonicalizing certain sources (e.g. eas.json, appVariantConfig.cjs) down to the
 * subset that can affect the current build profile's native output, keyed off APP_ENV.
 *
 * This file is evaluated by @expo/fingerprint (and EAS fingerprint tooling) during builds.
 */

'use strict';

/**
 * @typedef {{
 *   type?: string;
 *   id?: string;
 *   filePath?: string;
 * }} FingerprintSource
 */

const fs = require('node:fs');
const path = require('node:path');

/** @type {Record<string, Buffer>} */
const fileBufferByPath = Object.create(null);

function normalizeRelPath(raw) {
  return String(raw ?? '').replace(/\\/g, '/');
}

function readAppEnv() {
  return String(process.env.APP_ENV ?? '').trim().toLowerCase();
}

/**
 * Deterministic stringify with key sorting (so equivalent objects hash identically).
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function stableNormalize(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (typeof value !== 'object') return value;

  /** @type {Record<string, unknown>} */
  const obj = /** @type {any} */ (value);
  const keys = Object.keys(obj).sort();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of keys) out[k] = stableNormalize(obj[k]);
  return out;
}

/**
 * @param {Buffer} buf
 * @returns {any}
 */
function parseJsonBuffer(buf) {
  const text = buf.toString('utf8');
  return JSON.parse(text);
}

/**
 * Filter eas.json build profiles to those that matter for the active APP_ENV, plus their extends chain.
 * @param {any} eas
 * @param {string} appEnv
 * @returns {any}
 */
function canonicalizeEasJson(eas, appEnv) {
  if (!eas || typeof eas !== 'object') return eas;
  const build = eas.build;
  if (!build || typeof build !== 'object') return eas;

  /** @type {Record<string, any>} */
  const buildProfiles = build;

  /** @type {Set<string>} */
  const keep = new Set();

  /**
   * Resolve the effective APP_ENV for a profile by following `extends`.
   * Many alias profiles (e.g. `development`, `canary`) don't set APP_ENV directly.
   * @param {string} profileName
   * @param {Set<string>} seen
   * @returns {string}
   */
  function resolveEffectiveProfileAppEnv(profileName, seen) {
    if (!profileName || seen.has(profileName)) return '';
    seen.add(profileName);
    const profile = buildProfiles[profileName];
    if (!profile || typeof profile !== 'object') return '';
    const env = profile.env;
    const direct = env && typeof env === 'object' ? String(env.APP_ENV ?? '').trim().toLowerCase() : '';
    if (direct) return direct;
    const parent = String(profile.extends ?? '').trim();
    if (parent && Object.prototype.hasOwnProperty.call(buildProfiles, parent)) {
      return resolveEffectiveProfileAppEnv(parent, seen);
    }
    return '';
  }

  // Always keep base if present (most profiles extend it).
  if (Object.prototype.hasOwnProperty.call(buildProfiles, 'base')) keep.add('base');

  // Keep profiles whose *effective* APP_ENV matches. This naturally includes production-preview variants
  // (APP_ENV=production) and alias profiles like `development`/`canary` that extend a real profile.
  for (const [name, profile] of Object.entries(buildProfiles)) {
    if (!profile || typeof profile !== 'object') continue;
    const effective = resolveEffectiveProfileAppEnv(name, new Set());
    if (effective && effective === appEnv) {
      keep.add(name);
    }
  }

  // Close over `extends` so kept profiles remain meaningful.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Array.from(keep)) {
      const profile = buildProfiles[name];
      if (!profile || typeof profile !== 'object') continue;
      const parent = String(profile.extends ?? '').trim();
      if (parent && Object.prototype.hasOwnProperty.call(buildProfiles, parent) && !keep.has(parent)) {
        keep.add(parent);
        changed = true;
      }
    }
  }

  /** @type {Record<string, any>} */
  const nextBuild = {};
  for (const name of Object.keys(buildProfiles).sort()) {
    if (keep.has(name)) nextBuild[name] = buildProfiles[name];
  }

  return { ...eas, build: nextBuild };
}

/**
 * Canonicalize appVariantConfig.cjs to only the resolved config for APP_ENV.
 *
 * This avoids invalidating publicdev fingerprints when unrelated variants are edited.
 * @param {string} appEnv
 * @returns {any | null}
 */
function resolveCanonicalVariantConfig(appEnv) {
  if (!appEnv) return null;
  // eslint-disable-next-line global-require
  const mod = require('./appVariantConfig.cjs');
  const normalize = typeof mod?.normalizeAppEnvironmentId === 'function' ? mod.normalizeAppEnvironmentId : null;
  const getConfig = typeof mod?.getAppEnvironmentConfig === 'function' ? mod.getAppEnvironmentConfig : null;
  if (!normalize || !getConfig) return null;

  const normalized = String(normalize(appEnv) ?? '').trim();
  if (!normalized) return null;
  const cfg = getConfig(normalized);
  return cfg && typeof cfg === 'object' ? cfg : null;
}

/**
 * @type {import('expo/fingerprint').Config}
 */
const config = {
  // EAS managed builds run `expo prebuild` during the build, which generates `android/` and `ios/`
  // directories on the worker. When using runtimeVersion({ policy: 'fingerprint' }), the runtime
  // version is validated both on the machine that schedules the build and again on the EAS worker.
  // If these paths are not ignored, the generated native dirs can cause a runtimeVersion mismatch.
  //
  // Note: this is intentionally scoped to the UI project root. If we ever commit bare native dirs
  // for the UI (e.g. switching to bare workflow), we should revisit this.
  ignorePaths: [
    // Ignore the generated native directories. When `expo prebuild` generates a real native project
    // structure under these paths, @expo/fingerprint will otherwise treat them as `bareNativeDir`
    // sources and include them in the fingerprint (causing EAS/runtimeVersion mismatches).
    //
    // Keep these globs aligned with Expo's own guidance (expo-updates uses `android/**/*` / `ios/**/*`).
    'android',
    'android/**/*',
    'ios',
    'ios/**/*',

    // Ignore libsodium build outputs which can vary by environment and should not affect the
    // native compatibility signal (the underlying package sources are still hashed).
    'node_modules/@more-tech/react-native-libsodium/libsodium/build',
    'node_modules/@more-tech/react-native-libsodium/libsodium/build/**/*',
    '**/node_modules/@more-tech/react-native-libsodium/libsodium/build',
    '**/node_modules/@more-tech/react-native-libsodium/libsodium/build/**/*',

    // Ignore generated codegen/Nitro output. The package versions and native source files remain
    // fingerprinted, while local postinstall/build artifacts stop invalidating OTA compatibility.
    'node_modules/react-native-enriched-markdown/android/generated',
    'node_modules/react-native-enriched-markdown/android/generated/**/*',
    'node_modules/react-native-enriched-markdown/ios/generated',
    'node_modules/react-native-enriched-markdown/ios/generated/**/*',
    '**/node_modules/react-native-enriched-markdown/android/generated',
    '**/node_modules/react-native-enriched-markdown/android/generated/**/*',
    '**/node_modules/react-native-enriched-markdown/ios/generated',
    '**/node_modules/react-native-enriched-markdown/ios/generated/**/*',
    'node_modules/react-native-unistyles/nitrogen/generated',
    'node_modules/react-native-unistyles/nitrogen/generated/**/*',
    '**/node_modules/react-native-unistyles/nitrogen/generated',
    '**/node_modules/react-native-unistyles/nitrogen/generated/**/*',
  ],
  fileHookTransform: (source, chunk, isEndOfFile) => {
    const src = /** @type {FingerprintSource} */ (source ?? {});
    const filePath = normalizeRelPath(src.filePath);
    const contentsId = String(src.id ?? '').trim();
    const appEnv = readAppEnv();

    // Avoid surprising local tooling: if APP_ENV is not set, do not canonicalize.
    if (!appEnv) return chunk;

    if (src.type === 'contents' && contentsId === 'expoConfig') {
      const key = `contents:${contentsId}`;
      if (chunk != null) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        fileBufferByPath[key] = fileBufferByPath[key] ? Buffer.concat([fileBufferByPath[key], buf]) : buf;
      }
      if (!isEndOfFile) return null;

      const full = fileBufferByPath[key] ?? Buffer.alloc(0);
      delete fileBufferByPath[key];

      try {
        const parsed = parseJsonBuffer(full);
        const extra = parsed?.extra;
        const app = extra?.app;
        if (app && typeof app === 'object') {
          // These keys are secrets/third-party identifiers and can change without affecting native output.
          // Removing them stabilizes the runtimeVersion({ policy: 'fingerprint' }) signal.
          /** @type {Record<string, unknown>} */
          const nextApp = { ...app };
          delete nextApp.postHogKey;
          delete nextApp.revenueCatAppleKey;
          delete nextApp.revenueCatGoogleKey;
          delete nextApp.revenueCatStripeKey;
          const next = {
            ...parsed,
            extra: { ...extra, app: nextApp },
          };
          return stableStringify(next);
        }

        return stableStringify(parsed);
      } catch {
        // Fail open: fingerprinting should still work even if canonicalization fails.
        return full.toString('utf8');
      }
    }

    if (src.type === 'file' && (filePath === 'eas.json' || filePath === 'appVariantConfig.cjs')) {
      const key = filePath;
      if (chunk != null) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        fileBufferByPath[key] = fileBufferByPath[key] ? Buffer.concat([fileBufferByPath[key], buf]) : buf;
      }
      if (!isEndOfFile) return null;

      const full = fileBufferByPath[key] ?? Buffer.alloc(0);
      delete fileBufferByPath[key];

      try {
        if (filePath === 'eas.json') {
          const parsed = parseJsonBuffer(full);
          const canon = canonicalizeEasJson(parsed, appEnv);
          return stableStringify(canon);
        }

        if (filePath === 'appVariantConfig.cjs') {
          // Use the resolved variant config rather than raw file bytes.
          const canon = resolveCanonicalVariantConfig(appEnv);
          if (!canon) return full.toString('utf8');
          return stableStringify(canon);
        }
      } catch {
        // Fail open: fingerprinting should still work even if canonicalization fails.
        return full.toString('utf8');
      }
    }

    return chunk;
  },
};

module.exports = config;
