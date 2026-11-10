import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getSessionStatus } from './getSessionStatus';
import * as sessionSockets from '@/api/session/sockets';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { UNSUPPORTED_AGENT_SESSION_CAPABILITIES } from '@happier-dev/agents';

beforeEach(() => {
  // Direct owner reads may maintain their display projection. Keep that HTTP
  // boundary local while exercising the real best-effort unsupported-peer path.
  vi.spyOn(axios, 'patch').mockResolvedValue({ status: 400, data: {} });
});

afterEach(() => { vi.restoreAllMocks(); });

it.each([
  [{ sessionCapabilities: { ...UNSUPPORTED_AGENT_SESSION_CAPABILITIES, compaction: { events: true, manual: true } } }, 'supported'],
  [{ sessionCapabilities: UNSUPPORTED_AGENT_SESSION_CAPABILITIES }, 'unsupported'],
  [undefined, 'unknown'],
] as const)('projects compact evidence through the CLI status schema: %s', async (publication, status) => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ flavor: 'external/agent', ...(publication ? { agentRuntimeCapabilitiesV1: publication } : {}) }) });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: false });
  expect(result).toMatchObject({ ok: true, compaction: { status } });
  if (result.ok) expect(SessionStatusResultSchema.parse(result)).toEqual(result);
});

it.each([
  { signIn: { status: 'unknown', loginSupport: 'unsupported' }, state: 'ready' },
  { signIn: { status: 'signedOut', loginSupport: 'unsupported', required: true }, state: 'needsSignIn' },
  { signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, state: 'needsSignIn' },
  { signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, state: 'ready' },
])('uses canonical Agent readiness in Session status: $state / $signIn.loginSupport', async ({ signIn, state }) => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex', path: '/workspace' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  const inventory = MachinesAgentsListOutputSchema.parse({ items: [{ agentId: 'codex', title: 'Codex',
    installed: true, version: null, latestVersion: null, update: { supported: false, command: null },
    signIn, platform: { supported: true }, dependencies: [],
    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null } }] });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active: true,
      revokedAt: null, replacedByMachineId: null, access: { custodian: { accountId: 'owner', displayName: 'Owner' },
        role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, live: false, readiness: true,
    readReadinessInventory: async () => inventory });
  expect(result).toMatchObject({ ok: true, readiness: { agent: { agentId: 'codex', current: true, state } } });
  if (result.ok) expect(SessionStatusResultSchema.parse(result)).toEqual(result);
});

it.each(['profile', 'pool', 'native', 'malformed'] as const)('projects the Session Connected selection without credentials: %s', async kind => {
  const sessionId = 'c123456789012345678901234';
  const connectedServices = { v: 2, bindingsByServiceId: kind === 'native' ? {} : {
    'acme.auth/subscription': kind === 'pool'
      ? { source: 'connected', selection: 'group', groupId: 'session-pool', profileId: 'current-member' }
      : { source: 'connected', selection: 'profile', profileId: 'session-selected',
        ...(kind === 'malformed' ? { accessToken: 'must-never-escape' } : {}) },
  } };
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', connectedServices, environmentVariables: { PRIVATE: 'must-never-escape' } }) });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: false });
  expect(result.ok).toBe(true);
  if (kind === 'malformed') expect(result).not.toHaveProperty('connectedServices');
  else expect(result).toMatchObject({ connectedServices: kind === 'pool' ? { v: 2, bindingsByServiceId: {
    'acme.auth/subscription': { source: 'connected', selection: 'group', groupId: 'session-pool' },
  } } : connectedServices });
  if (kind === 'pool') expect(JSON.stringify(result)).not.toContain('current-member');
  expect(JSON.stringify(result)).not.toContain('must-never-escape');
  if (result.ok) expect(SessionStatusResultSchema.parse(result)).toEqual(result);
});

it('never widens a protected status read to a live socket using the host token', async () => {
  const sessionId = 'c123456789012345678901234';
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
    machineId: 'machine', custodianAccountId: 'host', installationId: 'installed',
    actionId: 'session.status.get', requestId: 'status', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'session', sessionId },
  } });
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers?.Authorization).toBe('Bearer requester-bound-read');
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const socket = vi.spyOn(sessionSockets, 'createSessionScopedSocket').mockImplementation(() => {
    throw new Error('An unscoped live socket must not be opened');
  });
  expect(await getSessionStatus({ credentials: { token: 'host-token', encryption: null },
    idOrPrefix: sessionId, live: true, authorization,
    resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer requester-bound-read' }),
  })).toMatchObject({ ok: true, session: { id: sessionId } });
  expect(socket).not.toHaveBeenCalled();
});

it.each([true, false])('distinguishes saved setup from current invocation permission (%s)', async allowed => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex', path: '/workspace' }),
    effectiveAccess: { v: 1, level: allowed ? 'owner' : 'view', sources: [],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: allowed, grants: [] }) } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, live: false, readiness: true });
  expect(result).toMatchObject({ ok: true, readiness: { v: 1, configured: true,
    status: allowed ? 'unknown' : 'unavailable', cause: allowed ? 'machine' : 'invocation',
    invocation: { capabilities: { submitAgentInput: allowed } },
    machine: { status: 'unknown', machineId: 'machine-1' }, agent: null,
    credential: { kind: 'not_required' } } });
  if (result.ok) expect(SessionStatusResultSchema.parse(result)).toEqual(result);
});

it('does not acquire inventory when readiness was not requested', async () => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
  const requests: string[] = [];
  const readReadinessInventory = vi.fn(async () => MachinesAgentsListOutputSchema.parse({ items: [] }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: false,
    readReadinessInventory });
  expect(result.ok).toBe(true);
  expect(result).not.toHaveProperty('readiness');
  expect(readReadinessInventory).not.toHaveBeenCalled();
  expect(requests).not.toContain('/v1/machines');
});

it('reads only the Session Machine host facts for readiness, independent of the Account fleet', async () => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex', path: '/workspace' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  const machineRow = (id: string) => ({ id, active: true, revokedAt: null, replacedByMachineId: null,
    metadata: JSON.stringify({ displayName: id, host: id, platform: 'linux' }),
    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
  const fleet = ['machine-1', ...Array.from({ length: 128 }, (_, index) => `unrelated-${index}`)].map(machineRow);
  const served = { rows: 0, fullProjectionReads: 0 };
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    const hostFacts = (config?.headers as Record<string, unknown> | undefined)?.Accept
      === 'application/json;happier-machine-projection=host-facts';
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === '/v1/machines' || path.startsWith('/v1/machines/')) {
      const rows = path === '/v1/machines' ? fleet : fleet.filter(machine => path === `/v1/machines/${machine.id}`);
      served.rows += rows.length;
      if (!hostFacts) served.fullProjectionReads += 1;
      const projected = hostFacts ? rows.map(({ metadata: _metadata, ...facts }) => facts) : rows;
      return { status: 200, data: path === '/v1/machines' ? projected : { machine: projected[0] } };
    }
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const inventory = MachinesAgentsListOutputSchema.parse({ items: [{ agentId: 'codex', title: 'Codex',
    installed: true, version: null, latestVersion: null, update: { supported: false, command: null },
    signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true }, dependencies: [],
    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null } }] });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, live: false, readiness: true, readReadinessInventory: async () => inventory,
    // A requester-bound status read: the owner display-projection write is not part of this contract.
    resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer token' }) });
  expect(result).toMatchObject({ ok: true, readiness: { machine: { machineId: 'machine-1' },
    agent: { agentId: 'codex', current: true, state: 'ready' } } });
  expect(served).toEqual({ rows: 1, fullProjectionReads: 0 });
});
