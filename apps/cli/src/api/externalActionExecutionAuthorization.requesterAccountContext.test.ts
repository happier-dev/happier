import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionRequestEnvelopeSchema, type ActionExecuteResult } from '@happier-dev/protocol';
import { openExternalActionRequesterAccountContextV1, projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { dispatchManagedSessionStart, dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';
import { encodeStoredCredentials, updateSettings, type StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { configuration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { effectiveCredentialAuthority, narrowCredentialAuthority } from '../../../server/sources/app/auth/effectiveCredentialAuthority';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';

// Terminal reads and controlling-TTY availability are genuine user/OS boundaries;
// the consent owner and its default-no answer parsing stay real.
const terminal = vi.hoisted(() => ({ interactive: true, answer: 'no', prompts: [] as string[] }));
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(),
  isInteractiveTerminal: () => terminal.interactive,
  promptInput: async (message: string) => { terminal.prompts.push(message); return terminal.answer; },
}));

const servers: Server[] = [];
const homeIdentityId = 'srv_requester_home';
afterEach(async () => {
  terminal.interactive = true; terminal.answer = 'no'; terminal.prompts = []; process.exitCode = undefined;
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

function token(kind: 'account' | 'terminal' = 'account') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: 'bob', tokenEpoch: 7, provenance: {
    v: 1, kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
  } })}.signature`;
}

async function home(mode: 'plain' | 'e2ee', events: string[], options: {
  mutateRoot?: boolean; custodianAccountId?: string; authenticationKind?: 'account' | 'terminal';
  finiteWake?: boolean; finiteAction?: boolean; staleController?: 'key' | 'installation';
  originalOwnAction?: 'settings.list'; ownExecution?: ActionExecuteResult; onInventoryRead?: () => void; localDaemon?: boolean;
  localDaemonExecution?: ActionExecuteResult;
  retireOwnAction?: boolean;
  retireAccountSecurity?: boolean;
  retireSessionAccess?: boolean;
  allowedTerminalSecurity?: boolean;
  authorityCeiling?: 'account_automation';
} = {}) {
  const seed = new Uint8Array(32).fill(19);
  const publicKey = ed25519.getPublicKey(seed);
  const controllerSeed = new Uint8Array(32).fill(29);
  const controllerPublicKey = ed25519.getPublicKey(controllerSeed);
  const actionId = options.originalOwnAction ?? (options.finiteWake || options.finiteAction ? 'projects.script.run' : 'machines.work.summary.get');
  let received: unknown;
  const retiredRequests: Array<Readonly<{ path: string; authorization: string | undefined; body?: unknown }>> = [];
  const securityPrincipals: Array<Readonly<{ authority: ReturnType<typeof effectiveCredentialAuthority>; authorization: string | undefined }>> = [];
  const server = createServer(async (request, response) => {
    const respond = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    const machine = { id: 'alice-machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
      installationId: 'alice-installation', installationPublicKey: encodeBase64(publicKey), storageMode: 'plain',
      access: { custodian: { accountId: options.custodianAccountId ?? 'alice', displayName: 'Alice' }, role: 'use', resourceMode: options.custodianAccountId === 'bob' ? mode : 'plain', accessState: 'ready' } };
    const controller = { ...machine, id: 'alice-controller', installationId: 'controller-installation',
      installationPublicKey: encodeBase64(controllerPublicKey),
      access: { ...machine.access, custodian: { accountId: 'alice', displayName: 'Alice' } } };
    if (request.url === '/v1/account/encryption') return respond({ mode, updatedAt: 1 });
    if (request.url === '/v1/machines') {
      options.onInventoryRead?.();
      return respond(options.finiteWake ? [machine, controller] : [machine]);
    }
    if (request.url === '/ping') return respond({ status: 'ok' });
    if (request.url === '/v1/machines/alice-machine') return respond({ machine });
    if (request.url === '/v1/machines/alice-controller') return respond({ machine: options.staleController === 'installation'
      ? { ...controller, installationId: 'replacement-controller-installation' } : controller });
    if (options.allowedTerminalSecurity && request.method === 'GET' && request.url === '/v1/account/security') {
      // The network fixture substitutes credential verification/current Account
      // storage only. The receiver's actual effective authority and narrowing
      // owners consume the received request beneath that boundary.
      const effective = effectiveCredentialAuthority({ credentialKind: 'terminal', mintedAuthority: 'account_automation',
        terminalPresentUserPolicy: 'allowed' });
      securityPrincipals.push({ authority: narrowCredentialAuthority(effective, request.headers[AUTHORITY_CEILING_HEADER_V1]),
        authorization: request.headers.authorization });
      return respond(AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: mode, terminalPresentUserPolicy: 'allowed',
        nativeEmail: null, password: { status: 'not_enrolled', revision: null } }));
    }
    if (options.retireAccountSecurity && request.method === 'GET' && request.url === '/v1/account/security') {
      retiredRequests.push({ path: request.url, authorization: request.headers.authorization });
      events.push('account-security');
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body: unknown = JSON.parse(raw);
    if (options.retireSessionAccess && request.url === '/v2/sessions/access-grants/list') {
      retiredRequests.push({ path: request.url, authorization: request.headers.authorization, body });
      events.push('session-access');
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    if (options.localDaemon && request.url === '/actions/root/execute') {
      events.push('local-daemon'); received = body;
      return respond(options.localDaemonExecution ?? { ok: true, result: { items: [] } });
    }
    if ((options.authenticationKind === 'terminal' || options.authorityCeiling === 'account_automation')
      && request.headers[AUTHORITY_CEILING_HEADER_V1.toLowerCase()] !== 'account_automation') {
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    if (request.url?.endsWith('/execution-authorization')) {
      events.push('home-authorized');
      const prepared = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'exact-home-root', binding: {
        accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 }, accountEncryptionMode: mode,
        serverIdentityId: homeIdentityId, custodianAccountId: options.custodianAccountId ?? 'alice', machineId: 'alice-machine',
        installationId: 'alice-installation', actionId, requestId: 'request-1',
        target: prepared.envelope.target!, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(prepared.envelope),
      } };
      if (options.finiteWake) authorization.managedFiniteWake = {
        target: ManagedWakeTargetV1Schema.parse({ homeId: homeIdentityId, managedId: 'managed-guest',
          enrolledMachineId: machine.id, expectedIntentRevision: 4,
          controller: { machineId: controller.id, installationId: controller.installationId },
          origin: { kind: 'finite-command', actionRequestId: 'request-1' }, reason: 'admitted-work' }),
        installationPublicKey: encodeBase64(options.staleController === 'key'
          ? ed25519.getPublicKey(new Uint8Array(32).fill(4)) : controllerPublicKey, 'base64url'),
      };
      if (options.mutateRoot) authorization.binding.requestId = 'different-request';
      return respond(authorization);
    }
    events.push('dispatch');
    received = body;
    if (options.originalOwnAction && options.retireOwnAction) {
      retiredRequests.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      response.statusCode = 401;
      return respond({ error: 'invalid_token' });
    }
    const original = ExternalActionRequestEnvelopeSchema.safeParse(body);
    if (options.originalOwnAction && original.success) {
      const execution = options.ownExecution ?? { ok: true, result: { items: [] } };
      if (original.data.v === 2) {
        const binding = { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 },
          actionId, requestId: 'request-1', target: { kind: 'machine' as const, machineId: 'alice-machine' } };
        const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) };
        expect(openExternalActionRequestV2({ envelope: original.data, binding, material })?.input).toEqual({});
        return respond(prepareExternalActionResponseV2({ request: original.data, binding, material,
          executedMachineId: 'alice-machine', randomBytes: length => new Uint8Array(length).fill(6), execution }).response);
      }
      return respond({ v: 1, actionId, requestId: 'request-1', execution });
    }
    // The incumbent own finite producer initially posts its plain envelope;
    // preserving this wire boundary lets its missing Home hint fail observably.
    const dispatched = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
    if (!dispatched.success) return respond({ v: 1, actionId, requestId: 'request-1',
      execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } });
    if (dispatched.data.envelope.v === 2) return respond(prepareExternalActionResponseV2({ request: dispatched.data.envelope,
      binding: { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: options.authenticationKind ?? 'account', tokenEpoch: 7 },
        actionId, requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' } },
      material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) },
      executedMachineId: 'alice-machine', randomBytes: length => new Uint8Array(length).fill(6),
      execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } }).response);
    return respond({ v: 1, actionId, requestId: 'request-1', execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Home fixture did not listen');
  return { url: `http://127.0.0.1:${address.port}`, readReceived: () => received, readRetiredRequests: () => retiredRequests,
    readSecurityPrincipals: () => securityPrincipals,
    privateKey: new Uint8Array([...seed, ...publicKey]),
    controllerPrivateKey: new Uint8Array([...controllerSeed, ...controllerPublicKey]) };
}

