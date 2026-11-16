// Recorded contract vocabulary: Docker Sandboxes OpenAPI v1, retrieved
// 2026-11-15 from https://docs.docker.com/reference/api/sandboxes/api.yaml.
// Success payloads below are constructed from those schemas, not tenant captures.
export const sandboxFixture = {
  name: 'sandboxes/fixture', uid: 'fixture',
  core: { status: 'running', createdAt: '2026-11-15T17:00:00Z', etag: '"fixture-etag"',
    labels: { 'happier-managed-id': 'managed-fixture' },
    endpoint: { uri: 'https://sandbox.invalid/fixture', protocol: 'http',
      credentialAudience: 'fixture-audience', sandbox: 'sandboxes/fixture', sandboxUid: 'fixture',
      apiVersion: 'v1', capabilities: ['exec', 'writeFile'], authentication: { scheme: 'scopedBearer' } } },
  effectiveFeatures: { timeouts: { onTimeout: 'delete', initialTimeout: '3600s', expiresAt: '2026-11-15T18:00:00Z' } },
};
export const endpointCredentialFixture = { token: 'fixture-scoped-token', expireTime: '2026-11-15T17:05:00Z',
  permissions: ['sandboxesExec', 'sandboxesFilesWrite'], sandbox: sandboxFixture.name, audience: 'fixture-audience' };
// Verbatim error example from CreateSandbox's 409 response in that OpenAPI.
export const conflictFixture = { code: 'failedPrecondition', message: 'The Idempotency-Key was already used with a different payload.' };
