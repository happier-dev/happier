// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { normalizeAscPrivateKeyPem } from './ensure-asc-api-key-file.mjs';
import {
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  supportsMobileNativeSubmit,
} from './mobile-release-environments.mjs';
import { buildAscBuildsListUrl } from './testflight-asc-builds-url.mjs';
import { buildEasBuildViewArgs } from './testflight-eas-cli-args.mjs';
import { resolveExternalGroupSelections } from './testflight-group-resolution.mjs';
import { readIosIpaMetadata } from './read-ios-ipa-metadata.mjs';

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

function createJwt({ issuerId, keyId, privateKeyPem }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    aud: 'appstoreconnect-v1',
    exp: nowSeconds + 19 * 60,
  };
  const encode = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${signingInput}.${signature}`;
}

class AscApiError extends Error {
  /**
   * @param {{ status: number; method: string; url: string; body?: any }} input
   */
  constructor(input) {
    const messages = Array.isArray(input.body?.errors)
      ? input.body.errors
          .map((error) =>
            [error?.status, error?.code, error?.title, error?.detail].map((part) => String(part ?? '').trim()).filter(Boolean).join(' '),
          )
          .filter(Boolean)
      : [];
    super(
      [`App Store Connect API ${input.method} ${input.url} failed (${input.status}).`, ...messages]
        .filter(Boolean)
        .join('\n'),
    );
    this.name = 'AscApiError';
    this.status = input.status;
    this.body = input.body;
  }
}

/**
 * @param {{ token: string; method?: string; url: string; body?: unknown }} input
 */
async function ascRequest(input) {
  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.token}`,
      ...(input.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new AscApiError({
      status: response.status,
      method: input.method ?? 'GET',
      url: input.url,
      body,
    });
  }
  return body;
}

/**
 * @param {{ token: string; url: string }} input
 * @returns {Promise<any[]>}
 */
async function ascListAll(input) {
  const rows = [];
  let nextUrl = input.url;
  while (nextUrl) {
    const body = await ascRequest({ token: input.token, url: nextUrl });
    rows.push(...(Array.isArray(body?.data) ? body.data : []));
    nextUrl = String(body?.links?.next ?? '').trim();
  }
  return rows;
}

function buildAscBaseUrl(pathname) {
  return new URL(pathname, 'https://api.appstoreconnect.apple.com').toString();
}

function loadExpoIosSubmitProfile({ repoRoot, submitProfile }) {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  if (!fs.existsSync(easPath)) fail(`Missing apps/ui/eas.json at ${easPath}`);
  const easJson = JSON.parse(fs.readFileSync(easPath, 'utf8'));
  const ios = easJson?.submit?.[submitProfile]?.ios ?? null;
  const ascAppId = String(ios?.ascAppId ?? '').trim();
  const ascApiKeyId = String(ios?.ascApiKeyId ?? '').trim();
  const ascApiKeyIssuerId = String(ios?.ascApiKeyIssuerId ?? '').trim();
  if (!ascAppId || !ascApiKeyId || !ascApiKeyIssuerId) {
    fail(
      [
        `apps/ui/eas.json is missing submit.${submitProfile}.ios App Store Connect configuration.`,
        'Required: ascAppId, ascApiKeyId, ascApiKeyIssuerId.',
      ].join('\n'),
    );
  }
  return { ascAppId, ascApiKeyId, ascApiKeyIssuerId };
}

function normalizeBuildJsonPlatform(value) {
  const platform = String(value ?? '').trim();
  if (!platform) return '';
  if (platform.toUpperCase() === 'IOS') return 'ios';
  if (platform.toUpperCase() === 'ANDROID') return 'android';
  return platform.toLowerCase();
}

