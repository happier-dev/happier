// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { readIosIpaMetadata } from './read-ios-ipa-metadata.mjs';

/** @param {unknown} value */
function normalizePlatform(value) {
  const platform = String(value ?? '').trim();
  if (!platform) return '';
  if (platform.toUpperCase() === 'IOS') return 'ios';
  if (platform.toUpperCase() === 'ANDROID') return 'android';
  return platform.toLowerCase();
}

/** @param {{ buildJsonPath: string }} input */
export function readTestflightBuildDetails(input) {
  const absolutePath = path.resolve(input.buildJsonPath);
  if (!fs.existsSync(absolutePath)) throw new Error(`build JSON path does not exist: ${absolutePath}`);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  if (parsed && !Array.isArray(parsed) && parsed.skipped === true) {
    return { skipped: true, easBuildId: '', artifactPath: '', buildNumber: '', appVersion: '' };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const easBuildId = String(item?.id ?? item?.buildId ?? '').trim();
    const platform = normalizePlatform(item?.platform);
    const mode = String(item?.mode ?? '').trim().toLowerCase();
    const artifactPath = String(item?.artifactPath ?? '').trim();
    const buildNumber = String(item?.buildNumber ?? item?.appBuildVersion ?? item?.metadata?.buildNumber ?? '').trim();
    const appVersion = String(item?.appVersion ?? item?.version ?? item?.metadata?.appVersion ?? '').trim();
    if (easBuildId && (!platform || platform === 'ios')) {
      return { easBuildId, artifactPath: '', buildNumber, appVersion };
    }
    if (mode === 'local' && (!platform || platform === 'ios')) {
      return { easBuildId: '', artifactPath, buildNumber, appVersion };
    }
  }
  throw new Error(`Unable to resolve an iOS EAS build or local artifact from ${absolutePath}`);
}

/**
 * @param {{ buildJsonPath: string; env?: Record<string, string | undefined> }} input
 * @returns {{ skipped?: boolean; easBuildId: string; buildNumber: string; appVersion: string }}
 */
export function readTestflightBuildRequest(input) {
  const details = readTestflightBuildDetails(input);
  if (details.skipped === true) {
    return { skipped: true, easBuildId: '', buildNumber: '', appVersion: '' };
  }
  if (details.easBuildId) {
    return {
      easBuildId: details.easBuildId,
      buildNumber: details.buildNumber,
      appVersion: details.appVersion,
    };
  }
  if (!details.artifactPath) throw new Error('Local TestFlight build output did not include an artifact path.');
  const metadata = readIosIpaMetadata({
    ipaPath: path.resolve(details.artifactPath),
    env: input.env ?? process.env,
  });
  const buildNumber = details.buildNumber || String(metadata?.buildNumber ?? '').trim();
  const appVersion = details.appVersion || String(metadata?.version ?? '').trim();
  if (!buildNumber || !appVersion) {
    throw new Error(`Unable to resolve TestFlight build identity from local artifact ${details.artifactPath}.`);
  }
  return { easBuildId: '', buildNumber, appVersion };
}
