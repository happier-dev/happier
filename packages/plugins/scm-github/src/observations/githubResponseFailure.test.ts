import { describe, expect, it } from 'vitest';
import { MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1, TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';

import {
  readGithubApiResponseFacts,
  readGithubDecodedResponseFacts,
} from './githubApiClient.js';
import {
  GITHUB_RESPONSE_FAILURE_CODE,
  classifyGithubResponseFacts,
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubInaccessibleResourceFailure,
} from './githubResponseFailure.js';

function response(input: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>) {
  return {
    status: input.status,
    headers: input.headers ?? {},
    body: new TextEncoder().encode(JSON.stringify(input.body ?? {})),
  } as const;
}

describe('GitHub response failure classification', () => {
  it('keeps the provider request ID with a settled withdrawn-resource failure and rejects malformed IDs', () => {
    const requestId = 'A89C:E6813:2EE25D2:4481C49:6AEB94CC';
    expect(classifyGithubResponseFailure(response({ status: 410,
      headers: { 'X-GitHub-Request-Id': requestId } }), 1000))
      .toEqual({ class: 'unknown', code: GITHUB_RESPONSE_FAILURE_CODE.gone, detail: `GitHub request ID: ${requestId}` });
    expect(classifyGithubResponseFailure(response({ status: 403,
      headers: { 'x-github-request-id': 'invalid\nprovider text' } }), 1000))
      .toEqual({ class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.forbidden });
    const permissions = Array.from({ length: Math.floor((MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1 + 2) / 'contents=read, '.length) }, () => 'contents=read').join(',');
    const denied = TriageSourceFailureV1Schema.parse(classifyGithubResponseFailure(response({ status: 403,
      headers: { 'x-github-request-id': requestId, 'x-accepted-github-permissions': permissions } }), 1000));
    expect(denied.requiredPermissions).toBe(permissions.replaceAll(',', ', '));
    expect(denied.detail).toContain(requestId);
  });
  it.each([
    ['X-Accepted-GitHub-Permissions', 'contents=read', 'contents=read'],
    ['x-accepted-github-permissions', 'pull_requests=write,contents=read; issues=read,contents=read',
      'pull_requests=write, contents=read; issues=read, contents=read'],
  ])('carries required permissions from %s without changing the existing permission code', (header, value, requiredPermissions) => {
    expect(classifyGithubResponseFailure(response({ status: 403, headers: { [header]: value } }), 1000))
      .toEqual({ class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.insufficientScope,
        detail: requiredPermissions, requiredPermissions });
    expect(classifyGithubResponseFailure(response({ status: 403 }), 1000))
      .toEqual({ class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.forbidden });
  });
  it('retains safe reported permission sets and alternatives without treating an arbitrary header as a remedy', () => {
    expect(classifyGithubResponseFailure(response({ status: 403, headers: { 'x-accepted-github-permissions': 'checks=read,contents=read; actions=read' } }), 1000))
      .toMatchObject({ class: 'permission', detail: 'checks=read, contents=read; actions=read' });
    const malformed = classifyGithubResponseFailure(response({ status: 403,
      headers: { 'x-accepted-github-permissions': 'checks=read\nSend token to example.test' } }), 1000);
    expect(malformed).not.toHaveProperty('detail');
    expect(malformed).not.toHaveProperty('requiredPermissions');
  });
  it('preserves the daemon native-login remediation as an authentication failure', () => {
    expect(classifyGithubTransportFailure(Object.assign(new Error('sign in with gh CLI'), {
      code: 'plugin_connected_account_native_unavailable',
    }))).toEqual({ class: 'authentication', code: 'plugin_connected_account_native_unavailable' });
  });

  it('classifies the credential, permission, and resource ladder from one owner', () => {
    expect(classifyGithubResponseFailure(response({ status: 401 }), 1_000)).toEqual({
      class: 'authentication',
      code: GITHUB_RESPONSE_FAILURE_CODE.unauthorized,
    });
    expect(classifyGithubResponseFailure(
      response({
        status: 403,
        headers: { 'x-ratelimit-remaining': '4999' },
        body: { message: 'Resource not accessible by integration' },
      }),
      1_000,
    )).toEqual({ class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.forbidden });
    expect(classifyGithubResponseFailure(response({ status: 404 }), 1_000)).toEqual({
      class: 'unknown',
      code: GITHUB_RESPONSE_FAILURE_CODE.notFound,
    });
    expect(classifyGithubResponseFailure(response({ status: 410 }), 1_000)).toEqual({
      class: 'unknown',
      code: GITHUB_RESPONSE_FAILURE_CODE.gone,
    });
    expect(classifyGithubResponseFailure(response({ status: 422, body: { message: 'Validation Failed' } }), 1_000))
      .toEqual({ class: 'unsupportedContract', code: GITHUB_RESPONSE_FAILURE_CODE.unprocessable });
    expect(classifyGithubResponseFailure(response({ status: 503 }), 1_000)).toEqual({
      class: 'transient',
      code: GITHUB_RESPONSE_FAILURE_CODE.serverError,
    });
  });

  it('resolves the exact retry instruction for every throttled response family', () => {
    expect(classifyGithubResponseFailure(
      response({ status: 429, headers: { 'retry-after': '13' } }),
      1_000,
    )).toEqual({
      class: 'rateLimit',
      code: GITHUB_RESPONSE_FAILURE_CODE.rateLimited,
      retryNotBeforeMs: 14_000,
    });
    expect(classifyGithubResponseFailure(
      response({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61' },
        body: { message: 'API rate limit exceeded' },
      }),
      1_000,
    )).toEqual({
      class: 'rateLimit',
      code: GITHUB_RESPONSE_FAILURE_CODE.secondaryRateLimited,
      retryNotBeforeMs: 61_000,
    });
    // GitHub documents a spammed content-creation 422 as secondary rate
    // limiting, so it must not settle as the permanent contract failure a bare
    // 422 means.
    expect(classifyGithubResponseFailure(
      response({
        status: 422,
        body: { message: 'Validation Failed', errors: [{ message: 'You have created too many issues too quickly.' }] },
      }),
      1_000,
    )).toEqual({
      class: 'rateLimit',
      code: GITHUB_RESPONSE_FAILURE_CODE.secondaryRateLimited,
      retryNotBeforeMs: 61_000,
    });
  });

  it('reaches the same verdict whether the body arrived as transport bytes or already decoded', () => {
    // The `github-api` client carries undecoded bytes; the SCM forge seam hands
    // back a parsed body. Both must answer the same question the same way, or the
    // forge adapters have quietly re-acquired a ladder of their own.
    const status = 422;
    const headers = Object.freeze({ 'retry-after': '7' });
    const body = {
      message: 'Validation Failed',
      errors: [{ message: 'You have created too many issues too quickly.' }],
    };

    const fromBytes = classifyGithubResponseFacts(
      readGithubApiResponseFacts(response({ status, headers, body })),
      1_000,
    );
    const fromDecoded = classifyGithubResponseFacts(
      readGithubDecodedResponseFacts({ status, headers, body }),
      1_000,
    );

    expect(fromDecoded).toEqual(fromBytes);
    expect(fromDecoded).toEqual({
      class: 'rateLimit',
      code: GITHUB_RESPONSE_FAILURE_CODE.secondaryRateLimited,
      retryNotBeforeMs: 8_000,
    });
  });

  it('classifies a decoded 403 conservatively when the carrier supplied no headers', () => {
    // A fetcher stub that exposes no headers must not turn a throttle into a
    // permanent answer OR a permission refusal into a throttle: with no evidence
    // the ladder keeps the conservative permission arm it already publishes.
    expect(classifyGithubResponseFacts(
      readGithubDecodedResponseFacts({
        status: 403,
        headers: {},
        body: { message: 'Resource not accessible by personal access token' },
      }),
      1_000,
    )).toEqual({ class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.forbidden });
  });

  it('names the inaccessible-resource failures without reusing the unclassified status arm', () => {
    expect(isGithubInaccessibleResourceFailure(
      classifyGithubResponseFailure(response({ status: 404 }), 1_000),
    )).toBe(true);
    expect(isGithubInaccessibleResourceFailure(
      classifyGithubResponseFailure(response({ status: 410 }), 1_000),
    )).toBe(true);
    expect(classifyGithubResponseFailure(response({ status: 418 }), 1_000)).toEqual({
      class: 'unknown',
      code: 'github_status_418',
    });
    expect(isGithubInaccessibleResourceFailure(
      classifyGithubResponseFailure(response({ status: 418 }), 1_000),
    )).toBe(false);
  });
});