function readBuildJsonDetails(buildJsonPath) {
  const absolutePath = path.resolve(buildJsonPath);
  if (!fs.existsSync(absolutePath)) fail(`--build-json path does not exist: ${absolutePath}`);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const id = String(item?.id ?? item?.buildId ?? '').trim();
    const platform = normalizeBuildJsonPlatform(item?.platform);
    const mode = String(item?.mode ?? '').trim().toLowerCase();
    const artifactPath = String(item?.artifactPath ?? '').trim();
    const buildNumber = String(item?.buildNumber ?? item?.appBuildVersion ?? item?.metadata?.buildNumber ?? '').trim();
    const appVersion = String(item?.appVersion ?? item?.version ?? item?.metadata?.appVersion ?? '').trim();
    if (id && (!platform || platform === 'ios')) {
      return { easBuildId: id, artifactPath: '', buildNumber, appVersion };
    }
    if (mode === 'local' && (!platform || platform === 'ios')) {
      return { easBuildId: '', artifactPath, buildNumber, appVersion };
    }
  }
  fail(`Unable to resolve an iOS EAS build or local artifact from ${absolutePath}`);
}

function readEasBuildIdentity(buildPayload) {
  const buildNumberCandidates = [
    buildPayload?.appBuildVersion,
    buildPayload?.buildVersion,
    buildPayload?.buildNumber,
    buildPayload?.version,
    buildPayload?.metadata?.buildNumber,
    buildPayload?.metadata?.appBuildVersion,
    buildPayload?.artifacts?.buildNumber,
  ];
  const appVersionCandidates = [
    buildPayload?.appVersion,
    buildPayload?.applicationVersion,
    buildPayload?.metadata?.appVersion,
    buildPayload?.metadata?.applicationVersion,
    buildPayload?.artifacts?.appVersion,
  ];
  const buildNumber = buildNumberCandidates.map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
  const appVersion = appVersionCandidates.map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
  return { buildNumber, appVersion };
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 5 * 60_000,
  }).trim();
}

function resolveBuildIdentityFromEas({ repoRoot, easBuildId, easCliVersion }) {
  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const raw = runCapture('npx', buildEasBuildViewArgs({ easBuildId, easCliVersion }), { cwd: uiDir });
  const parsed = JSON.parse(raw);
  const { buildNumber, appVersion } = readEasBuildIdentity(parsed);
  if (!buildNumber) {
    fail(`Unable to resolve iOS build number from EAS build ${easBuildId}.`);
  }
  return { buildNumber, appVersion };
}

function resolveBuildIdentityFromLocalArtifact({ artifactPath, env }) {
  const absolutePath = path.resolve(artifactPath);
  const metadata = readIosIpaMetadata({ ipaPath: absolutePath, env });
  if (!metadata?.buildNumber) {
    fail(`Unable to resolve iOS build number from local artifact ${absolutePath}.`);
  }
  return { buildNumber: metadata.buildNumber, appVersion: metadata.version };
}

