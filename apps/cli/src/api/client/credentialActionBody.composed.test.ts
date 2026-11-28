import { createServer, maxHeaderSize } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionHttpBodyV1, verifyExternalActionMachineRequestV1, EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1,
  EXTERNAL_ACTION_HTTP_BODY_HEADER_V1, EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readEnvironmentSecretBindingPreparationForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { MANAGED_POLICY_PROOF_HEADER } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { runExternalActionPhase } from '@/daemon/externalActions/externalActionPhase';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { createCliWidgetInputActionDepsV1 } from '@/session/actions/widgetInputActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { waitFailureDispositionV1 } from '@happier-dev/protocol/actions/executor/waitAction';
import axios from './credentialAxios';

it.each([
  { kind: 'signed envelope', body: { error: 'credential_scope_denied', authorizationRefusal: 'effect_family' },
    failure: { errorCode: 'action_forbidden', failureCause: { phase: 'home.authorization.effect_family', httpStatus: 403 } } },
  { kind: 'endpoint', body: { ok: false, error: 'deployment_access_denied' },
    failure: { errorCode: 'deployment_access_denied', failureCause: { phase: 'deployment.secret_launch.admission', httpStatus: 403 } } },
  { kind: 'empty body', body: undefined,
    failure: { errorCode: 'action_forbidden', failureCause: undefined } },
] as const)('preserves the secret launch reader result for a $kind 403', async ({ body, failure }) => {
  const directory = await mkdtemp(join(tmpdir(), 'credential-action-'));
  const installationIdentityFile = join(directory, 'identity.json');
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(403, { 'content-type': 'application/json' })
      .end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const { installationId } = await readOrCreateInstallationIdentity(installationIdentityFile);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    // Home's signed proof is opaque to the client. The loopback server supplies its HTTP response.
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const result = await readEnvironmentSecretBindingPreparationForHost({
      credentials: { token, encryption: null },
      serverId: 'home', serverHttpBaseUrl: `http://127.0.0.1:${address.port}`,
      machineId: 'controller', installationId, installationIdentityFile,
      environmentId: 'environment', expectedRevision: 1, context: {}, signal: new AbortController().signal,
      createRequestHeaders: async () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'fixture' }),
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({ ok: false, errorCode: failure.errorCode });
    if (failure.failureCause) expect(result).toMatchObject({ failureCause: failure.failureCause });
    else expect(result).not.toHaveProperty('failureCause');
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it('sends a large signed mutation through the default HTTP parser without oversized proof headers', async () => {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
  const target = { kind: 'machine' as const, machineId: 'controller' };
  // The opaque Home token is a synthetic external boundary; its size exceeds the real parser limit.
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
    token: 'synthetic-home-root-'.repeat(Math.ceil(maxHeaderSize * 2 / 20)), binding: {
      accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'home',
      machineId: target.machineId, installationId: 'installed-controller', actionId: 'deployments.deploy',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      requestId: 'deploy-request', requestEnvelopeDigest: 'a'.repeat(43), target,
    } });
  const body = { serverId: 'home', environmentId: 'environment', expectedRevision: 1 };
  let received: unknown;
  let largestHeader = 0;
  let redirectedRequests = 0;
  let refusalRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      response.writeHead(307, { location: `http://127.0.0.2:${address.port}/other` }).end();
      return;
    }
    if (request.url === '/other') redirectedRequests++;
    if (request.url === '/refused') refusalRequests++;
    largestHeader = Math.max(...request.rawHeaders.map(value => Buffer.byteLength(value)));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    if (request.url === '/refused') {
      response.writeHead(403).end(JSON.stringify({ error: 'credential_scope_denied', authorizationRefusal: 'effect_family' }));
      return;
    }
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const path = '/v1/deployments/deploy';
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization,
    effectActionId: authorization.binding.actionId, target, installationId: authorization.binding.installationId,
    privateKey: keys.secretKey, method: 'POST', path, body });
  try {
    const mixedCaseHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toUpperCase(), value]));
    const result = await axios.post(`http://127.0.0.1:${address.port}${path}`, body, { headers: mixedCaseHeaders });
    expect(result.status).toBe(200);
    expect(largestHeader).toBeLessThan(maxHeaderSize);
    const decoded = decodeExternalActionHttpBodyV1(received);
    expect(decoded?.body).toEqual(body);
    const proof = { authorizationToken: authorization.token, effectActionId: authorization.binding.actionId,
      target, installationId: authorization.binding.installationId, requestId: authorization.binding.requestId,
      method: 'POST', path, body: decoded?.body,
      signature: decoded?.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? '', publicKey: keys.publicKey };
    expect(verifyExternalActionMachineRequestV1(proof)).toBe(true);
    expect(verifyExternalActionMachineRequestV1({ ...proof, body: { ...body, expectedRevision: 2 } })).toBe(false);
    const redirectHeaders = createExternalActionAuthorizedRequestHeaders({ authorization,
      effectActionId: authorization.binding.actionId, target, installationId: authorization.binding.installationId,
      privateKey: keys.secretKey, method: 'POST', path: '/redirect' });
    // Even an otherwise empty mutation now has secret proof content; a cross-origin redirect cannot replay it.
    await expect(axios.create().post(`http://127.0.0.1:${address.port}/redirect`, undefined, {
      headers: redirectHeaders,
    })).rejects.toMatchObject({ code: 'credential_request_redirect_refused' });
    expect(redirectedRequests).toBe(0);
    expect(received).toMatchObject({ v: 1, authorization: {
      executionAuthorization: authorization.token, effectActionId: 'deployments.deploy',
    }, body });
    const refusedHeaders = createExternalActionAuthorizedRequestHeaders({ authorization,
      effectActionId: authorization.binding.actionId, target, installationId: authorization.binding.installationId,
      privateKey: keys.secretKey, method: 'POST', path: '/refused', body });
    await expect(axios.post(`http://127.0.0.1:${address.port}/refused`, body, {
      headers: refusedHeaders, validateStatus: () => true,
    })).rejects.toMatchObject({
      errorCode: 'action_forbidden', error: 'action_forbidden (home_signed_authorization_rejected:effect_family)',
      failureCause: { phase: 'home.authorization.effect_family', httpStatus: 403 },
    });
    expect(refusalRequests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('reads a receipt with first-Store-deploy proof sizes through the default parser and refuses proof-body redirects', async () => {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
  const target = { kind: 'machine' as const, machineId: 'controller' };
  // Opaque network-boundary proofs use the observed #89 value sizes, never captured credentials.
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'a'.repeat(2335), binding: {
    accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: 'home',
    machineId: target.machineId, installationId: 'installed-controller', actionId: 'deployments.deploy',
    authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
    requestId: 'store-install-deploy', requestEnvelopeDigest: 'a'.repeat(43), target,
  } });
  const child = 'c'.repeat(15532);
  const path = '/v1/deployments/receipts/first-store-receipt?environmentId=store-environment';
  const signedHeaders = (signedPath: string) => ({ ...createExternalActionAuthorizedRequestHeaders({ authorization,
    effectActionId: authorization.binding.actionId, target, installationId: authorization.binding.installationId,
    privateKey: keys.secretKey, method: 'GET', path: signedPath }),
    [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: child });
  let received: unknown;
  let wireMethod: string | undefined;
  let wirePath: string | undefined;
  let marker: unknown;
  let secondHopRequests = 0;
  const leakedHeaders: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/source') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      response.writeHead(307, { location: `http://127.0.0.2:${address.port}/other` }).end();
      return;
    }
    if (request.url === '/other') secondHopRequests++;
    wireMethod = request.method;
    wirePath = request.url;
    marker = request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1];
    leakedHeaders.push(...EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1.filter(header => request.headers[header] !== undefined));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  try {
    const result = await axios.get(`http://127.0.0.1:${address.port}${path}`, { proxy: false, headers: signedHeaders(path) });
    expect(result.status).toBe(200);
    expect(wireMethod).toBe('POST');
    expect(wirePath).toBe(path);
    expect(marker).toBe(EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1);
    expect(leakedHeaders).toEqual([]);
    const decoded = decodeExternalActionHttpBodyV1(received);
    expect(decoded?.body).toBeUndefined();
    expect(decoded?.headers[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]).toBe(child);
    const proof = { authorizationToken: authorization.token, effectActionId: authorization.binding.actionId,
      target, installationId: authorization.binding.installationId, requestId: authorization.binding.requestId,
      method: 'GET', path, body: undefined,
      signature: decoded?.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? '', publicKey: keys.publicKey };
    expect(verifyExternalActionMachineRequestV1(proof)).toBe(true);
    expect(verifyExternalActionMachineRequestV1({ ...proof, method: 'POST' })).toBe(false);
    expect(verifyExternalActionMachineRequestV1({ ...proof, path: path.replace('store-environment', 'other') })).toBe(false);
    await expect(axios.create().get(`http://127.0.0.1:${address.port}/source`, {
      proxy: false, headers: signedHeaders('/source'),
    })).rejects.toMatchObject({ code: 'credential_request_redirect_refused' });
    expect(secondHopRequests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('sends an accepted-input wake policy proof through the default parser without an oversized header', async () => {
  // The proof embeds the original Action authorization; this opaque size is the observed 431 on a guest wake.
  const proof = 'p'.repeat(maxHeaderSize + 2000);
  const body = { homeId: 'home', managedId: 'managed' };
  let largestHeader = 0;
  let received: unknown;
  let leaked: unknown;
  const server = createServer(async (request, response) => {
    largestHeader = Math.max(...request.rawHeaders.map(value => Buffer.byteLength(value)));
    leaked = request.headers[MANAGED_POLICY_PROOF_HEADER];
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  try {
    const result = await axios.post(`http://127.0.0.1:${address.port}/v1/machines/managed/controller/prepare-policy`, body,
      { proxy: false, headers: { Authorization: 'Bearer synthetic', [MANAGED_POLICY_PROOF_HEADER]: proof } });
    expect(result.status).toBe(200);
    expect(largestHeader).toBeLessThan(maxHeaderSize);
    expect(leaked).toBeUndefined();
    const decoded = decodeExternalActionHttpBodyV1(received);
    expect(decoded?.body).toEqual(body);
    expect(decoded?.headers[MANAGED_POLICY_PROOF_HEADER]).toBe(proof);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each([
  { status: 401, phase: 'verification_purpose', acceptStatus: true, unsigned: false },
  { status: 401, phase: 'effect_family', acceptStatus: false, unsigned: false },
  { status: 401, phase: 'verification_purpose', acceptStatus: false, unsigned: false, configuredError: 'authentication_failed' },
  { status: 403, phase: 'effect_family', acceptStatus: true, unsigned: false },
  { status: 403, phase: 'effect_family', acceptStatus: true, unsigned: false, resource: '/resource' },
  { status: 403, phase: 'deployment_domain_preparation', acceptStatus: true, unsigned: false, resource: '/v1/artifacts/domain' },
  { status: 404, phase: 'verification_purpose', acceptStatus: true, unsigned: false },
  { status: 401, phase: 'verification_purpose', acceptStatus: true, unsigned: true },
] as const)('keeps the Home refusal phase and sends one request (%j)', async ({
  status, phase, acceptStatus, unsigned, ...fixture
}) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify({
        error: 'configuredError' in fixture ? fixture.configuredError : status === 403 ? 'credential_scope_denied' : 'invalid_token',
        authorizationRefusal: phase,
      }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const path = 'resource' in fixture ? fixture.resource
      : bindExternalActionExecutionAuthorizationVerifyHttpPathV1('notifications.notify_me');
    const request = axios.post(`http://127.0.0.1:${address.port}${path}`, {}, {
      headers: unsigned ? { Authorization: 'Bearer fixture' } : { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'fixture' },
      ...(acceptStatus ? { validateStatus: () => true } : {}),
    });
    if (unsigned || status === 404) {
      await expect(request).resolves.toMatchObject({ status });
    } else {
      const errorCode = phase === 'deployment_domain_preparation' ? 'credential_scope_denied'
        : 'configuredError' in fixture || 'resource' in fixture ? 'action_forbidden'
          : status === 403 ? 'credential_scope_denied' : 'invalid_token';
      const error = await request.then(() => { throw new Error('Expected signed Home refusal'); }, (reason: unknown) => reason);
      expect(error).toMatchObject({
        ok: false, code: errorCode, errorCode, error: `action_forbidden (home_signed_authorization_rejected:${phase})`,
        response: { status },
        failureCause: { phase: `home.authorization.${phase}`, httpStatus: status,
          ...(phase === 'deployment_domain_preparation' ? { errorCode } : {}) },
      });
      const verification = await runExternalActionPhase('root_verify', 'controller', () => { throw error; });
      expect(verification).toMatchObject({
        ok: false, executionFailure: { errorCode, failureCause: { phase: `home.authorization.${phase}` } },
      });
      if (verification.ok || !verification.executionFailure) throw new Error('Expected relayed Home refusal');
      const failure = verification.executionFailure;
      if (errorCode === 'invalid_token') expect(mapUnknownErrorToControlError(error)).toMatchObject({ code: 'not_authenticated' });
      if (errorCode === 'credential_scope_denied') {
        expect(waitFailureDispositionV1(failure)).toBe('permission_denied');
        const scope = { serverId: 'home', accountId: 'owner' };
        const surface = { pluginId: 'acme.widget', localId: 'choice' };
        const field = { path: 'choice', title: 'Choice', widget: 'select' as const, optionsSourceId: 'fixture.choices' };
        const widget = createCliWidgetInputActionDepsV1({ ...scope,
          getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => scope,
            // The catalog port relays the failure already produced at the Home HTTP boundary above.
            widgetCatalog: { list: async () => [], readInstalledDescriptor: async () => failure },
          }), readCandidates: async () => [{ surface, availability: 'available', inputs: { fields: [field] },
            sizeDeclaration: { sizes: ['full'], defaultSize: 'full' } }], validateSession: async () => false,
        });
        const options = await widget.widgetInputs!.resolve({
          ref: { surface: { ...scope, owner: { kind: 'home' } }, instanceId: 'choice' },
          instance: { v: 1, id: 'choice', definition: { kind: 'installed', surface },
            bindings: { choice: { kind: 'value', value: 'selected' } } },
          context: { surface: 'cli' },
        });
        expect(options).toEqual({ status: 'denied', fields: [{ path: 'choice', status: 'denied', reasonCode: 'credential_scope_denied' }] });
      }
    }
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('keeps a redirected 401 unsigned after the redirect drops the Action proof', async () => {
  const target = { kind: 'machine' as const, machineId: 'controller' };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
    accountId: 'account', custodianAccountId: 'account', serverIdentityId: 'home', installationId: 'controller-installation',
    machineId: target.machineId, actionId: 'deployments.deploy', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', requestId: 'fixture-request', requestEnvelopeDigest: 'a'.repeat(43), target,
  } });
  const headers = createExternalActionAuthorizedRequestHeaders({
    authorization, effectActionId: authorization.binding.actionId, target, installationId: authorization.binding.installationId,
    privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11)).secretKey, method: 'GET', path: '/resource',
  });
  const hops: { method?: string; carriedProof: boolean }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const carriedProof = (body ? decodeExternalActionHttpBodyV1(JSON.parse(body))?.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]
      : request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) === authorization.token;
    hops.push({ method: request.method, carriedProof });
    if (request.url === '/resource') {
      response.writeHead(303, { location: '/signed-out' }).end();
      return;
    }
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    await expect(axios.get(`http://127.0.0.1:${address.port}/resource`, {
      headers, validateStatus: () => true,
    })).resolves.toMatchObject({ status: 401 });
    expect(hops).toEqual([{ method: 'POST', carriedProof: true }, { method: 'GET', carriedProof: false }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
