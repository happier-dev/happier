#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readBoundStoreNotes } from '../release/release-notes/project-release-notes.mjs';
import { publishAppStoreVersion } from './app-store-publish.mjs';
import { createAscRequest, loadExpoIosSubmitProfile, resolveBuildIdentityFromEas } from './asc-api.mjs';
import { readTestflightBuildRequest } from './testflight-build-request.mjs';
import { resolveTestflightDistributionConfig } from './testflight-distribution-config.mjs';
import { publishGooglePlayProduction, requireGooglePlayCredential } from './google-play-publish.mjs';
import { resolveMobileAppEnvironmentConfig } from './mobile-release-environments.mjs';

/** Store-only reconciliation: this command never builds or uploads a binary. */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ options: {
    environment: { type: 'string', default: 'production' }, profile: { type: 'string', default: 'production' },
    platform: { type: 'string' }, 'release-notes-json': { type: 'string' }, 'source-sha': { type: 'string' },
    'release-id': { type: 'string' }, 'app-version': { type: 'string' }, 'build-number': { type: 'string', default: '' },
    'build-json': { type: 'string', default: '' }, 'eas-build-id': { type: 'string', default: '' },
    'android-version-code': { type: 'string', default: '' }, 'eas-cli-version': { type: 'string', default: '18.0.1' },
    'wait-processing': { type: 'string', default: 'true' }, 'out-json': { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
  }, allowPositionals: false });
  const repoRoot = process.cwd();
  const binding = { bundlePath: values['release-notes-json'], sourceSha: values['source-sha'],
    releaseId: values['release-id'], appVersion: values['app-version'], platform: values.platform };
  let result;
  try {
    if (values.environment !== 'production' || values.profile !== 'production' || !['ios', 'android'].includes(values.platform)) {
      throw Object.assign(new Error('Store publication requires production environment/profile and one platform.'), { code: 'invalid_store_target' });
    }
    const whatsNew = readBoundStoreNotes(binding);
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/ui/package.json'), 'utf8')).version;
    if (sourceSha !== binding.sourceSha || appVersion !== binding.appVersion) {
      throw Object.assign(new Error('Store publication source/version differs from the bound candidate checkout.'), { code: 'invalid_release_notes_binding' });
    }
    if (values.platform === 'android') requireGooglePlayCredential(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    if (values['dry-run']) {
      result = { status: 'dry_run', platform: values.platform, sourceSha, appVersion, releaseId: binding.releaseId, publicAvailability: 'unverified' };
    } else if (values.platform === 'android') {
      result = await publishGooglePlayProduction({ packageName: resolveMobileAppEnvironmentConfig('production').androidPackage,
        versionCode: values['android-version-code'], whatsNew, credentialJson: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON });
    } else {
      const profile = loadExpoIosSubmitProfile({ repoRoot, submitProfile: 'production' });
      const request = createAscRequest({ issuerId: profile.ascApiKeyIssuerId, keyId: profile.ascApiKeyId,
        privateKeyPem: process.env.APPLE_API_PRIVATE_KEY });
      let identity = { buildNumber: values['build-number'], appVersion: binding.appVersion, easBuildId: values['eas-build-id'] };
      if (values['build-json']) {
        const buildRequest = readTestflightBuildRequest({ buildJsonPath: values['build-json'] });
        if (buildRequest.skipped) throw Object.assign(new Error('No uploaded binary exists for the skipped build.'), { code: 'store_build_skipped' });
        identity = buildRequest;
      }
      if (identity.easBuildId) identity = resolveBuildIdentityFromEas({ repoRoot, easBuildId: identity.easBuildId,
        easCliVersion: values['eas-cli-version'], expectedSourceSha: sourceSha });
      if (identity.appVersion !== binding.appVersion || !identity.buildNumber) {
        throw Object.assign(new Error('The uploaded iOS build does not match the bound UI version.'), { code: 'invalid_store_build_binding' });
      }
      if (!['true', 'false'].includes(values['wait-processing'])) throw new Error('--wait-processing must be true or false');
      // Reuse the existing ASC processing budget; publication adds no competing cutoff.
      const config = resolveTestflightDistributionConfig({ environment: 'production', env: process.env });
      const deadline = Date.now() + config.processingTimeoutSeconds * 1000;
      do {
        result = await publishAppStoreVersion({ request, ascAppId: profile.ascAppId, appVersion: identity.appVersion,
          buildNumber: identity.buildNumber, whatsNew });
        if (!['uploaded', 'processing'].includes(result.status) || values['wait-processing'] === 'false' || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, Math.max(0, deadline - Date.now()))));
      } while (true);
      if (['uploaded', 'processing', 'rejected', 'action_required'].includes(result.status)) process.exitCode = 1;
    }
  } catch (error) {
    result = { status: 'failed', code: error.code ?? 'store_publication_failed', message: error.message,
      platform: values.platform, publicAvailability: 'unverified',
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.apiStatus !== undefined ? { apiStatus: error.apiStatus } : {}),
      ...(error.associatedErrors !== undefined ? { associatedErrors: error.associatedErrors } : {}),
    };
    process.exitCode = 1;
  }
  if (values['out-json']) {
    fs.mkdirSync(path.dirname(path.resolve(values['out-json'])), { recursive: true });
    fs.writeFileSync(values['out-json'], `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
