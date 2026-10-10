// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AscApiError, createAscRequest, resolveAscBuildIdentity, ascListAll, buildAscBaseUrl, loadExpoIosSubmitProfile, resolveBuildIdentityFromEas, resolveBuildIdentityFromLocalArtifact } from './asc-api.mjs';

import {
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  supportsMobileNativeSubmit,
} from './mobile-release-environments.mjs';
import { resolveExternalGroupSelections } from './testflight-group-resolution.mjs';
import { ensureBetaReviewSubmission } from './testflight-beta-review.mjs';
import { readTestflightBuildDetails } from './testflight-build-request.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

function parseChoice(value, name, choices) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (choices.includes(raw)) return raw;
  fail(`${name} must be one of ${choices.join(', ')} (got: ${value})`);
}

function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTransientAscReadError(error) {
  if (error instanceof AscApiError) {
    return [408, 425, 429].includes(error.status) || error.status >= 500;
  }
  const transientCodes = new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  let current = error;
  while (current && typeof current === 'object') {
    if (transientCodes.has(String(current.code ?? '').trim())) return true;
    current = current.cause;
  }
  return false;
}

async function ascRequestWithReadRetry({ request, input }) {
  const method = String(input.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return request(input);

  const maxAttempts = 4;
  const baseDelayMs = readNonNegativeInteger(
    process.env.HAPPIER_TESTFLIGHT_READ_RETRY_DELAY_MS,
    2_000,
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request(input);
    } catch (error) {
      if (!isTransientAscReadError(error) || attempt === maxAttempts) throw error;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      console.log(
        `[pipeline] retrying transient App Store Connect read ` +
        `(attempt=${attempt + 1}/${maxAttempts}, delay_ms=${delayMs})`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error('Unreachable App Store Connect read retry state.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function resolveBuildForDistribution({ request, ascAppId, buildNumber, appVersion, waitProcessing, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const build = await resolveAscBuildIdentity({ request, ascAppId, buildNumber, appVersion });
    const match = build ? {
      build,
      buildId: String(build.id ?? '').trim(),
      processingState: String(build.attributes?.processingState ?? '').trim(),
    } : null;
    if (match && (!waitProcessing || match.processingState === 'VALID')) {
      return match.build;
    }
    if (match && ['FAILED', 'INVALID'].includes(match.processingState)) {
      fail(`App Store Connect build ${match.buildId} is not distributable (processingState=${match.processingState}).`);
    }
    if (!waitProcessing || Date.now() >= deadline) {
      fail(
        match
          ? `Timed out waiting for App Store Connect build ${match.buildId} to finish processing (last state: ${match.processingState || 'unknown'}).`
          : `Unable to find App Store Connect build for build_number=${buildNumber}${appVersion ? ` app_version=${appVersion}` : ''}.`,
      );
    }
    console.log(
      match
        ? `[pipeline] waiting for App Store Connect build ${match.buildId} processingState=${match.processingState || 'unknown'}`
        : `[pipeline] waiting for App Store Connect build build_number=${buildNumber}${appVersion ? ` app_version=${appVersion}` : ''}`,
    );
    await sleep(30_000);
  }
}

async function resolveExternalGroups({ request, ascAppId, externalGroupNames }) {
  const groups = await ascListAll({ request, url: buildAscBaseUrl(`/v1/apps/${ascAppId}/betaGroups?limit=200`) });
  const resolved = resolveExternalGroupSelections({ groups, selections: externalGroupNames });
  const availableExternalGroups = groups
    .filter((group) => group?.attributes?.isInternalGroup !== true)
    .map((group) => {
      const id = String(group?.id ?? '').trim();
      const name = String(group?.attributes?.name ?? '').trim();
      return name && id ? `${name} (${id})` : name || id;
    })
    .filter(Boolean);
  return resolved.map((group, index) => {
    if (!group) {
      fail(
        [
          `Unable to find external TestFlight group '${externalGroupNames[index]}' for app ${ascAppId}.`,
          `Available external groups: ${availableExternalGroups.length > 0 ? availableExternalGroups.join(', ') : '<none>'}.`,
        ].join('\n'),
      );
    }
    return group;
  });
}

async function reconcileGroupAttachment({ request, ascAppId, buildId, groupId }) {
  const currentBuild = await request({
    url: buildAscBaseUrl(`/v1/builds/${buildId}?include=betaGroups`),
  });
  const currentGroupIds = new Set(
    (Array.isArray(currentBuild?.data?.relationships?.betaGroups?.data)
      ? currentBuild.data.relationships.betaGroups.data
      : [])
      .map((entry) => String(entry?.id ?? '').trim())
      .filter(Boolean),
  );
  if (currentGroupIds.has(groupId)) return { attached: true, groupExists: true };

  const currentGroups = await ascListAll({
    request,
    url: buildAscBaseUrl(`/v1/apps/${ascAppId}/betaGroups?limit=200`),
  });
  return {
    attached: false,
    groupExists: currentGroups.some((group) => String(group?.id ?? '').trim() === groupId),
  };
}

async function attachBuildToGroups({ request, ascAppId, build, groups }) {
  const existingGroupIds = new Set(
    (Array.isArray(build?.relationships?.betaGroups?.data) ? build.relationships.betaGroups.data : [])
      .map((entry) => String(entry?.id ?? '').trim())
      .filter(Boolean),
  );
  const buildId = String(build?.id ?? '').trim();
  const maxAttempts = 4;
  const retryDelayMs = readNonNegativeInteger(
    process.env.HAPPIER_TESTFLIGHT_ATTACHMENT_RETRY_DELAY_MS,
    5_000,
  );

  for (const group of groups) {
    const groupId = String(group?.id ?? '').trim();
    if (!groupId || existingGroupIds.has(groupId)) continue;
    const groupLabel = String(group?.attributes?.name ?? '').trim() || groupId;
    try {
      await request({
        method: 'POST',
        url: buildAscBaseUrl(`/v1/betaGroups/${groupId}/relationships/builds`),
        body: {
          data: [{ type: 'builds', id: buildId }],
        },
      });
      console.log(`[pipeline] attached build ${buildId} to TestFlight group ${groupLabel}`);
      continue;
    } catch (error) {
      if (!(error instanceof AscApiError) || error.status !== 404) throw error;
      const state = await reconcileGroupAttachment({ request, ascAppId, buildId, groupId });
      if (state.attached) {
        console.log(`[pipeline] confirmed build ${buildId} is already attached to TestFlight group ${groupLabel}`);
        continue;
      }
      if (!state.groupExists) throw error;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        console.log(
          `[pipeline] retrying TestFlight group attachment through build relationship after state reconciliation ` +
          `(group=${groupLabel}, attempt=${attempt}/${maxAttempts})`,
        );
        await request({
          method: 'POST',
          url: buildAscBaseUrl(`/v1/builds/${buildId}/relationships/betaGroups`),
          body: {
            data: [{ type: 'betaGroups', id: groupId }],
          },
        });
        console.log(`[pipeline] attached build ${buildId} to TestFlight group ${groupLabel}`);
        break;
      } catch (error) {
        const state = await reconcileGroupAttachment({ request, ascAppId, buildId, groupId });
        if (state.attached) {
          console.log(`[pipeline] confirmed build ${buildId} is already attached to TestFlight group ${groupLabel}`);
          break;
        }
        const transient = error instanceof AscApiError && (
          [404, 408, 425, 429].includes(error.status) || error.status >= 500
        );
        if (!state.groupExists || !transient || attempt === maxAttempts) throw error;
        await sleep(retryDelayMs);
      }
    }
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      profile: { type: 'string', default: '' },
      'external-groups': { type: 'string', default: '' },
      'build-json': { type: 'string', default: '' },
      'eas-build-id': { type: 'string', default: '' },
      'build-number': { type: 'string', default: '' },
      'app-version': { type: 'string', default: '' },
      'submit-beta-review': { type: 'string', default: 'auto' },
      'wait-processing': { type: 'string', default: 'true' },
      'processing-timeout-seconds': { type: 'string', default: '3600' },
      'eas-cli-version': { type: 'string', default: '' },
      'validate-groups-only': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = normalizeMobileReleaseEnvironment(values.environment);
  if (!environment || !supportsMobileNativeSubmit(environment)) {
    fail(`--environment must be ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)} (got: ${String(values.environment ?? '').trim() || '<empty>'})`);
  }
  const environmentArg = formatMobileReleaseEnvironment(environment);
  const externalGroups = splitCsv(values['external-groups']);
  if (externalGroups.length === 0) fail('--external-groups is required');

  const requestedProfile = String(values.profile ?? '').trim();
  const submitProfile = normalizeMobileReleaseProfile(requestedProfile) || requestedProfile || environment;
  const dryRun = values['dry-run'] === true;
  const validateGroupsOnly = values['validate-groups-only'] === true;
  const waitProcessing = parseBool(values['wait-processing'], '--wait-processing');
  const submitBetaReview = parseChoice(values['submit-beta-review'], '--submit-beta-review', ['auto', 'true', 'false']);
  const timeoutSeconds = Number.parseInt(String(values['processing-timeout-seconds'] ?? '').trim(), 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    fail(`--processing-timeout-seconds must be a positive integer (got: ${values['processing-timeout-seconds']})`);
  }

  const { ascAppId, ascApiKeyId, ascApiKeyIssuerId } = loadExpoIosSubmitProfile({ repoRoot, submitProfile });
  const privateKeyRaw = String(process.env.APPLE_API_PRIVATE_KEY ?? '').trim();
  if (!privateKeyRaw) {
    fail('APPLE_API_PRIVATE_KEY is required for App Store Connect TestFlight distribution.');
  }

  let buildNumber = String(values['build-number'] ?? '').trim();
  let appVersion = String(values['app-version'] ?? '').trim();
  const buildJsonPath = String(values['build-json'] ?? '').trim();
  // Native-build dry-runs do not guarantee an output file. Ignore any pre-existing file too:
  // it may belong to an earlier build and must not decide whether this dry-run is valid.
  const buildJsonDetails = buildJsonPath && !dryRun ? readTestflightBuildDetails({ buildJsonPath }) : null;
  const easBuildId = String(values['eas-build-id'] ?? '').trim() || String(buildJsonDetails?.easBuildId ?? '').trim();
  const artifactPath = String(buildJsonDetails?.artifactPath ?? '').trim();
  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';
  if (!buildNumber) buildNumber = String(buildJsonDetails?.buildNumber ?? '').trim();
  if (!appVersion) appVersion = String(buildJsonDetails?.appVersion ?? '').trim();
  if ((!buildNumber || !appVersion) && easBuildId && !dryRun) {
    const resolved = resolveBuildIdentityFromEas({ repoRoot, easBuildId, easCliVersion });
    if (!buildNumber) buildNumber = resolved.buildNumber;
    if (!appVersion) appVersion = resolved.appVersion;
  }
  if ((!buildNumber || !appVersion) && artifactPath && !dryRun) {
    const resolved = resolveBuildIdentityFromLocalArtifact({ artifactPath, env: process.env });
    if (!buildNumber) buildNumber = resolved.buildNumber;
    if (!appVersion) appVersion = resolved.appVersion;
  }
  if (!buildNumber && !dryRun && !validateGroupsOnly) {
    fail('A build number is required. Provide --build-number directly, or pass --eas-build-id / --build-json for EAS-backed or local artifact resolution.');
  }

  console.log(
    [
      `[pipeline] testflight distribute: environment=${environmentArg}`,
      `app=${ascAppId}`,
      `external_groups=${externalGroups.join(', ')}`,
      buildNumber ? `build_number=${buildNumber}` : '',
      appVersion ? `app_version=${appVersion}` : '',
      easBuildId ? `eas_build_id=${easBuildId}` : '',
      artifactPath ? `artifact_path=${artifactPath}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (dryRun) return;

  const rawRequest = createAscRequest({
    issuerId: ascApiKeyIssuerId,
    keyId: ascApiKeyId,
    privateKeyPem: privateKeyRaw,
  });
  const request = (input) => ascRequestWithReadRetry({ request: rawRequest, input });
  const groups = await resolveExternalGroups({ request, ascAppId, externalGroupNames: externalGroups });
  for (const group of groups) {
    const groupId = String(group?.id ?? '').trim();
    const groupName = String(group?.attributes?.name ?? '').trim();
    console.log(`[pipeline] validated external TestFlight group ${groupName || groupId}${groupName ? ` (${groupId})` : ''}`);
  }
  if (validateGroupsOnly) return;

  const build = await resolveBuildForDistribution({
    request,
    ascAppId,
    buildNumber,
    appVersion,
    waitProcessing,
    timeoutSeconds,
  });
  await attachBuildToGroups({ request, ascAppId, build, groups });
  await ensureBetaReviewSubmission({
    build,
    submitBetaReview,
    request,
    buildAscBaseUrl,
  });
}

await main();
