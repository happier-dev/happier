import { describe, expect, it, vi } from 'vitest';
import { createHappierMcpToolNamingResolver } from '../../../../../../../apps/cli/src/mcp/runtime/projectMcpToolNames';

import {
  buildOpenCodeSessionMcpProjection,
  canonicalizeOpenCodeProjectedMcpToolName,
  disconnectOpenCodeMcpServers,
  registerOpenCodeMcpServers,
  resolveOpenCodeProjectedMcpToolName,
} from './mcpRegistration.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerTransport } from './transport.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { OpenCodeServerUnsupportedOperationError } from './openCodeServerClient.js';

function createRegistrationHarness() {
  const debug = vi.fn();
  const warn = vi.fn();
  const mcpAdd = vi.fn<OpenCodeServerClient['mcpAdd']>(async () => ({ status: 'connected' }));
  return {
    ctx: {
      logger: { debug, warn },
    } as unknown as OpenCodeRuntimeContext,
    client: { mcpAdd } as unknown as OpenCodeServerClient,
    debug,
    warn,
    mcpAdd,
  };
}

function projected(server: string, identity = 'happier-session-1') {
  return buildOpenCodeSessionMcpProjection(identity, { [server]: { command: '/fixture' } }).registrations[0]!.projectedName;
}

function projection(mcpServers: unknown) {
  return buildOpenCodeSessionMcpProjection('happier-session-1', mcpServers);
}

