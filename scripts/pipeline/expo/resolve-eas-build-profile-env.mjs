// @ts-check

import fs from 'node:fs';

/**
 * Resolve the env var map for an EAS build profile, following `extends`.
 * This is used to make OTA updates compute the same fingerprint-based runtimeVersion as native builds.
 *
 * Keep this module dependency-free (Node built-ins only) so it can run in CI before `yarn install`.
 */

/**
 * @typedef {{ extends?: string; env?: Record<string, string> }} EasBuildProfile
 * @typedef {{ build?: Record<string, EasBuildProfile> }} EasJson
 */

/**
 * @param {{ easJsonPath: string; profileId: string }} input
 * @returns {Record<string, string>}
 */
export function resolveEasBuildProfileEnv({ easJsonPath, profileId }) {
  /** @type {EasJson} */
  const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
  const buildProfiles = easJson?.build ?? {};

  /** @type {Record<string, string>} */
  const resolved = {};
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {string} id
   */
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);

    const profile = buildProfiles[id];
    if (!profile) {
      throw new Error(`Unknown EAS build profile: ${id}`);
    }

    const parent = String(profile.extends ?? '').trim();
    if (parent) visit(parent);

    const env = profile.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (value == null) continue;
      resolved[String(key)] = String(value);
    }
  };

  visit(profileId);

  return resolved;
}

