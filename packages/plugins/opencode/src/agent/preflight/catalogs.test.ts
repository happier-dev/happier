import { describe, expect, it } from 'vitest';
import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedServiceRequest, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from './models.js';

function fixture(options: Readonly<{ generation?: string; version?: string; versionOk?: boolean; failSkills?: boolean }> = {}) {
  const requests: ManagedServiceRequest[] = [];
  const services: ManagedServiceSpec[] = [];
  let disposed = false;
  let ready = false;
  const context: AgentPreflightSessionControlsProbeContextV1 = {
    cwd: '/repo', accountSettings: { opencodeCliGeneration: options.generation ?? 'stable' },
    environment: {}, signal: new AbortController().signal,
    resolveDeclaredSystemTool: async () => ({ executablePath: '/usr/local/bin/opencode' }),
    runDeclaredSystemToolCommand: async () => ({ ok: options.versionOk ?? true, stdout: options.version ?? '1.18.33', stderr: '', exitCode: 0 }),
    probeDeclaredAcpCatalogs: async () => ({ commands: [{ name: 'acp-only' }], skills: null }),
    withDeclaredJsonRpcClient: async () => { throw new Error('JSON-RPC is not the native server boundary'); },
    withDeclaredManagedService: async (spec, inspect) => {
      services.push(spec);
      try {
        return await inspect({ request: async (request) => {
          requests.push(request);
          const route = new URL(request.pathAndQuery, 'http://opencode.invalid');
          const v2 = route.pathname.startsWith('/api/');
          if (v2) expect(route.searchParams.get('location[directory]')).toBe(context.cwd);
          if (route.pathname === '/api/integration') {
            ready = true;
            return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify({ data: [] })).body };
          }
          if (options.failSkills && route.pathname.endsWith('/skill')) throw new Error('skill transport failed');
          const items = route.pathname.endsWith('/command')
            ? [{ name: 'review', description: 'Review project', template: 'native template' }]
            : [{ ...(v2 ? { id: 'native-project-skill' } : {}), name: 'project-skill', description: 'Use project skill', location: '/repo/.opencode/skills/project-skill/SKILL.md' }];
          const value = v2 ? { data: ready ? items : [] } : items;
          return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(value)).body };
        } }, context.signal);
      } finally { disposed = true; }
    },
  };
  return { context, requests, services, disposed: () => disposed };
}

async function probe(context: AgentPreflightSessionControlsProbeContextV1) {
  const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
  if (!contribution.probeCatalogs) throw new Error('OpenCode has no native preflight catalog owner');
  return await contribution.probeCatalogs(context);
}

describe('OpenCode before-session native catalogs', () => {
  it('reads project-scoped V1 commands and skills through the managed native client without creating a session', async () => {
    const f = fixture();
    await expect(probe(f.context)).resolves.toEqual({
      commands: [{ name: 'review', description: 'Review project', template: 'native template' }],
      skills: [{ name: 'project-skill', displayName: 'project-skill', description: 'Use project skill', path: '/repo/.opencode/skills/project-skill/SKILL.md', origin: 'opencode_native', enabled: true }],
    });
    expect(f.requests.map((r) => [r.method, r.pathAndQuery])).toEqual([
      ['GET', '/command?directory=%2Frepo'], ['GET', '/skill?directory=%2Frepo'],
    ]);
    expect(f.services[0]?.mode).toMatchObject({ kind: 'spawn', launch: { executable: { kind: 'systemTool', id: 'opencode-cli-stable' }, args: ['serve', '--hostname', '127.0.0.1'] } });
    expect(f.disposed()).toBe(true);
  });

  it.each([{ generation: 'v2', version: '2.0.20' }, { generation: 'stable', version: 'opencode v2.0.20' }])('reads cold V2 catalogs even when stable resolves to V2 ($generation)', async (selection) => {
    const f = fixture(selection);
    await expect(probe(f.context)).resolves.toEqual({
      commands: [{ name: 'review', description: 'Review project', template: 'native template' }],
      skills: [{ id: 'native-project-skill', name: 'project-skill', displayName: 'project-skill', description: 'Use project skill', path: '/repo/.opencode/skills/project-skill/SKILL.md', origin: 'opencode_native', enabled: true }],
    });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.requests.some((request) => request.pathAndQuery.startsWith('/api/session'))).toBe(false);
    expect(f.disposed()).toBe(true);
  });

  it.each([{ versionOk: false, version: '' }, { versionOk: true, version: 'unrecognized CLI output' }])('rejects an unproven native generation before opening catalog routes', async (observation) => {
    const f = fixture(observation);
    await expect(probe(f.context)).rejects.toThrow('native generation is unavailable');
    expect(f.services).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('propagates a native catalog failure through the scoped service owner', async () => {
    const f = fixture({ failSkills: true });
    await expect(probe(f.context)).rejects.toThrow('skill transport failed');
    expect(f.disposed()).toBe(true);
  });

  it('uses the canonical declared ACP catalogs for an ACP selection', async () => {
    const f = fixture();
    const context = { ...f.context, accountSettings: { opencodeBackendMode: 'acp' } };
    await expect(probe(context)).resolves.toEqual({ commands: [{ name: 'acp-only' }], skills: null });
    expect(f.services).toEqual([]);
  });
});