describe('ordinary CLI requester Account custody on the existing Action carrier', () => {
  it.each(['plain', 'e2ee'] as const)('delivers an own remote %s client Action without a local daemon or private custody disclosure', async mode => {
    await withTempDir('happier-own-remote-action-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home(mode, events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list' });
        const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null
          : { type: 'legacy', secret: new Uint8Array(32).fill(23) }, credentialProvenance: 'stored_session' };
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { throw new Error('Own Account work must not disclose private custody'); } });
        await expect(executor.execute('settings.list', {}, { surface: 'cli', actionRequestId: 'request-1' }))
          .resolves.toEqual({ ok: true, result: { items: [] } });
        const received = ExternalActionRequestEnvelopeSchema.parse(target.readReceived());
        expect(received.target).toEqual({ kind: 'machine', machineId: 'alice-machine' });
        expect(received.v).toBe(mode === 'plain' ? 1 : 2);
        expect(events).toEqual(['dispatch']);
        expect(JSON.stringify(received)).not.toContain(credentials.token);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([
    { separateHome: false, legacy: false, legacyState: false },
    { separateHome: true, legacy: false, legacyState: false },
    { separateHome: true, legacy: true, legacyState: false },
    { separateHome: true, legacy: true, legacyState: true },
  ])('retains a positively published matching local endpoint on its incumbent signed-root control path (separate Home: $separateHome, legacy: $legacy, legacy state: $legacyState)', async ({ separateHome, legacy, legacyState }) => {
    await withTempDir('happier-own-local-action-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list', localDaemon: true });
        const control = separateHome ? await home('plain', events, { custodianAccountId: 'bob', localDaemon: true }) : target;
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify(legacyState
          ? { pid: process.pid, httpPort: Number(new URL(control.url).port), startTime: new Date().toISOString(), startedWithCliVersion: 'test' }
          : { pid: process.pid, httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: legacy ? `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature` : token(),
            encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        await expect(executor.execute('settings.list', {}, { surface: 'cli', actionRequestId: 'request-1' }))
          .resolves.toEqual({ ok: true, result: { items: [] } });
        expect(events).toEqual(['local-daemon']);
        expect(control.readReceived()).toMatchObject({ actionId: 'settings.list', target: { kind: 'machine', machineId: 'alice-machine' } });
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each(['account', 'terminal'] as const)('keeps own %s automation authority and propagates the Home refusal without a local daemon fallback', async authenticationKind => {
    await withTempDir('happier-own-remote-refusal-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list',
          authenticationKind, authorityCeiling: 'account_automation', ownExecution: { ok: false, errorCode: 'action_disabled', error: 'action_disabled' } });
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token(authenticationKind), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        await expect(executor.execute('settings.list', {}, { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(events).toEqual(['dispatch']);
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each(['machine', 'account-default', 'session'] as const)('preserves genuine terminal kind and retired epoch through Home even beside its own live Account daemon (%s)', async placement => {
    await withTempDir('happier-terminal-own-local-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list',
          authenticationKind: 'terminal', retireOwnAction: true, retireAccountSecurity: placement === 'account-default',
          retireSessionAccess: placement === 'session' });
        const control = await home('plain', events, { custodianAccountId: 'bob', localDaemon: true });
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
          httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
          machineId: 'alice-machine', accountId: 'bob', controlToken: 'test-daemon-control' }));
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          ...(placement === 'machine' ? { machineId: 'alice-machine' } : {}),
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { throw new Error('Own terminal origination must not disclose full Account custody'); },
        });
        const input = placement === 'session' ? { sessionId: 'session-1' } : {};
        const context = { surface: 'cli' as const, actionRequestId: 'request-1',
          ...(placement === 'session' ? { externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' } } : {}) };
        const result = await executor.execute(placement === 'machine' ? 'settings.list'
          : placement === 'session' ? 'session.access.grants.list' : 'account.security.get', input, context);
        expect(result).toMatchObject({ ok: false, errorCode: placement === 'machine' ? 'invalid_token' : 'not_authenticated' });
        expect(events).toEqual([placement === 'machine' ? 'dispatch' : placement === 'session' ? 'session-access' : 'account-security']);
        expect(target.readRetiredRequests()).toEqual([expect.objectContaining({ authorization: `Bearer ${token('terminal')}`,
          ...(placement === 'session' ? { path: '/v2/sessions/access-grants/list', body: { sessionId: 'session-1' } } : {}) })]);
        expect(control.readReceived()).toBeUndefined();
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each([true, false])('retains the original terminal automation ceiling at an allowed-policy Home without changing interactive CLI authority (external client: %s)', async externalClient => {
    const originalPolicy = configuration.terminalPresentUserPolicy;
    configuration.terminalPresentUserPolicy = 'allowed';
    try {
      expect(effectiveCredentialAuthority({ credentialKind: 'terminal', mintedAuthority: 'account_automation',
        terminalPresentUserPolicy: 'allowed' })).toBe('present_user');
      const target = await home('plain', [], { custodianAccountId: 'bob', allowedTerminalSecurity: true });
      const executor = createCliActionExecutorFromCredentials({ credentials: {
        token: token('terminal'), encryption: null, credentialProvenance: 'stored_session',
      }, ...(externalClient ? { externalActionClient: true as const } : {}),
        serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      });
      await expect(executor.execute('account.security.get', {}, { surface: 'cli', actionRequestId: 'terminal-ceiling' }))
        .resolves.toMatchObject({ ok: true, result: { terminalPresentUserPolicy: 'allowed' } });
      expect(target.readSecurityPrincipals()).toEqual([{ authority: externalClient ? 'account_automation' : 'present_user',
        authorization: `Bearer ${token('terminal')}` }]);
    } finally { configuration.terminalPresentUserPolicy = originalPolicy; }
  });

  it.each(['legacy', 'modern'] as const)('keeps Bob foreign Home admission and private custody despite a live Alice local publication (%s)', async publication => {
    await withTempDir('happier-foreign-legacy-publication-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const target = await home('plain', events);
        const control = await home('plain', events, { localDaemon: true,
          localDaemonExecution: { ok: false, errorCode: 'ambient_daemon_receipt', error: 'ambient_daemon_receipt' } });
        const serverDir = join(configuration.serversDir, 'home');
        await mkdir(serverDir, { recursive: true });
        await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify(publication === 'legacy'
          ? { pid: process.pid, httpPort: Number(new URL(control.url).port), startTime: new Date().toISOString(), startedWithCliVersion: 'test' }
          : { pid: process.pid, httpPort: Number(new URL(control.url).port), startedAt: Date.now(), startedWithCliVersion: 'test',
            machineId: 'alice-machine', accountId: 'alice', controlToken: 'test-daemon-control' }));
        const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
          onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } });
        await expect(executor.execute('machines.work.summary.get', { serverId: 'home', machineId: 'alice-machine' },
          { surface: 'cli', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
        const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
        expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
          serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
        expect(events).not.toContain('local-daemon');
        expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it('cancels own remote origination during Home inventory before disclosure or dispatch', async () => {
    await withTempDir('happier-own-remote-cancel-', async taskDir => {
      const originalConfiguration = { serversDir: configuration.serversDir };
      Object.assign(configuration, { serversDir: join(taskDir, 'servers') });
      try {
        const events: string[] = [];
        const controller = new AbortController();
        const target = await home('plain', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list',
          onInventoryRead: () => controller.abort() });
        const executor = createCliActionExecutorFromCredentials({
          credentials: { token: token(), encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
        });
        await expect(executor.execute('settings.list', {}, { surface: 'cli', actionRequestId: 'request-1', signal: controller.signal }))
          .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(events).toEqual([]);
        expect(target.readReceived()).toBeUndefined();
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it('refuses own E2EE remote work without Account material rather than inventing a plain request', async () => {
    const events: string[] = [];
    const target = await home('e2ee', events, { custodianAccountId: 'bob', originalOwnAction: 'settings.list' });
    const result = await dispatchOriginalAccountAction({ actionId: 'settings.list', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId });
    expect(result).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(events).toEqual([]);
    expect(target.readReceived()).toBeUndefined();
  });

  it.each(['plain', 'e2ee'] as const)('discloses then delivers genuine %s Bob material sealed to the exact Home root and installation', async mode => {
    const events: string[] = [];
    const target = await home(mode, events);
    const credentials: StoredCredentials = { token: token(), encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const disclosure = { onRequesterSessionCredentialDisclosure: async (value: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => {
      expect(value).toMatchObject({ accountId: 'bob', machineId: 'alice-machine', fullSignIn: true, hostCanInspectLocalProcess: true });
      expect(target.readReceived()).toBeUndefined();
      events.push('disclosed');
      return true;
    } };
    await expect(dispatchOriginalAccountAction({ actionId: 'machines.work.summary.get', input: { serverId: 'home', machineId: 'alice-machine' },
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, ...disclosure })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
    expect(received.executionAuthorization?.requesterAccountContext?.installationId).toBe('alice-installation');
    const opening = { authorization: received.executionAuthorization, purpose: { kind: 'external_action' as const },
      machineId: 'alice-machine', installationId: 'alice-installation', serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey };
    expect(openExternalActionRequesterAccountContextV1(opening)).toEqual(encodeStoredCredentials(credentials));
    expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'machine_rpc', method: 'other', params: {} } })).toBeNull();
    expect(JSON.stringify(received)).not.toContain(credentials.token);
  });

  it('originates the same private carrier through the ordinary public CLI factory without a local daemon', async () => {
    const events: string[] = [];
    const target = await home('plain', events);
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      ...{ onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } } });
    await expect(executor.execute('machines.work.summary.get', { serverId: 'home', machineId: 'alice-machine' },
      { surface: 'cli', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
  });

  it.each(['plain', 'e2ee'] as const)('keeps genuine terminal kind and automation ceiling through %s private Account custody', async mode => {
    const events: string[] = [];
    const target = await home(mode, events, { authenticationKind: 'terminal' });
    const credentials: StoredCredentials = { token: token('terminal'),
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.work.summary.get',
      input: { serverId: 'home', machineId: 'alice-machine' }, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, authority: 'account_automation',
      onRequesterSessionCredentialDisclosure: async () => { events.push('disclosed'); return true; } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob',
      authentication: { kind: 'terminal', tokenEpoch: 7 } });
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(events.indexOf('disclosed')).toBeLessThan(events.indexOf('dispatch'));
  });

  it('originates genuine terminal private custody through the public CLI factory without a human upgrade', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { authenticationKind: 'terminal' });
    const credentials: StoredCredentials = { token: token('terminal'), encryption: null, credentialProvenance: 'stored_session' };
    const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
      serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId, machineId: 'alice-machine',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
      onRequesterSessionCredentialDisclosure: async () => true });
    await expect(executor.execute('machines.work.summary.get', { serverId: 'home', machineId: 'alice-machine' },
      { surface: 'cli', authority: 'account_automation', actionRequestId: 'request-1' })).resolves.toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ authentication: { kind: 'terminal', tokenEpoch: 7 } });
    expect(openExternalActionRequesterAccountContextV1({ authorization: received.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
  });

  it('preserves terminal authentication in the genuine protected managed acquire to Session-start child cipher', async () => {
    await withTempDir('happier-terminal-managed-child-', async taskDir => {
      const originalConfiguration = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile };
      Object.assign(configuration, { happyHomeDir: taskDir, settingsFile: join(taskDir, 'settings.json') });
      try {
        const seed = new Uint8Array(32).fill(19);
        const publicKey = ed25519.getPublicKey(seed);
        const material = { type: 'dataKey' as const,
          machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(23)) };
        const controller = { kind: 'machine' as const, machineId: 'alice-controller' };
        const guest = { kind: 'machine' as const, machineId: 'alice-guest' };
        const acquireEnvelope = { v: 1 as const, requestId: 'request-1', target: controller, input: {} };
        const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'terminal-acquire-root', binding: {
          accountId: 'bob', authentication: { kind: 'terminal', tokenEpoch: 7 }, accountEncryptionMode: 'e2ee',
          serverIdentityId: homeIdentityId, custodianAccountId: 'alice', machineId: controller.machineId,
          installationId: 'controller-installation', actionId: 'machines.managed.acquire', requestId: 'request-1',
          target: controller, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(acquireEnvelope),
        } };
        const binding = { serverIdentityId: homeIdentityId, accountId: 'bob', authentication: { kind: 'terminal' as const, tokenEpoch: 7 },
          actionId: 'session.spawn_new', requestId: 'request-1', target: guest };
        let opened: unknown;
        let signatureValid = false;
        const server = createServer(async (request, response) => {
          let raw = '';
          for await (const chunk of request) raw += String(chunk);
          const body: unknown = JSON.parse(raw);
          const parsed = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          if (parsed.envelope.v !== 2) throw new Error('Expected protected terminal child');
          const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER.toLowerCase()];
          signatureValid = typeof signature === 'string' && verifyExternalActionMachineRequestV1({
            authorizationToken: authorization.token, effectActionId: 'machines.managed.acquire', target: controller,
            installationId: 'controller-installation', requestId: 'request-1', method: 'POST',
            path: '/v1/actions/session.spawn_new', body, publicKey, signature });
          opened = openExternalActionRequestV2({ envelope: parsed.envelope, binding, material })?.input;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(prepareExternalActionResponseV2({ request: parsed.envelope, binding, material,
            executedMachineId: guest.machineId, randomBytes: length => new Uint8Array(length).fill(6),
            execution: { ok: false, errorCode: 'fixture_receipt', error: 'fixture_receipt' } }).response));
        });
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Home fixture did not listen');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
          terminalChildHome: { id: 'terminalChildHome', name: 'Terminal child Home', serverUrl, webappUrl: serverUrl,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeIdentityId, canonicalServerUrl: serverUrl,
              revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } } } }));
        const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: 'terminalChildHome', machineId: guest.machineId },
          directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } });
        const result = await dispatchManagedSessionStart({ input, authorization, installationId: 'controller-installation',
          privateKey: new Uint8Array([...seed, ...publicKey]), serverHttpBaseUrl: serverUrl, material,
          continuation: { managedId: 'managed-guest', creationRequestId: 'request-1', expectedIntentRevision: 1 } });
        expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
        expect(signatureValid).toBe(true);
        expect(opened).toMatchObject({ executionTarget: { serverId: homeIdentityId, machineId: guest.machineId },
          agentTarget: input.agentTarget });
      } finally { Object.assign(configuration, originalConfiguration); }
    });
  });

  it.each(['bob', 'alice'] as const)('captures the same original finite root for a %s-owned guest and genuine Bob custody on its foreign controller', async guestCustodian => {
    const events: string[] = [];
    const target = await home('plain', events, { finiteWake: true, custodianAccountId: guestCustodian });
    const credentials: StoredCredentials = { token: token(), encryption: null };
    const disclosedRecipients: string[] = [];
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials,
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: async disclosure => {
        expect(disclosure.accountId).toBe('bob');
        expect(disclosure.fullSignIn).toBe(true);
        if (disclosure.machineId === 'alice-controller') expect(disclosure).toMatchObject({
          custodian: { accountId: 'alice', displayName: 'Alice' },
        });
        expect(target.readReceived()).toBeUndefined();
        disclosedRecipients.push(disclosure.machineId);
        return true;
      } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    expect(disclosedRecipients).toEqual(guestCustodian === 'bob'
      ? ['alice-controller'] : ['alice-machine', 'alice-controller']);
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    const authorization = received.executionAuthorization;
    expect(authorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: guestCustodian,
      machineId: 'alice-machine', installationId: 'alice-installation', actionId: 'projects.script.run', requestId: 'request-1' });
    expect(authorization?.binding.requestEnvelopeDigest).toBe(computeExternalActionRequestEnvelopeDigestV1(received.envelope));
    expect(authorization?.managedFiniteWake?.requesterAccountContext?.installationId).toBe('controller-installation');
    if (!authorization?.managedFiniteWake) throw new Error('Expected the exact Home finite-wake hint');
    expect(openExternalActionRequesterAccountContextV1({ authorization,
      purpose: { kind: 'managed_finite_wake', target: authorization.managedFiniteWake.target },
      machineId: 'alice-controller', installationId: 'controller-installation', serverIdentityId: homeIdentityId,
      installationPrivateKey: target.controllerPrivateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(authorization.requesterAccountContext === undefined).toBe(guestCustodian === 'bob');
    if (guestCustodian === 'alice') expect(openExternalActionRequesterAccountContextV1({ authorization,
      purpose: { kind: 'external_action' }, machineId: 'alice-machine', installationId: 'alice-installation',
      serverIdentityId: homeIdentityId, installationPrivateKey: target.privateKey })).toEqual(encodeStoredCredentials(credentials));
    expect(events).toContain('home-authorized');
    expect(JSON.stringify(received)).not.toContain(credentials.token);
  });

  it('retains own finite work without any managed hint, disclosure or private Box', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { finiteAction: true, custodianAccountId: 'bob' });
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: async () => { throw new Error('There is no foreign recipient'); } });
    expect(result).toMatchObject({ errorCode: 'fixture_receipt' });
    const received = ExternalActionExecutionAuthorizationRequestV1Schema.parse(target.readReceived());
    expect(received.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId: 'bob' });
    expect(received.executionAuthorization?.managedFiniteWake).toBeUndefined();
    expect(received.executionAuthorization?.requesterAccountContext).toBeUndefined();
  });

  it.each(['key', 'installation'] as const)('withholds controller custody when the Home hint no longer matches its actual published %s', async staleController => {
    const events: string[] = [];
    const target = await home('plain', events, { finiteWake: true, custodianAccountId: 'bob', staleController });
    const disclosedRecipients: string[] = [];
    const result = await dispatchOriginalAccountAction({ actionId: 'projects.script.run',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({
        workspace: { serverId: 'home', workspaceId: 'workspace-1', machineId: 'alice-machine', rootPath: '/workspace' },
        selection: { kind: 'named', name: 'test' } }),
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' },
      credentials: { token: token(), encryption: null }, serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId,
      onRequesterSessionCredentialDisclosure: async disclosure => { disclosedRecipients.push(disclosure.machineId); return true; } });
    expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(disclosedRecipients).toEqual([]);
    expect(target.readReceived()).toBeUndefined();
  });

  it('retains the incumbent own-Machine path for positively observed legacy Account credentials', async () => {
    const events: string[] = [];
    const target = await home('plain', events, { custodianAccountId: 'bob' });
    const legacyToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.work.summary.get', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: legacyToken, encryption: null },
      serverHttpBaseUrl: target.url, foreignTargetOnly: true });
    expect(result).toBeNull();
    expect(target.readReceived()).toBeUndefined();
  });

  it('withholds accepted private custody when credentials retire during confidentiality consent', async () => {
    const events: string[] = [];
    const target = await home('plain', events);
    let current = true;
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.work.summary.get', input: {}, requestId: 'request-1',
      target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, isCurrent: () => current,
      onRequesterSessionCredentialDisclosure: async () => { current = false; return true; } });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(target.readReceived()).toBeUndefined();
  });

  it.each(['yes', 'no', 'noninteractive', 'json'] as const)('requires actual CLI confidentiality consent before private delivery (%s)', async answer => {
    const events: string[] = [];
    const target = await home('plain', events);
    terminal.interactive = answer !== 'noninteractive'; terminal.answer = answer === 'yes' ? 'yes' : 'no';
    const credentials: StoredCredentials = { token: token(), encryption: null, credentialProvenance: 'stored_session' };
    const output = captureConsoleText();
    try {
      await handleActionsCommand(['invoke', 'machines.work.summary.get', '--machine-id', 'alice-machine', '--request-id', 'request-1',
        '--input-json', JSON.stringify({ serverId: 'home', machineId: 'alice-machine' }), ...(answer === 'json' ? ['--json'] : [])], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          serverId: 'home', serverApiUrl: target.url, serverIdentityId: homeIdentityId,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } }),
      });
      if (answer === 'yes') {
        expect(target.readReceived()).toBeDefined();
        expect(terminal.prompts[0]).toContain('[y/N]');
        expect(terminal.prompts[0]).toMatch(/account/i);
        expect(terminal.prompts[0]).toMatch(/files|output|sign-ins/i);
      } else expect(target.readReceived()).toBeUndefined();
      if (answer === 'json' || answer === 'noninteractive') expect(terminal.prompts).toEqual([]);
    } finally { output.restore(); }
  });

  it.each(['missing-disclosure', 'informational-only', 'rejected-disclosure', 'changed-root', 'terminal-human-upgrade'] as const)('withholds private custody for %s', async reason => {
    const events: string[] = [];
    const target = await home('plain', events, { mutateRoot: reason === 'changed-root' });
    const disclosure = reason === 'missing-disclosure' ? {} : { onRequesterSessionCredentialDisclosure: async () => {
      events.push('disclosed');
      if (reason === 'informational-only') return;
      return reason !== 'rejected-disclosure';
    } };
    const result = await dispatchOriginalAccountAction({ actionId: 'machines.work.summary.get', input: { serverId: 'home', machineId: 'alice-machine' },
      requestId: 'request-1', target: { kind: 'machine', machineId: 'alice-machine' }, credentials: { token: token(reason === 'terminal-human-upgrade' ? 'terminal' : 'account'), encryption: null },
      serverHttpBaseUrl: target.url, serverIdentityId: homeIdentityId, ...disclosure });
    expect(result.ok).toBe(false);
    expect(target.readReceived()).toBeUndefined();
  });
});
