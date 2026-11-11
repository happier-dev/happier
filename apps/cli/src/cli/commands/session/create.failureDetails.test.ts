import { createServer } from 'node:http';

import { expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureConsoleJsonOutput, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { configuration } from '@/configuration';

import { cmdSessionCreate } from './create';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { ConnectedServicesDefaultUnavailableError } from '@/session/services/spawnConnectedServicesDefaults';

it.each(['cs:explicit-account', 'cs:group:explicit-pool'])(
  'spawns with explicit %s without consulting Account defaults', async auth => {
    const service = 'happier.agent.claude/claude-subscription';
    let selected: unknown;
    let inventoryReads = 0;
    // Public Action HTTP only: real CLI parsing, Action input and auth resolution.
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const { requestId, input } = JSON.parse(body) as { requestId?: string; input?: Record<string, unknown> };
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/v1/actions/sessions.spawn.connected_services.list') {
        inventoryReads += 1;
        const refusal = new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
        response.end(JSON.stringify({ v: 1, actionId: 'sessions.spawn.connected_services.list', requestId,
          execution: input?.includeDefaults === false ? { ok: true, result: {
            profileOptionsByServiceId: { [service]: [{ profileId: 'explicit-account', status: 'connected' }] },
            groupOptionsByServiceId: { [service]: [{ groupId: 'explicit-pool' }] },
          } } : { ok: false, errorCode: refusal.code, error: refusal.message, details: refusal.details } }));
        return;
      }
      selected = input?.connectedServices;
      response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new', requestId, execution: { ok: true, result: {
        type: 'success', sessionId: 'explicit-auth-session', disposition: 'created',
        executionTarget: { serverId: configuration.activeServerId, machineId: 'explicit-machine' },
        organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
      } } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected Action endpoint');
    const url = `http://127.0.0.1:${address.port}`;
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await withConfiguredDaemonTestHome({ prefix: 'session-explicit-auth-',
        env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
        const output = captureStdoutJsonOutput();
        try {
          await cmdSessionCreate(['--machine-id', 'explicit-machine', '--path', '/tmp/explicit-auth',
            '--agent', 'claude', '--auth', auth, '--json'], { readCredentialsFn: async () => ({
              token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43), encryption: null,
              credentialProvenance: 'api_token',
            }) });
          expect(output.json()).toMatchObject({ ok: true, data: { session: { id: 'explicit-auth-session' } } });
          expect(selected).toMatchObject({ v: 2, bindingsByServiceId: { [service]: auth === 'cs:explicit-account'
            ? { source: 'connected', selection: 'profile', profileId: 'explicit-account' }
            : { source: 'connected', selection: 'group', groupId: 'explicit-pool' } } });
          expect(inventoryReads).toBe(1);
        } finally { output.restore(); }
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      process.exitCode = previousExitCode;
    }
  },
);

