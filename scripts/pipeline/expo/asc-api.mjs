import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildEasBuildViewArgs } from './testflight-eas-cli-args.mjs';
import { readIosIpaMetadata } from './read-ios-ipa-metadata.mjs';
import { buildAscBuildsListUrl } from './testflight-asc-builds-url.mjs';
import { normalizeAscPrivateKeyPem } from './ensure-asc-api-key-file.mjs';

export function createAscRequest({ issuerId, keyId, privateKeyPem }) {
  const credentials = { issuerId, keyId, privateKeyPem: normalizeAscPrivateKeyPem(privateKeyPem) };
  return (input) => ascRequest({ ...input, token: createJwt(credentials) });
}

// Both production and TestFlight resolve the uploaded artifact through this owner.
export async function resolveAscBuildIdentity({ request, ascAppId, buildNumber, appVersion, platform }) {
  const matches = [];
  const url = new URL(buildAscBuildsListUrl({ ascAppId }));
  if (platform) url.searchParams.set('filter[preReleaseVersion.platform]', platform);
  for await (const body of ascPages({ request, url: url.toString() })) {
    const versions = new Map((Array.isArray(body?.included) ? body.included : [])
      .filter((row) => String(row?.type ?? '').trim() === 'preReleaseVersions' && String(row?.id ?? '').trim())
      .map((row) => [String(row?.id ?? '').trim(), row]));
    for (const build of Array.isArray(body?.data) ? body.data : []) {
      const trainId = String(build?.relationships?.preReleaseVersion?.data?.id ?? '').trim();
      const train = versions.get(trainId)?.attributes;
      if (String(build?.id ?? '').trim() && String(build?.attributes?.version ?? '').trim() === buildNumber
        && (!appVersion || String(train?.version ?? '').trim() === appVersion)
        && (!platform || String(train?.platform ?? '').trim() === platform)) matches.push(build);
    }
  }
  matches.sort((a, b) => Date.parse(String(b.attributes?.uploadedDate ?? '').trim() || '1970-01-01') - Date.parse(String(a.attributes?.uploadedDate ?? '').trim() || '1970-01-01'));
  return matches[0] ?? null;
}
export function createJwt({ issuerId, keyId, privateKeyPem }) {
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

export class AscApiError extends Error {
  /**
   * @param {{ status: number; method: string; url: string; body?: unknown }} input
   */
  constructor(input) {
    const messages = Array.isArray(input.body?.errors)
      ? input.body.errors
          .flatMap((error) => {
            const message = [error?.status, error?.code, error?.title, error?.detail]
              .map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
            // Apple puts review-readiness failures here. Report only their codes
            // and JSON pointers, not arbitrary metadata or associated details.
            const associated = Object.values(error?.meta?.associatedErrors ?? {}).flat()
              .map((row) => [
                /^[A-Z][A-Z0-9_.]*$/u.test(row?.code ?? '') ? row.code : '',
                typeof row?.source?.pointer === 'string' && row.source.pointer.startsWith('/') ? row.source.pointer : '',
              ].filter(Boolean).join(' '));
            return [message, ...associated];
          })
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
export async function ascRequest(input) {
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
 * @param {{ request: (input: { method?: string; url: string; body?: unknown }) => Promise<unknown>; url: string }} input
 * @returns {Promise<unknown[]>}
 */
export async function ascListAll(input) {
  const rows = [];
  for await (const body of ascPages(input)) rows.push(...(Array.isArray(body?.data) ? body.data : []));
  return rows;
}

async function* ascPages(input) {
  const origin = new URL(input.url).origin;
  let nextUrl = input.url;
  while (nextUrl) {
    const body = await input.request({ url: nextUrl });
    yield body;
    const next = String(body?.links?.next ?? '').trim();
    if (!next) return;
    const parsed = new URL(next, nextUrl);
    if (parsed.origin !== origin) throw new Error('App Store Connect pagination changed API origin.');
    nextUrl = parsed.toString();
  }
}

export function buildAscBaseUrl(pathname) {
  return new URL(pathname, 'https://api.appstoreconnect.apple.com').toString();
}

export function loadExpoIosSubmitProfile({ repoRoot, submitProfile }) {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  if (!fs.existsSync(easPath)) throw new Error(`Missing apps/ui/eas.json at ${easPath}`);
  const easJson = JSON.parse(fs.readFileSync(easPath, 'utf8'));
  const ios = easJson?.submit?.[submitProfile]?.ios ?? null;
  const ascAppId = String(ios?.ascAppId ?? '').trim();
  const ascApiKeyId = String(ios?.ascApiKeyId ?? '').trim();
  const ascApiKeyIssuerId = String(ios?.ascApiKeyIssuerId ?? '').trim();
  if (!ascAppId || !ascApiKeyId || !ascApiKeyIssuerId) {
    throw new Error(
      [
        `apps/ui/eas.json is missing submit.${submitProfile}.ios App Store Connect configuration.`,
        'Required: ascAppId, ascApiKeyId, ascApiKeyIssuerId.',
      ].join('\n'),
    );
  }
  return { ascAppId, ascApiKeyId, ascApiKeyIssuerId };
}

export function readEasBuildIdentity(buildPayload, { expectedSourceSha } = {}) {
  if (expectedSourceSha) validateEasBuildSource({ buildPayload, expectedSourceSha });
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

export function resolveBuildIdentityFromEas({ repoRoot, easBuildId, easCliVersion, expectedSourceSha }) {
  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const raw = runCapture('npx', buildEasBuildViewArgs({ easBuildId, easCliVersion }), { cwd: uiDir });
  const parsed = JSON.parse(raw);
  const { buildNumber, appVersion } = readEasBuildIdentity(parsed, { expectedSourceSha });
  if (!buildNumber) {
    throw new Error(`Unable to resolve iOS build number from EAS build ${easBuildId}.`);
  }
  return { buildNumber, appVersion };
}

function validateEasBuildSource({ buildPayload, expectedSourceSha }) {
  if (String(buildPayload?.platform ?? '').toUpperCase() !== 'IOS') {
    throw Object.assign(new Error('EAS store publication requires an iOS build.'), { code: 'EAS_BUILD_PLATFORM_MISMATCH' });
  }
  if (!expectedSourceSha || buildPayload?.gitCommitHash !== expectedSourceSha) {
    throw Object.assign(new Error('EAS build source does not match the bound release source.'), { code: 'EAS_BUILD_SOURCE_MISMATCH' });
  }
}

export function resolveBuildIdentityFromLocalArtifact({ artifactPath, env }) {
  const absolutePath = path.resolve(artifactPath);
  const metadata = readIosIpaMetadata({ ipaPath: absolutePath, env });
  if (!metadata?.buildNumber) {
    throw new Error(`Unable to resolve iOS build number from local artifact ${absolutePath}.`);
  }
  return { buildNumber: metadata.buildNumber, appVersion: metadata.version };
}
