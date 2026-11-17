import { createServer, maxHeaderSize } from 'node:http';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionHttpBodyV1, verifyExternalActionMachineRequestV1, EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1,
  EXTERNAL_ACTION_HTTP_BODY_HEADER_V1, EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { MANAGED_POLICY_PROOF_HEADER } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import axios from './credentialAxios';

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
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      response.writeHead(307, { location: `http://127.0.0.2:${address.port}/other` }).end();
      return;
    }
    if (request.url === '/other') redirectedRequests++;
    largestHeader = Math.max(...request.rawHeaders.map(value => Buffer.byteLength(value)));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
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