describe('registerOpenCodeMcpServers', () => {
  it('retains sanitized V2 HTTP refusal fields through projection, transport and registration', async () => {
    const harness = createRegistrationHarness();
    const transport = createOpenCodeServerTransport({ managedService: { request: async input => {
      expect(input.method).toBe('PUT');
      expect(input.pathAndQuery).toContain('/api/experimental/mcp/');
      const body = JSON.parse(new TextDecoder().decode(input.body));
      expect(body.config.command).toEqual(['/fixture']);
      return { ok: false, status: 400, statusText: 'Bad Request', headers: {},
        body: new Response('invalid MCP config; Authorization: Bearer diagnostic-secret').body };
    } } });
    const result = await registerOpenCodeMcpServers({ ctx: harness.ctx,
      client: createOpenCodeServerClient({ transport, dialect: 'v2' }),
      directory: '/repo', mcpProjection: projection({ happier: { command: '/fixture' } }),
    });
    expect(result.requiredHappier.status).toBe('failed');
    const fields = JSON.parse(JSON.stringify(harness.debug.mock.calls.at(-1)?.[1]));
    expect(fields.error).toMatchObject({ name: 'OpenCodeServerHttpError',
      code: 'opencode_server_request_failed', operation: 'mcp_registration', status: 400,
      message: expect.stringContaining('invalid MCP config') });
    expect(JSON.stringify(fields)).not.toContain('diagnostic-secret');
    expect(fields.error).not.toHaveProperty('stack');
  });

  it('keeps unchanged names independent of a later unavailable alias inventory', async () => {
    let available = true;
    const resolve = createHappierMcpToolNamingResolver({ command: '/fixture' }, async () => {
      if (!available) throw new Error('inventory unavailable');
      return ['change_title', 'plugin_' + 'long_'.repeat(12)];
    });
    const naming = (await resolve({ serverName: 'happier', toolNameMaxLength: 40 }))!;
    const projected = buildOpenCodeSessionMcpProjection('session-a', { happier: { command: '/fixture' } }, resolve, naming.aliasPrefix);
    const server = projected.registrations[0]!.projectedName;
    available = false;
    expect(resolveOpenCodeProjectedMcpToolName(`${server}_change_title`, projected)).toBe('mcp__happier__change_title');
  });

  it('resolves transport aliases through the current host inventory without retaining removed identity', async () => {
    const original = 'plugin_' + 'long_name_'.repeat(9);
    let names = ['change_title', original];
    const resolve = createHappierMcpToolNamingResolver({ command: '/fixture' }, async () => names);
    const server = buildOpenCodeSessionMcpProjection('session-a', { happier: { command: '/fixture' } }).registrations[0]!.projectedName;
    const initial = (await resolve({ serverName: 'happier', toolNameMaxLength: 64 - server.length - 1 }))!;
    const projection = buildOpenCodeSessionMcpProjection('session-a', { happier: { command: '/fixture' } }, resolve, initial.aliasPrefix);
    const alias = initial.tools.find(tool => tool.originalName === original)!.projectedName;
    expect(`${server}_${alias}`.length).toBeLessThanOrEqual(64);
    await expect(resolveOpenCodeProjectedMcpToolName(`${server}_${alias}`, projection)).resolves.toBe(`mcp__happier__${original}`);
    names = ['change_title', 'refreshed_' + 'tool_'.repeat(16)];
    const current = (await resolve({ serverName: 'happier', toolNameMaxLength: 64 - server.length - 1 }))!;
    const added = current.tools[1]!;
    await expect(resolveOpenCodeProjectedMcpToolName(`${server}_${added.projectedName}`, projection)).resolves.toBe(`mcp__happier__${added.originalName}`);
    await expect(resolveOpenCodeProjectedMcpToolName(`${server}_${alias}`, projection)).resolves.toBe(`${server}_${alias}`);
    expect(resolveOpenCodeProjectedMcpToolName(`${server}_change_title`, projection)).toBe('mcp__happier__change_title');
  });

  it('reserves model-name room while keeping the session isolation prefix', () => {
    const result = buildOpenCodeSessionMcpProjection('a'.repeat(25), { happier: { command: '/fixture' } });
    const name = result.registrations[0]!.projectedName;
    expect(`${name}_${'t'.repeat(40)}`.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^happier-session-/);
  });

  it('uses the longest projected alias while preserving original server and known tool names', () => {
    const result = buildOpenCodeSessionMcpProjection('session-a', {
      docs: { command: '/fixture' }, 'docs.team__prod': { command: '/fixture' },
    });
    const alias = result.registrations[1]!.projectedName;
    const policy = { 'docs.team__prod': { unlisted: 'ask' as const, tools: { 'file.read': 'off' as const } } };
    expect(canonicalizeOpenCodeProjectedMcpToolName(`${alias}_file_read`, result, policy)).toBe('mcp__docs.team__prod__file.read');
    expect(canonicalizeOpenCodeProjectedMcpToolName('unknown_search', result, policy)).toBe('unknown_search');
  });
  it('projects every injected server into distinct stable session namespaces', () => {
    const first = buildOpenCodeSessionMcpProjection('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const second = buildOpenCodeSessionMcpProjection('session-b', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });

    const names = [...first.registrations, ...second.registrations].map(registration => registration.projectedName);
    expect(new Set(names).size).toBe(4);
    expect(names.every(name => name.startsWith('happier-session-'))).toBe(true);
    expect(buildOpenCodeSessionMcpProjection('session-a', {
      happier: { command: '/bin/happier-mcp' }, custom: { command: '/bin/custom-mcp' },
    })).toEqual(first);
    expect(first.requiredHappierServerName).toBe(first.registrations[0]!.projectedName);
  });

  it('keeps long colliding prefixes distinct within the released V2 namespace limit', () => {
    const sharedPrefix = `custom-${'same-prefix-'.repeat(8)}`;
    const result = buildOpenCodeSessionMcpProjection('session-a', {
      [`${sharedPrefix}first`]: { command: '/bin/first' },
      [`${sharedPrefix}second`]: { command: '/bin/second' },
    });
    const names = result.registrations.map(({ projectedName }) => projectedName);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(names.map((name) => expect.stringMatching(/^happier-session-[0-9a-z]{7}$/)));
    expect(canonicalizeOpenCodeProjectedMcpToolName(
      `${names[0]}_lookup`,
      result,
    )).toBe(`mcp__${sharedPrefix}first__lookup`);
  });

  it('awaits in-flight registration and removes only successfully registered name-directory pairs', async () => {
    const harness = createRegistrationHarness();
    const mcpRemove = vi.fn(async () => undefined);
    let resolveRegistration!: () => void;
    const registration = new Promise<Readonly<{
      requiredHappier: { status: 'ready' };
      registeredServers: readonly Readonly<{ directory: string; name: string }>[];
    }>>((resolve) => {
      resolveRegistration = () => resolve({
        requiredHappier: { status: 'ready' },
        registeredServers: [{ directory: '/repo', name: 'happier-session-session-a--happier' }],
      });
    });

    const cleanup = disconnectOpenCodeMcpServers({
      ctx: harness.ctx,
      client: { mcpRemove } as unknown as OpenCodeServerClient,
      registration,
    });
    await Promise.resolve();
    expect(mcpRemove).not.toHaveBeenCalled();

    resolveRegistration();
    await cleanup;
    expect(mcpRemove).toHaveBeenCalledWith({
      directory: '/repo',
      name: 'happier-session-session-a--happier',
    });
  });

  it('settles required Happier readiness after an earlier optional registration finishes', async () => {
    const harness = createRegistrationHarness();
    let resolveOptional!: () => void;
    harness.mcpAdd.mockImplementation(async ({ name }) => {
      if (name === projected('slow_custom')) {
        await new Promise<void>((resolve) => {
          resolveOptional = resolve;
        });
      }
      return { status: 'connected' as const };
    });

    const registration = registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        slow_custom: { command: '/bin/custom' },
        happier: { command: '/bin/happier-mcp' },
      }),
    });

    await Promise.resolve();
    expect(harness.mcpAdd).toHaveBeenCalledTimes(1);

    resolveOptional();

    await expect(registration).resolves.toEqual({
      requiredHappier: { status: 'ready' },
      registeredServers: [
        { directory: '/repo', name: projected('slow_custom') },
        { directory: '/repo', name: projected('happier') },
      ],
    });
    expect(harness.mcpAdd).toHaveBeenNthCalledWith(2, {
      directory: '/repo',
      name: projected('happier'),
      config: {
        type: 'local',
        enabled: true,
        command: ['/bin/happier-mcp'],
      },
    });
  });

  it('keeps optional failures non-fatal but reports a required Happier failure', async () => {
    const optionalFailureHarness = createRegistrationHarness();
    optionalFailureHarness.mcpAdd
      .mockResolvedValueOnce({ status: 'disabled' })
      .mockResolvedValueOnce({ status: 'connected' });

    await expect(registerOpenCodeMcpServers({
      ctx: optionalFailureHarness.ctx,
      client: optionalFailureHarness.client,
      directory: '/repo',
      mcpProjection: projection({
        optional: { command: '/bin/optional' },
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toEqual({
      requiredHappier: { status: 'ready' },
      registeredServers: [{ directory: '/repo', name: projected('happier') }],
    });

    const requiredFailureHarness = createRegistrationHarness();
    const requiredError = new Error('required add failed');
    requiredFailureHarness.mcpAdd.mockRejectedValueOnce(requiredError);

    await expect(registerOpenCodeMcpServers({
      ctx: requiredFailureHarness.ctx,
      client: requiredFailureHarness.client,
      directory: '/repo',
      mcpProjection: projection({
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toEqual({
      requiredHappier: { status: 'failed', error: requiredError },
      registeredServers: [],
    });
  });

  it('reports an HTTP-200 non-connected Happier status as a required failure', async () => {
    const harness = createRegistrationHarness();
    harness.mcpAdd.mockResolvedValueOnce({
      status: 'failed',
      error: 'bridge tools unavailable',
    } as never);

    const result = await registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        happier: { command: '/bin/happier-mcp' },
      }),
    });

    expect(result.requiredHappier).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({
        message: expect.stringMatching(/bridge tools unavailable/iu),
      }),
    });
  });

  it('separates a server that cannot take dynamic registrations from one that refused them', async () => {
    const harness = createRegistrationHarness();
    harness.mcpAdd.mockRejectedValue(new OpenCodeServerUnsupportedOperationError({
      operation: 'mcp_registration',
      dialect: 'v2',
      message: 'OpenCode V2 servers expose no dynamic MCP registration route',
    }));

    // The pinned V2 protocol declares no MCP group at all, so there is nothing
    // to fail: the capability is absent. Reporting that as `failed` would make
    // every ordinary V2 prompt fail closed on a route that never existed.
    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        optional: { command: '/bin/optional' },
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toMatchObject({
      requiredHappier: {
        status: 'unsupported',
        reason: expect.stringMatching(/dynamic MCP registration/iu),
      },
    });
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining('dynamic MCP registration'),
      expect.objectContaining({ dialect: 'v2' }),
    );
  });

  it('does not require an omitted optional Happier MCP configuration', async () => {
    const harness = createRegistrationHarness();

    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection(undefined),
    })).resolves.toMatchObject({ requiredHappier: { status: 'not_required' } });
    expect(harness.mcpAdd).not.toHaveBeenCalled();
  });

  it.each(['happier', ' happier '])('fails closed when declared MCP %j has no command', async (name) => {
    const harness = createRegistrationHarness();

    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({ [name]: {} }),
    })).resolves.toMatchObject({ requiredHappier: { status: 'failed' } });
    expect(harness.mcpAdd).not.toHaveBeenCalled();
  });
});
