import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AccountApiTokenBearerV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';

const API_TOKEN = AccountApiTokenBearerV1Schema.parse(`hap_v1_00000000-0000-4000-8000-000000000001_${'A'.repeat(43)}`);
const transportFault = vi.hoisted(() => ({ close: false }));
// Preserve real HTTP and its parser; only fail the platform transport's finalization.
vi.mock('../../../../../packages/sdk/src/http/fetchHttp', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../packages/sdk/src/http/fetchHttp')>();
  return { ...original, createHttpExchange: () => {
    const http = original.createHttpExchange();
    return { ...http, close: async () => {
      await http.close();
      if (transportFault.close) throw new Error('dependency exploded');
    } };
  } };
});

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: credentialBoundary.readStoredCredentials,
}));

import { handleMachinesCommand } from './machines';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';

// Collect the real executor graph before a behavior test starts its runner budget.
await import('@/session/actions/createCliActionExecutorFromCredentials');

function machinesListCommand() {
  const command = findCompiledActionCliCommand(['machines', 'list'], listCompiledActionCliCommands());
  if (!command) throw new Error('machines.list declares no friendly command');
  return command;
}

async function runMachinesList(rest: readonly string[]): Promise<void> {
  await runCompiledActionCliCommand({
    command: machinesListCommand(),
    argv: ['machines', 'list', ...rest],
  });
}

let app = Fastify();
let restoreHttp = () => {};
let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
const requests: Array<{ path: string; input: unknown; authorization: string | undefined }> = [];
let machineCount = 1;

beforeEach(async () => {
  transportFault.close = false;
  requests.length = 0;
  machineCount = 1;
  app = Fastify();
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/machines', async request => {
    requests.push({ path: request.url, input: request.query, authorization: request.headers.authorization });
    const pat = request.headers.authorization === `Bearer ${API_TOKEN}`;
    return Array.from({ length: machineCount }, (_, index) => ({ id: `machine-${index + 1}`, kind: 'persistent', active: pat,
      activeAt: Date.now(), revokedAt: null, replacedByMachineId: pat ? null : 'machine-2' }));
  });
  app.post('/v1/actions/machines.list', async request => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
    requests.push({ path: request.url, input: envelope.input, authorization: request.headers.authorization });
    return ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.list', requestId: envelope.requestId,
      execution: { ok: true, result: { items: [{ id: 'machine-1', active: true, revokedAt: null, replacedByMachineId: null }] } } });
  });
  envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
  envScope.patch({ HAPPIER_SERVER_URL: await app.listen({ host: '127.0.0.1', port: 0 }) });
  reloadConfiguration();
  restoreHttp = installAxiosFastifyAdapter({ app, origin: configuration.apiServerUrl });
  credentialBoundary.readStoredCredentials.mockReset();
});

afterEach(async () => {
  transportFault.close = false;
  restoreHttp();
  await app.close();
  envScope.restore();
  reloadConfiguration();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('machines list through the canonical Action', () => {
  it('shows the compiled help without reading credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMachinesList(['--help']);

    expect(credentialBoundary.readStoredCredentials).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('happier machines list');
    expect(process.exitCode).toBeUndefined();
  });

  it('invokes machines.list without an implicit projection and preserves the released output', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue({
      token: API_TOKEN, encryption: null, credentialProvenance: 'api_token',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMachinesList([]);

    expect(credentialBoundary.readStoredCredentials).toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('machine-1');
    expect(requests).toContainEqual({ path: '/v1/actions/machines.list', input: {}, authorization: `Bearer ${API_TOKEN}` });
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the released machines_list JSON envelope', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue({ token: 'token', encryption: null });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as never);

    await runMachinesList(['--json']);

    expect(JSON.parse(output)).toMatchObject({
      v: 1,
      ok: true,
      kind: 'machines_list',
      data: { machines: [{ id: 'machine-1', active: false, replacedByMachineId: 'machine-2' }] },
    });
    expect(requests).toContainEqual({ path: '/v1/machines', input: {}, authorization: 'Bearer token' });
  });

  it.each([
    { args: [], count: 202 },
    { args: ['--limit', '201'], count: 201 },
    { args: ['--limit', '2'], count: 2 },
  ])('lists $count Machines through canonical discovery with $args', async ({ args, count }) => {
    machineCount = 202;
    credentialBoundary.readStoredCredentials.mockResolvedValue({ token: 'token', encryption: null });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as never);

    await runMachinesList([...args, '--json']);
    const envelope = JSON.parse(output);
    expect(envelope).toMatchObject({ ok: true, kind: 'machines_list' });
    expect(envelope.data.machines).toHaveLength(count);
  });

  it('rejects an unknown option before reading credentials', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as never);

    await runMachinesList(['--bogus', '--json']);

    expect(JSON.parse(output)).toMatchObject({
      v: 1, ok: false, kind: 'machines_list', error: { code: 'invalid_arguments' },
    });
    expect(credentialBoundary.readStoredCredentials).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('classifies an unexpected execution transport exception as exit 2', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue({ token: API_TOKEN, encryption: null, credentialProvenance: 'api_token' });
    // HTTP transport is the system boundary. Close the real HTTP transport before
    // reporting its failure; exercise the execution catch, not credential lookup.
    transportFault.close = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runMachinesList([]);

    expect(process.exitCode).toBe(2);
    expect(requests).toContainEqual({ path: '/v1/actions/machines.list', input: {}, authorization: `Bearer ${API_TOKEN}` });
  });
});

describe('machines root command', () => {
  it('shows help with no subcommand, listing every compiled leaf under this root', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleMachinesCommand([]);
    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('happier machines list');
    // Machine Pool administration is compiled from the Action catalog; family
    // help must document what dispatch and completion already accept.
    for (const verb of ['create', 'get', 'list', 'update', 'delete', 'resolve']) {
      expect(help).toContain(`happier machines pools ${verb}`);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an unknown subcommand as a stable JSON envelope', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as never);
    await handleMachinesCommand(['bogus', '--json']);
    expect(JSON.parse(output)).toMatchObject({
      v: 1, ok: false, kind: 'machines_list', error: { code: 'unknown_subcommand' },
    });
    expect(process.exitCode).toBe(1);
  });
});
