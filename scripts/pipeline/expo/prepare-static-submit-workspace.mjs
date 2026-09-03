// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { normalizeMobileReleaseProfile } from './mobile-release-environments.mjs';

const require = createRequire(import.meta.url);
const { EXPO_PROJECT_CONFIG } = require('../../../apps/ui/appProjectConfig.cjs');
const { getAppEnvironmentConfig, normalizeAppEnvironmentId } = require('../../../apps/ui/appVariantConfig.cjs');

function fail(message) {
  throw new Error(message);
}

const repoRoot = path.resolve(process.cwd());
const { values } = parseArgs({
  options: {
    environment: { type: 'string' },
    profile: { type: 'string' },
    'out-dir': { type: 'string' },
  },
  allowPositionals: false,
});

const requestedEnvironment = String(values.environment ?? '').trim();
const environment = normalizeAppEnvironmentId(requestedEnvironment);
if (!environment) fail(`Unknown Expo application environment: ${requestedEnvironment || '<empty>'}`);

const requestedProfile = String(values.profile ?? '').trim();
if (!requestedProfile) fail('--profile is required');
const profile = normalizeMobileReleaseProfile(requestedProfile) || requestedProfile;

const outputDirRaw = String(values['out-dir'] ?? '').trim();
if (!outputDirRaw) fail('--out-dir is required');
const outputDir = path.resolve(repoRoot, outputDirRaw);

const canonicalEasPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
const canonicalEas = JSON.parse(fs.readFileSync(canonicalEasPath, 'utf8'));
const submitProfile = canonicalEas?.submit?.[profile];
if (!submitProfile || typeof submitProfile !== 'object') fail(`apps/ui/eas.json is missing submit.${profile}.`);
if (!submitProfile.android || typeof submitProfile.android !== 'object') {
  fail(`apps/ui/eas.json is missing submit.${profile}.android.`);
}

const appEnvironment = getAppEnvironmentConfig(environment);
const appJson = {
  expo: {
    name: appEnvironment.name,
    slug: EXPO_PROJECT_CONFIG.slug,
    owner: EXPO_PROJECT_CONFIG.owner,
    android: { package: appEnvironment.androidPackage },
    extra: { eas: { projectId: EXPO_PROJECT_CONFIG.easProjectId } },
  },
};
const easJson = { submit: { [profile]: { android: submitProfile.android } } };
const packageJson = { name: 'happier-static-expo-submit', private: true };

fs.mkdirSync(outputDir, { recursive: true });
for (const [filename, value] of [
  ['app.json', appJson],
  ['eas.json', easJson],
  ['package.json', packageJson],
]) {
  fs.writeFileSync(path.join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log(`[pipeline] prepared dependency-free Expo submit workspace: ${outputDir}`);