function getIncludedMap(collection, type) {
  const map = new Map();
  for (const item of Array.isArray(collection) ? collection : []) {
    if (String(item?.type ?? '').trim() !== type) continue;
    const id = String(item?.id ?? '').trim();
    if (id) map.set(id, item);
  }
  return map;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveBuildForDistribution({ token, ascAppId, buildNumber, appVersion, waitProcessing, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const url = buildAscBuildsListUrl({ ascAppId, limit: 200 });
    const body = await ascRequest({ token, url });
    const builds = Array.isArray(body?.data) ? body.data : [];
    const included = Array.isArray(body?.included) ? body.included : [];
    const preReleaseVersions = getIncludedMap(included, 'preReleaseVersions');

    const matches = builds
      .map((build) => {
        const buildId = String(build?.id ?? '').trim();
        const candidateBuildNumber = String(build?.attributes?.version ?? '').trim();
        const uploadedDate = String(build?.attributes?.uploadedDate ?? '').trim();
        const processingState = String(build?.attributes?.processingState ?? '').trim();
        const preReleaseVersionId = String(build?.relationships?.preReleaseVersion?.data?.id ?? '').trim();
        const candidateAppVersion = String(preReleaseVersions.get(preReleaseVersionId)?.attributes?.version ?? '').trim();
        return {
          build,
          buildId,
          buildNumber: candidateBuildNumber,
          appVersion: candidateAppVersion,
          uploadedDate,
          processingState,
        };
      })
      .filter((candidate) => candidate.buildId && candidate.buildNumber === buildNumber)
      .filter((candidate) => !appVersion || candidate.appVersion === appVersion)
      .sort((left, right) => Date.parse(right.uploadedDate || '1970-01-01T00:00:00Z') - Date.parse(left.uploadedDate || '1970-01-01T00:00:00Z'));

    const match = matches[0] ?? null;
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

async function resolveExternalGroups({ token, ascAppId, externalGroupNames }) {
  const groups = await ascListAll({ token, url: buildAscBaseUrl(`/v1/apps/${ascAppId}/betaGroups?limit=200`) });
  const resolved = resolveExternalGroupSelections({ groups, selections: externalGroupNames });
  return resolved.map((group, index) => {
    if (!group) fail(`Unable to find external TestFlight group '${externalGroupNames[index]}' for app ${ascAppId}.`);
    return group;
  });
}

async function attachBuildToGroups({ token, build, groups }) {
  const existingGroupIds = new Set(
    (Array.isArray(build?.relationships?.betaGroups?.data) ? build.relationships.betaGroups.data : [])
      .map((entry) => String(entry?.id ?? '').trim())
      .filter(Boolean),
  );

  for (const group of groups) {
    const groupId = String(group?.id ?? '').trim();
    if (!groupId || existingGroupIds.has(groupId)) continue;
    await ascRequest({
      token,
      method: 'POST',
      url: buildAscBaseUrl(`/v1/betaGroups/${groupId}/relationships/builds`),
      body: {
        data: [{ type: 'builds', id: String(build?.id ?? '').trim() }],
      },
    });
    console.log(`[pipeline] attached build ${String(build?.id ?? '').trim()} to TestFlight group ${String(group?.attributes?.name ?? '').trim()}`);
  }
}

async function ensureBetaReviewSubmission({ token, build, submitBetaReview }) {
  if (submitBetaReview === 'false') return;
  const existingSubmissionId = String(build?.relationships?.betaAppReviewSubmission?.data?.id ?? '').trim();
  if (existingSubmissionId) {
    console.log(`[pipeline] beta review submission already exists for build ${String(build?.id ?? '').trim()}: ${existingSubmissionId}`);
    return;
  }
  await ascRequest({
    token,
    method: 'POST',
    url: buildAscBaseUrl('/v1/betaAppReviewSubmissions'),
    body: {
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: {
          build: {
            data: {
              type: 'builds',
              id: String(build?.id ?? '').trim(),
            },
          },
        },
      },
    },
  });
  console.log(`[pipeline] submitted build ${String(build?.id ?? '').trim()} for TestFlight Beta App Review`);
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
  const buildJsonDetails = values['build-json'] ? readBuildJsonDetails(String(values['build-json'])) : null;
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
  if (!buildNumber && !dryRun) {
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

  const token = createJwt({
    issuerId: ascApiKeyIssuerId,
    keyId: ascApiKeyId,
    privateKeyPem: normalizeAscPrivateKeyPem(privateKeyRaw),
  });
  const build = await resolveBuildForDistribution({
    token,
    ascAppId,
    buildNumber,
    appVersion,
    waitProcessing,
    timeoutSeconds,
  });
  const groups = await resolveExternalGroups({ token, ascAppId, externalGroupNames: externalGroups });
  await attachBuildToGroups({ token, build, groups });
  await ensureBetaReviewSubmission({
    token,
    build,
    submitBetaReview: submitBetaReview === 'auto' ? 'true' : submitBetaReview,
  });
}

await main();