it('identifies Account purpose catalog unavailability in the exact FIN reload80 pool recipe', async () => {
  const refusal = new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
  const requests: string[] = [];
  // Only public Action HTTP is substituted. The canonical refusal producer,
  // auth parser, SDK transport and CLI error presenters remain real.
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { requestId } = JSON.parse(body) as { requestId?: string };
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/actions/session.spawn_new') {
      response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new', requestId,
        execution: { ok: true, result: { type: 'success', sessionId: 'fin-reload80-fixture', disposition: 'created',
          executionTarget: { serverId: configuration.activeServerId, machineId: '4af70cb8-88bb-4f41-86d7-94455e4f7e29' },
          organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } } }));
      return;
    }
    response.end(JSON.stringify({ v: 1, actionId: 'sessions.spawn.connected_services.list', requestId,
      execution: { ok: false, errorCode: refusal.code, error: refusal.message, details: refusal.details } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Action endpoint');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await withConfiguredDaemonTestHome({ prefix: 'session-create-fin-reload80-',
      env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const argv = ['--path', '/tmp/forge-qa-pr54-20261024',
        '--machine-id', '4af70cb8-88bb-4f41-86d7-94455e4f7e29', '--agent', 'codex',
        '--model', 'gpt-6-luna', '--reasoning-effort', 'low', '--permission-mode', 'read-only',
        '--auth', 'cs:group:codex-pool', '--spawn-attempt-id', '1a0de878-0af4-43b9-b74b-c400f519ddc5',
        '--title', 'CH-QA-NONMAC PR54 1a0de878-0af4-43b9-b74b-c400f519ddc5'];
      const deps = { readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null, credentialProvenance: 'api_token' as const,
      }) };
      const expected = { code: 'connected_services_default_unavailable', details: {
        v: 1, source: 'account_default', reason: 'connected_account_purpose_catalog_unavailable', phase: 'purpose_binding',
      } };
      const output = captureStdoutJsonOutput();
      try {
        await cmdSessionCreate([...argv, '--json'], deps);
        expect(output.json()).toMatchObject({ ok: false, kind: 'session_create', error: expected });
        expect(process.exitCode).toBe(1);
        await expect(cmdSessionCreate(argv, deps)).rejects.toMatchObject(expected);
        process.exitCode = undefined;
        output.chunks.length = 0;
        await cmdSessionCreate([...argv.map(value => value === 'cs:group:codex-pool'
          ? 'cs:happier.agent.codex/openai-codex:group:codex-pool' : value), '--json'], deps);
        expect(output.json()).toMatchObject({ ok: true, kind: 'session_create',
          data: { session: { id: 'fin-reload80-fixture' } } });
        expect(requests).toEqual(['POST /v1/actions/sessions.spawn.connected_services.list',
          'POST /v1/actions/sessions.spawn.connected_services.list', 'POST /v1/actions/session.spawn_new']);
      } finally { output.restore(); }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});

it('names the mismatched serverId and allowed profile in the P0-DATA recipe refusal', async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await withConfiguredDaemonTestHome({ prefix: 'session-create-server-id-' }, async () => {
      const output = captureStdoutJsonOutput();
      try {
        const argv = [
          'create', '--path', '/tmp/forge-qa-pr54-20261024', '--agent', 'codex',
          '--model', 'gpt-5.6-luna', '--reasoning-effort', 'low',
          '--permission-mode', 'read-only', '--auth', 'default',
          '--machine-id', '3ca2700f-c0a8-440f-be06-cb4f3f51cb01',
          '--server-id', 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
          '--title', 'P0-DATA — Investigate checkout recovery',
        ];
        const deps = { readCredentialsFn: async () => ({
          token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
          encryption: null, credentialProvenance: 'api_token' as const,
        }) };
        await cmdSessionCreate([...argv, '--json'], deps);
        expect(output.json()).toMatchObject({ ok: false, kind: 'session_create',
          error: { code: 'invalid_arguments', details: {
            field: 'serverId', allowedValues: [configuration.activeServerId],
          } } });
        expect(process.exitCode).toBe(1);
        await expect(cmdSessionCreate(argv, deps)).rejects.toMatchObject({
          code: 'invalid_arguments', details: {
            field: 'serverId', allowedValues: [configuration.activeServerId],
          },
        });
      } finally { output.restore(); }
    });
  } finally { process.exitCode = previousExitCode; }
});

