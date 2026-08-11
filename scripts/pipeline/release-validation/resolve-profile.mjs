#!/usr/bin/env node
// @ts-check

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { resolveReleaseValidationProfile } from './registry.mjs';

/** @param {string} profileId */
export function resolveNormalReleaseProfile(profileId) {
  const profile = resolveReleaseValidationProfile(profileId);
  if (!profile?.normalRelease || (profile.checksProfile !== 'fast' && profile.checksProfile !== 'full')) {
    throw new Error(`Unsupported normal release validation profile: ${profileId}`);
  }
  return { profile: profile.id, checksProfile: profile.checksProfile };
}

export async function main(argv = process.argv.slice(2)) {
  const profileId = argv[0] ?? '';
  const output = resolveNormalReleaseProfile(profileId);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `profile=${output.profile}\nchecks_profile=${output.checksProfile}\n`, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