it.each([
  { machineIds: [], explicit: false },
  { machineIds: ['offline-machine'], explicit: false },
  { machineIds: ['offline-machine'], explicit: true },
])('prints the typed no-active-Machine refusal and exits 1 for inventory $machineIds (explicit: $explicit)', async ({ machineIds, explicit }) => {
  const requests: string[] = [];
  // Only Home HTTP is substituted; CLI selection, Action placement and output stay real.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/machines') {
      response.end(JSON.stringify(machineIds.map(id => ({ id, active: false, kind: 'persistent',
        revokedAt: null, replacedByMachineId: null,
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'owner', displayName: 'Owner' },
          role: 'manage', resourceMode: 'plain', accessState: 'ready' }) }))));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/account/encryption') {
      response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture Home');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await withConfiguredDaemonTestHome({ prefix: 'session-create-offline-cli-',
      env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
      const output = captureStdoutJsonOutput();
      try {
        await cmdSessionCreate(['--path', '/tmp', '--json', ...(explicit ? ['--machine-id', 'offline-machine'] : [])], {
          readCredentialsFn: async () => ({ token, encryption: null, credentialProvenance: 'stored_session' }),
        });
        expect(output.json()).toMatchObject({ v: 1, ok: false, kind: 'session_create',
          error: { code: 'machine_offline', details: explicit ? { machineId: 'offline-machine' } : { machineIds } } });
        expect(process.exitCode).toBe(1);
        expect(requests.filter(request => request.startsWith('POST '))).toEqual([]);
      } finally { output.restore(); }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});

it.each(['provider', 'agent_signed_out', 'child_exit'] as const)('preserves the typed %s cause through public Action transport and JSON or thrown Session-create errors', async (kind) => {
  const providerError = createProviderErrorV1('provider_endpoint_unavailable', {
    connectionId: 'pc_gateway', machineId: 'machine-a',
  });
  const result = kind === 'provider'
    ? SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed',
        retryable: providerError.retryable, providerError })
    : kind === 'child_exit'
      ? SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
          errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Child process exited (code=1, signal=null); module_not_found: nacl-fast.js',
          errorDetail: { kind: 'launch_error', code: 'CHILD_EXITED_BEFORE_WEBHOOK',
            message: 'Child process exited (code=1, signal=null); module_not_found: nacl-fast.js',
            childExit: { code: 1, signal: null, cause: { kind: 'module_not_found', specifierBasename: 'nacl-fast.js' } } },
        }))
    : SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'agent_signed_out',
        errorMessage: 'upstream-private-auth-diagnostic', agentId: 'custom-agent' }));
  const requests: string[] = [];
  // Only the remote public Action HTTP boundary is substituted. The result uses
  // its canonical schema; the SDK client and CLI strict consumer stay real.
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { requestId } = JSON.parse(body) as { requestId?: string };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new', requestId,
      execution: { ok: true, result } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Action endpoint');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    await withConfiguredDaemonTestHome({ prefix: 'session-create-cause-',
      env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const deps = { readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null, credentialProvenance: 'api_token' as const,
      }) };
      const argv = ['--machine-id', 'machine-a', '--path', '/tmp'];
      const output = captureConsoleJsonOutput();
      try {
        await cmdSessionCreate([...argv, '--json'], deps);
        const expected = kind === 'child_exit' ? { code: 'spawn_failed', launchError: {
            code: 'CHILD_EXITED_BEFORE_WEBHOOK', childExit: { code: 1, signal: null },
          } }
          : kind === 'provider' ? { code: 'spawn_failed', retryable: true, providerError }
          : { code: 'agent_signed_out', agentId: 'custom-agent', launchError: {
              kind: 'launch_error', code: 'agent_signed_out',
              message: expect.stringMatching(/select.*connected account profile.*configure.*default profile/i),
            } };
        expect.soft(output.json()).toMatchObject({ ok: false, kind: 'session_create', error: expected });
        await expect(cmdSessionCreate(argv, deps)).rejects.toMatchObject({ ...expected,
          ...(kind === 'agent_signed_out' ? {
            message: expect.stringMatching(/select.*connected account profile.*configure.*default profile/i),
          } : kind === 'child_exit' ? { message: expect.stringContaining('module_not_found: nacl-fast.js') } : {}),
        });
        expect(requests).toEqual(['POST /v1/actions/session.spawn_new', 'POST /v1/actions/session.spawn_new']);
      } finally { output.restore(); }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});
