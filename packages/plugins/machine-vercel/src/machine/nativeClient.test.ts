import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { createVercelNativeClient } from './nativeClient.js';
import { MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { RECONCILIATION, reference, VercelOperationSchema, type VercelOperation } from './schemas.js';

const scope = { teamId: 'team_one', projectId: 'prj_one' };
const launch = { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 };
const resource = { ...scope, name: 'happier-managed-1', managedId: 'managed-1', createdAt: 1000 };
const session = { id: 'sbx_one', sourceSandboxName: resource.name, projectId: scope.projectId, createdAt: 1000,
  requestedAt: 1000, updatedAt: 1000, cwd: '/vercel/sandbox', memory: 4096, region: 'iad1', runtime: 'image',
  status: 'running', timeout: 300000, vcpus: 2, networkPolicy: { mode: 'allow-all' } };
function named(status = 'running') { return { name: resource.name, createdAt: 1000, updatedAt: 1000, statusUpdatedAt: 1000,
  currentSessionId: session.id, currentSnapshotId: status === 'stopped' ? 'snap_one' : undefined,
  persistent: true, status, tags: { 'happier-managed-id': resource.managedId }, architecture: 'amd64',
  expiresAt: status === 'running' ? 301000 : undefined, snapshotExpiration: 0, networkPolicy: { mode: 'allow-all' } }; }
function fixture(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>, signal?: AbortSignal) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => { const parsed = new URL(String(url)); calls.push({ url: parsed, init }); return handler(parsed, init); };
  return { client: createVercelNativeClient(scope, fetcher, signal, 2000), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const snapshot = { id: 'snap_one', sourceSessionId: session.id, status: 'created', createdAt: 2000, lastUsedAt: 2000, sizeBytes: 1000, updatedAt: 2000 };
const emptyPage = { snapshots: [], pagination: { count: 0, next: null } };
const command = { id: 'cmd_one', sessionId: session.id, exitCode: null, args: ['-c', 'cat > /payload'],
  cwd: '/vercel/sandbox', name: 'sh', startedAt: 2000 };
// Current Gateway Anthropic endpoint/transport; the leaf consumes descriptors,
// while the parent composed test derives these from the real Provider owner.
const credentialBinding = (bindingKey = 'binding-a') => ({ bindingKey, destination: 'https://ai-gateway.vercel.sh/claude-code',
  requests: [{ path: '/claude-code/v1/messages', methods: ['POST'] }], placeholder: { header: 'authorization', value: 'Bearer placeholder-' + bindingKey },
  attributionHeaders: [{ name: 'x-happier-attribution', value: bindingKey }] });
const credentialInput = (bindings = [credentialBinding()]) => ({ resource: reference({ ...resource }), baseline: { kind: 'allow-all' as const }, bindings });
const materializeHeaders = async ({ bindingKey }: { bindingKey: string }) => ({ ok: true as const,
  headers: { authorization: 'Bearer private-upstream-' + bindingKey, host: 'wrong-host.invalid' } });

describe('Vercel native credential replacement', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createVercelNativeClient(scope, request);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it.each([401, 403])('keeps the resource HTTP %s cause before credential policy writes', async status => {
    const { client, calls } = fixture(() => json({ private: 'vendor body' }, status));
    expect(await client.applyNativeCredentials(credentialInput(), materializeHeaders)).toEqual({
      kind: 'unknown', code: 'credential_unavailable', nativeCause: { httpStatusClass: '4xx' },
    });
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
  });

  it('preserves same-host siblings, exact endpoint selectors and baseline through live then saved writes', async () => {
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'pro' } });
      if (url.pathname.endsWith('/network-policy')) return json({ session });
      if (init?.method === 'PATCH') return json({ sandbox: named() });
      return json({ sandbox: named(), session });
    });
    const codex = { ...credentialBinding('binding-b'), destination: 'https://ai-gateway.vercel.sh/codex/v1',
      requests: [{ path: '/codex/v1/responses', methods: ['POST'] }] };
    const result = await client.applyNativeCredentials(credentialInput([credentialBinding(), codex]), materializeHeaders);
    expect(result).toEqual({ kind: 'confirmed' });
    expect(calls.filter(call => call.url.pathname.startsWith('/v2/teams/'))).toHaveLength(0);
    const writes = calls.filter(call => call.init?.method !== 'GET');
    expect(writes.map(call => [call.init?.method, call.url.pathname])).toEqual([
      ['POST', '/v2/sandboxes/sessions/' + session.id + '/network-policy'], ['PATCH', '/v2/sandboxes/' + resource.name],
    ]);
    const policy = JSON.parse(String(writes[0]!.init!.body));
    expect(policy).toEqual({ allow: { '*': [], 'ai-gateway.vercel.sh': ['binding-a', 'binding-b'].map(bindingKey => ({
      match: { path: { exact: bindingKey === 'binding-a' ? '/claude-code/v1/messages' : '/codex/v1/responses' }, method: ['POST'],
        headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer placeholder-' + bindingKey } }] },
      transform: [{ headers: { authorization: 'Bearer private-upstream-' + bindingKey, host: 'ai-gateway.vercel.sh', 'x-happier-attribution': bindingKey } }],
    })) } });
    expect(JSON.parse(String(writes[1]!.init!.body))).toEqual({ networkPolicy: policy });
    expect(writes[1]!.url.searchParams.get('projectId')).toBe(scope.projectId);
    expect(writes.every(call => call.url.searchParams.get('teamId') === scope.teamId)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-upstream');
  });

  it('leaves an already-empty stopped policy unchanged without waking the resource', async () => {
    const { client, calls } = fixture((url, init) => url.pathname.startsWith('/v2/teams/')
      ? json({ id: scope.teamId, billing: { plan: 'pro' } })
      : json({ sandbox: named('stopped'), ...(init?.method === 'PATCH' ? {} : { session }) }));
    expect(await client.applyNativeCredentials(credentialInput([]), materializeHeaders)).toEqual({ kind: 'confirmed' });
    const writes = calls.filter(call => call.init?.method !== 'GET');
    expect(writes).toEqual([]);
    expect(calls.every(call => call.url.searchParams.get('resume') !== 'true')).toBe(true);
  });

  it.each(['wrong-resource', 'wrong-provisioner', 'wrong-schema', 'wrong-session', 'missing-attachment'] as const)(
    'refuses %s before any credential policy write', async refusal => {
      let opened = 0;
      const { client, calls } = fixture(url => url.pathname.startsWith('/v2/teams/')
        ? json({ id: scope.teamId, billing: { plan: 'pro' } })
        : json({ sandbox: named(), session: { ...session, projectId: refusal === 'wrong-session' ? 'prj_other' : scope.projectId } }));
      const input = credentialInput();
      if (refusal === 'wrong-resource') input.resource.value.teamId = 'team_other';
      const request = { ...input, resource: { ...input.resource,
        schemaVersion: refusal === 'wrong-schema' ? 2 : 1,
        contributionRef: refusal === 'wrong-provisioner' ? { pluginId: 'foreign.provisioner', localId: 'vercel' } : input.resource.contributionRef } };
      const result = await client.applyNativeCredentials(request, async request => {
        opened++;
        return refusal === 'missing-attachment' ? { ok: false as const, code: 'native_credential_binding_unavailable' as const } : materializeHeaders(request);
      });
      expect(result.kind).toBe('refused');
      expect(calls.filter(call => call.init?.method !== 'GET')).toEqual([]);
      expect(opened).toBe(refusal === 'missing-attachment' ? 1 : 0);
    });

  it.each(['live-failed', 'saved-failed', 'wrong-live-identity', 'wrong-saved-identity'] as const)(
    'keeps %s unconfirmed and excludes reflected vendor secrets', async failure => {
      const { client, calls } = fixture((url, init) => {
        if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'pro' } });
        if (url.pathname.endsWith('/network-policy')) return failure === 'live-failed'
          ? json({ error: 'private-upstream-binding-a' }, 500)
          : json({ session: { ...session, id: failure === 'wrong-live-identity' ? 'sbx_other' : session.id } });
        if (init?.method === 'PATCH') return failure === 'saved-failed'
          ? json({ error: 'private-upstream-binding-a' }, 403)
          : json({ sandbox: { ...named(), createdAt: failure === 'wrong-saved-identity' ? 9999 : resource.createdAt } });
        return json({ sandbox: named(), session });
      });
      const result = await client.applyNativeCredentials(credentialInput(), materializeHeaders);
      expect(result.kind).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('private-upstream');
      expect(calls.filter(call => call.init?.method === 'PATCH')).toHaveLength(failure === 'live-failed' || failure === 'wrong-live-identity' ? 0 : 1);
    });

  it.each(['live', 'saved'] as const)('refuses an unowned transform in the %s policy', async where => {
    let opened = 0;
    const foreignPolicy = { mode: 'custom', allowedDomains: ['*'], injectionRules: [{ domain: 'ai-gateway.vercel.sh',
      headerNames: ['authorization'], match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'unknown-placeholder' } }] } }] };
    const { client, calls } = fixture(url => url.pathname.startsWith('/v2/teams/')
      ? json({ id: scope.teamId, billing: { plan: 'pro' } })
      : json({ sandbox: { ...named(), networkPolicy: where === 'saved' ? foreignPolicy : named().networkPolicy },
        session: { ...session, networkPolicy: where === 'live' ? foreignPolicy : session.networkPolicy } }));
    expect(await client.applyNativeCredentials(credentialInput(), async request => {
      opened++; return materializeHeaders(request);
    })).toEqual({ kind: 'refused', code: 'vercel_policy_ownership_conflict' });
    expect(opened).toBe(0);
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
  });

  it.each(['missing-live', 'missing-saved', 'restricted'] as const)('does not assume an open owned policy for %s facts', async policy => {
    const { client, calls } = fixture(() => json({
      sandbox: { ...named(), networkPolicy: policy === 'missing-saved' ? undefined
        : policy === 'restricted' ? { mode: 'custom', allowedDomains: ['ai-gateway.vercel.sh'] } : named().networkPolicy },
      session: { ...session, networkPolicy: policy === 'missing-live' ? undefined : session.networkPolicy },
    }));
    expect(await client.applyNativeCredentials(credentialInput(), async () => {
      throw new Error('Unknown policy ownership must refuse before materialization');
    })).toEqual(policy === 'restricted' ? { kind: 'refused', code: 'vercel_policy_ownership_conflict' }
      : { kind: 'unknown', code: 'vercel_policy_unavailable' });
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
  });

  it('removes a leftover marked rule without a retained binding row and makes a second empty apply write nothing', async () => {
    const binding = credentialBinding();
    const policy = { mode: 'custom', allowedDomains: ['*', 'ai-gateway.vercel.sh'], injectionRules: [{
      domain: 'ai-gateway.vercel.sh', headerNames: ['authorization', 'host', 'x-happier-attribution'],
      match: { path: { exact: '/claude-code/v1/messages' }, method: ['POST'],
        headers: [{ key: { exact: binding.placeholder.header }, value: { exact: binding.placeholder.value } }] },
    }] };
    let livePolicy: unknown = policy;
    let savedPolicy: unknown = policy;
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.endsWith('/network-policy')) {
        livePolicy = JSON.parse(String(init?.body));
        return json({ session: { ...session, networkPolicy: livePolicy } });
      }
      if (init?.method === 'PATCH') {
        savedPolicy = JSON.parse(String(init.body)).networkPolicy;
        return json({ sandbox: { ...named(), networkPolicy: savedPolicy } });
      }
      return json({ sandbox: { ...named(), networkPolicy: savedPolicy }, session: { ...session, networkPolicy: livePolicy } });
    });
    const apply = () => client.applyNativeCredentials(credentialInput([]), async () => {
      throw new Error('Retiring material must not be opened');
    });
    expect(await apply()).toEqual({ kind: 'confirmed' });
    expect(calls.filter(call => call.init?.method !== 'GET').map(call => JSON.parse(String(call.init?.body))))
      .toEqual([{ mode: 'allow-all' }, { networkPolicy: { mode: 'allow-all' } }]);
    const afterFirst = calls.length;
    expect(await apply()).toEqual({ kind: 'confirmed' });
    expect(calls.slice(afterFirst).every(call => call.init?.method === 'GET')).toBe(true);
  });

  it.each(['neither', 'live', 'saved'] as const)('writes only the differing %s policy for an unchanged desired binding', async differing => {
    const binding = credentialBinding();
    const installed = { mode: 'custom', allowedDomains: ['ai-gateway.vercel.sh', '*'], injectionRules: [{
      domain: 'ai-gateway.vercel.sh', headerNames: ['X-Happier-Attribution', 'host', 'authorization'],
      match: { path: { exact: binding.requests[0]!.path }, method: ['POST'],
        headers: [{ key: { exact: binding.placeholder.header }, value: { exact: binding.placeholder.value } }] },
    }] };
    let opened = 0;
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.endsWith('/network-policy')) return json({ session });
      if (init?.method === 'PATCH') return json({ sandbox: named() });
      return json({ sandbox: { ...named(), networkPolicy: differing === 'saved' ? named().networkPolicy : installed },
        session: { ...session, networkPolicy: differing === 'live' ? session.networkPolicy : installed } });
    });
    expect(await client.applyNativeCredentials(credentialInput(), async request => {
      opened++; return materializeHeaders(request);
    })).toEqual({ kind: 'confirmed' });
    expect(calls.filter(call => call.init?.method !== 'GET').map(call => call.init?.method))
      .toEqual(differing === 'neither' ? [] : differing === 'live' ? ['POST'] : ['PATCH']);
    expect(opened).toBe(differing === 'neither' ? 0 : 1);
  });
});
describe('Vercel retained REST resource', () => {
  it.each(['stop', 'delete'] as const)('preserves definite %s refusals through the strict destroy result', async phase => {
    for (const status of [400, 403]) {
      const operation: VercelOperation = { kind: 'delete', resource, phase, snapshotIds: [] };
      const { client, calls } = fixture((url, init) => init?.method === 'POST' || init?.method === 'DELETE'
        ? json({ error: 'private vendor body' }, status) : json({ sandbox: named(), session }));
      expect(RECONCILIATION.destroyResult.parse(await client.destroy({ nativeOperation: operation }))).toEqual({
        kind: status === 400 ? 'refused' : 'unknown', code: status === 403 ? 'credential_unavailable' : 'vercel_http_400',
        nativeCause: { httpStatusClass: '4xx' },
      });
      expect(calls.filter(call => call.init?.method !== 'GET')).toHaveLength(1);
    }
  });

  it.each(['initial', 'after-stop', 'after-delete', 'snapshot-list', 'snapshot-cleanup'] as const)(
    'does not accept a failed %s Delete read as acknowledged cleanup', async stage => {
      const phase = stage === 'after-delete' || stage === 'snapshot-cleanup' ? 'delete' : 'stop';
      const operation: VercelOperation = { kind: 'delete', resource, phase, snapshotIds: stage === 'snapshot-cleanup' ? [snapshot.id] : [] };
      let effect = false;
      const { client } = fixture((url, init) => {
        if (init?.method !== 'GET') { effect = true; return json({}); }
        if (stage === 'initial' || stage === 'after-stop' && effect || stage === 'after-delete' && effect
          || stage === 'snapshot-list' && url.pathname === '/v2/sandboxes/snapshots'
          || stage === 'snapshot-cleanup' && url.pathname.includes('/snapshots/')) return json({ private: 'vendor body' }, 503);
        return stage === 'snapshot-cleanup' ? json({}, 404) : json({ sandbox: named(stage === 'snapshot-list' ? 'stopped' : 'running'), session });
      });
      expect(RECONCILIATION.destroyResult.parse(await client.destroy({ nativeOperation: operation }))).toEqual({
        kind: 'unknown', code: 'vercel_http_503', nativeCause: { httpStatusClass: '5xx' },
      });
    });

  it.each(['stop', 'delete'] as const)('retains acknowledged asynchronous %s work for the shared observer', async phase => {
    const operation: VercelOperation = { kind: 'delete', resource, phase, snapshotIds: [] };
    const { client } = fixture((_url, init) => init?.method !== 'GET' ? json({}) : json({ sandbox: named(), session }));
    expect(RECONCILIATION.destroyResult.parse(await client.destroy({ nativeOperation: operation })))
      .toEqual({ kind: 'accepted', nativeOperationRef: reference(operation) });
  });

  it.each(['read', 'stop', 'resume', 'snapshot', 'stop-readback'] as const)('preserves the native cause of a failed power %s', async stage => {
    let effect = false;
    const { client } = fixture((url, init) => {
      if (stage === 'read' || stage === 'stop' && url.pathname.endsWith('/stop')
        || stage === 'resume' && url.searchParams.get('resume') === 'true'
        || stage === 'snapshot' && url.pathname.includes('/snapshots/')
        || stage === 'stop-readback' && effect) return json({ private: 'vendor body' }, 403);
      if (init?.method !== 'GET') { effect = true; return json({}); }
      if (url.pathname.includes('/snapshots/')) return json({ snapshot });
      return json({ sandbox: named(stage === 'resume' || stage === 'snapshot' ? 'stopped' : 'running'), session });
    });
    expect(MachineProvisionerPowerResultV1Schema.parse(await client.power(resource, stage === 'stop' || stage === 'stop-readback' ? 'stop' : 'resume')))
      .toEqual({ kind: 'unknown', code: 'credential_unavailable', nativeCause: { httpStatusClass: '4xx' } });
  });

  // FIX73: guest startup is owned by shared managed power after vendor Running.
  it.each(['start', 'resume'])('confirms native %s without relying on guest execution', async intent => {
    let resumed = false;
    const { client, calls } = fixture(url => {
      if (url.pathname.endsWith('/cmd')) return json({ private: 'vendor body' }, 503);
      if (url.pathname.includes('/snapshots/')) return json({ snapshot });
      if (url.searchParams.get('resume') === 'true') resumed = true;
      return json({ sandbox: named(resumed ? 'running' : 'stopped'), session });
    });
    expect(await client.power(resource, intent)).toEqual({ kind: 'confirmed' });
    expect(await client.inspect(resource)).toMatchObject({ power: 'running', storage: 'retained' });
    expect(calls.some(call => call.url.pathname.endsWith('/cmd'))).toBe(false);
  });

  it.each(['read', 'command', 'stdin', 'wait', 'logs'] as const)('keeps %s IO failures in exec errors and file results', async stage => {
    const { client } = fixture((url, init) => {
      if (stage === 'read' && url.pathname === '/v2/sandboxes/' + resource.name
        || stage === 'command' && url.pathname.endsWith('/cmd')
        || stage === 'stdin' && url.pathname.endsWith('/stdin')
        || stage === 'wait' && url.pathname.endsWith('/cmd/cmd_one')
        || stage === 'logs' && url.pathname.endsWith('/logs')) return json({ private: 'vendor body' }, 403);
      if (url.pathname.endsWith('/stdin')) return json({ command });
      if (url.pathname.endsWith('/cmd') || url.pathname.endsWith('/cmd/cmd_one')) return json({ command: { ...command, exitCode: init?.method === 'POST' ? null : 0 } });
      if (url.pathname.endsWith('/logs')) return new Response('');
      return json({ sandbox: named(), session });
    });
    await expect(client.exec({ resource, argv: ['cat'], inputBase64: 'YQ==' })).rejects.toMatchObject({
      name: 'PluginError', code: 'credential_unavailable', details: { nativeCause: { httpStatusClass: '4xx' } },
    });
    expect(MachineProvisionerPowerResultV1Schema.parse(await client.putFile({ resource, guestPath: '/payload', bytesBase64: 'YQ==' })))
      .toEqual({ kind: 'unknown', code: 'credential_unavailable', nativeCause: { httpStatusClass: '4xx' } });
  });

  it('preserves binary stdin and UTF-8 output through the native exec role', async () => {
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.endsWith('/stdin')) return json({ command, bytesWritten: 3 });
      if (url.pathname.endsWith('/cmd') || url.pathname.endsWith('/cmd/cmd_one')) {
        return json({ command: { ...command, exitCode: init?.method === 'POST' ? null : 0 } });
      }
      if (url.pathname.endsWith('/logs')) return new Response([
        JSON.stringify({ stream: 'stdout', data: '雪' }),
        JSON.stringify({ stream: 'stdout', data: '😀\u0000' }),
        JSON.stringify({ stream: 'stderr', data: 'é' }),
      ].join('\n'));
      return json({ sandbox: named(), session });
    });
    expect(await client.exec({ resource, argv: ['cat'], inputBase64: 'AP+A' })).toEqual({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdoutBase64: '6Zuq8J+YgAA=', stderrBase64: 'w6k=', stdoutTruncated: false, stderrTruncated: false,
    });
    expect(calls.filter(call => call.url.pathname.endsWith('/stdin')).map(call => JSON.parse(String(call.init?.body))))
      .toEqual([{ data: 'AP+A', offset: 0, close: true }]);
  });

  it.each([
    { billing: { plan: 'pro' }, status: 'supported' },
    { billing: { plan: 'enterprise' }, status: 'supported' },
    { billing: { plan: 'hobby' }, status: 'supported' },
    { billing: null, status: 'unknown' },
    { billing: { plan: 'future-plan' }, status: 'unknown' },
  ])('qualifies native header delivery independently from project access (%j)', async test => {
    const { client, calls } = fixture(url => url.pathname.startsWith('/v9/projects/')
      ? json({ id: scope.projectId }) : json({ id: scope.teamId, billing: test.billing }));
    expect(await client.check()).toMatchObject({ available: true, nativeCredentialDelivery: { status: test.status } });
    expect(calls.map(call => call.url.pathname)).toEqual(['/v9/projects/' + scope.projectId, '/v2/teams/' + scope.teamId]);
  });

  it.each([401, 403])('keeps native qualification unknown after a denied Team read (%i)', async status => {
    const { client } = fixture(url => url.pathname.startsWith('/v9/projects/')
      ? json({ id: scope.projectId }) : json({ private: 'vendor response must not escape' }, status));
    expect(await client.check()).toMatchObject({ available: true, nativeCredentialDelivery: { status: 'unknown' } });
  });

  it('refuses to qualify a different Team as native support', async () => {
    const { client } = fixture(url => url.pathname.startsWith('/v9/projects/')
      ? json({ id: scope.projectId }) : json({ id: 'team_other', billing: { plan: 'pro' } }));
    expect(await client.check()).toMatchObject({ available: true, nativeCredentialDelivery: { status: 'unknown' } });
  });

  // Official SDK writesessioncommandstdinop.ts, read 2026-10-27: a successful write
  // returns the command; bytesWritten is optional. Offsets still identify every fragment.
  it.each([
    { response: { command }, confirmed: true },
    { response: { command: { ...command, exitCode: 0 }, bytesWritten: 3 }, confirmed: true },
    { response: { command: { ...command, id: 'cmd_other' }, bytesWritten: 3 }, confirmed: false },
    { response: { command: { ...command, sessionId: 'sbx_other' }, bytesWritten: 3 }, confirmed: false },
    { response: { command, bytesWritten: 2 }, confirmed: false },
    { response: { bytesWritten: 3 }, confirmed: false },
  ])('confirms stdin by the matching command and optional cumulative counter (%j)', async test => {
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.endsWith('/stdin')) return json(test.response);
      if (url.pathname.endsWith('/cmd') || url.pathname.endsWith('/cmd/cmd_one')) {
        return json({ command: { ...command, exitCode: init?.method === 'POST' ? null : 0 } });
      }
      if (url.pathname.endsWith('/logs')) return new Response('');
      return json({ sandbox: named(), session });
    });
    const result = client.putFile({ resource, guestPath: '/payload', bytesBase64: Buffer.from([0, 255, 128]).toString('base64') });
    if (test.confirmed) await expect(result).resolves.toEqual({ kind: 'confirmed' });
    else await expect(result).resolves.toEqual({ kind: 'unknown', code: 'vercel_stdin_unconfirmed' });
    const writes = calls.filter(call => call.url.pathname.endsWith('/stdin'));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]!.init!.body))).toEqual({ data: 'AP+A', offset: 0, close: true });
  });

  it.each([400, 401, 403, 422])('reports definite REST create refusal %i without inventing uncertain paid custody', async status => {
    const { client } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (init?.method === 'POST') return json({ error: { message: 'private vendor body' } }, status);
      return json({}, 404);
    });
    expect(await client.acquire(launch, resource.managedId)).toEqual({ kind: 'rejected',
      code: status === 401 || status === 403 ? 'credential_unavailable' : 'invalid_request',
      nativeCause: { httpStatusClass: '4xx' } });
  });

  it('reports a native plan lookup refusal without disclosing its response body', async () => {
    const { client, calls } = fixture(() => json({ error: { code: 'private-token', message: 'private vendor body' } }, 403));
    expect(await client.acquire(launch, resource.managedId)).toEqual({ kind: 'rejected', code: 'credential_unavailable',
      nativeCause: { httpStatusClass: '4xx' } });
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  });

  it('does not classify cancellation before native IO as provider unavailability', async () => {
    const controller = new AbortController(); controller.abort();
    const { client, calls } = fixture(() => { throw new Error('no HTTP'); }, controller.signal);
    await expect(client.acquire(launch, resource.managedId)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('retains cost custody when missing native metadata cannot qualify surviving snapshots', async () => {
    const { client, calls } = fixture(url => url.pathname === '/v2/sandboxes/snapshots'
      ? json({ snapshots: [snapshot], pagination: { count: 1, next: null } }) : json({}, 404));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'vercel_snapshot_cleanup_unqualified' });
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
  });
  it('confirms full absence when the name and its resource-scoped snapshots are absent', async () => {
    const { client } = fixture(url => url.pathname === '/v2/sandboxes/snapshots' ? json(emptyPage) : json({}, 404));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
  });
  it('does not infer full absence from an arbitrary snapshot-list 404', async () => {
    const { client } = fixture(() => json({}, 404));
    expect(await client.inspect(resource)).toEqual({ observedAt: 2000, availability: 'unavailable', reason: 'vercel_snapshot_cleanup_unqualified' });
  });
  it('preserves trailing spaces in the actually observed guest home', async () => {
    const home = '/home/custom guest ';
    const { client } = fixture((url, init) => {
      if (url.pathname.endsWith('/cmd') || /\/cmd\/cmd_one$/.test(url.pathname)) {
        return json({ command: { id: 'cmd_one', sessionId: session.id, exitCode: init?.method === 'POST' ? null : 0 } });
      }
      if (url.pathname.endsWith('/logs')) return new Response(JSON.stringify({ stream: 'stdout', data: 'Linux\nx86_64\n' + home + '\n' }) + '\n');
      return json({ sandbox: named(), session, routes: [], resumed: false });
    });
    expect(await client.bootstrap(resource)).toMatchObject({ guestHome: { homeDir: home, happyHomeDir: home + '/.happier' } });
  });

  it('retains a dropped create response and recovers one exact tagged allocation without another POST', async () => {
    let created = false;
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (url.pathname === '/v4/sandboxes') { created = true; throw new Error('response dropped private vendor body'); }
      return created ? json({ sandbox: named(), session, resumed: false, routes: [] }) : json({}, 404);
    });
    const pending = await client.acquire(launch, resource.managedId);
    expect(pending).toEqual({ kind: 'pending', nativeOperationRef: reference({ kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope }) });
    const operation = { kind: 'acquire' as const, name: resource.name, managedId: resource.managedId, ...scope };
    expect(await client.recover(operation)).toEqual({ kind: 'bound', resource: reference(resource) });
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    const create = calls.find(call => call.url.pathname === '/v4/sandboxes');
    expect(JSON.parse(String(create!.init!.body))).toMatchObject({ persistent: true, snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: 0 }, architecture: 'amd64' });
    expect(JSON.stringify(pending)).not.toContain('private');
  });
  it.each(['malformed-session', 'missing-session'])('retains returned creation identity before %s readiness and refuses a reused name on recovery', async ancillary => {
    let created = false, ready = false, createdAt = resource.createdAt;
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (init?.method === 'POST') created = true;
      if (!created) return json({}, 404);
      return json({ sandbox: { ...named(), createdAt, status: ready ? 'running' : null },
        session: ready ? session : ancillary === 'missing-session' ? undefined : { ...session, id: null } });
    });
    const operation = { kind: 'acquire' as const, name: resource.name, managedId: resource.managedId, ...scope, createdAt: resource.createdAt };
    const pending = { kind: 'pending', nativeOperationRef: reference(operation) };
    const acquired = await client.acquire(launch, resource.managedId);
    expect(acquired).toEqual(pending);
    // Exercise the strict stored handle boundary, not just an in-memory value.
    const stored = RECONCILIATION.result.parse(acquired);
    expect(stored.kind).toBe('pending');
    if (stored.kind !== 'pending') throw new Error('Expected pending custody');
    expect(await client.recover(stored.nativeOperationRef.value)).toEqual(pending);
    ready = true; createdAt = 9999;
    expect(await client.recover(stored.nativeOperationRef.value)).toEqual(pending);
    createdAt = resource.createdAt;
    expect(await client.recover(stored.nativeOperationRef.value)).toEqual({ kind: 'bound', resource: reference(resource) });
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });
  it('observes timed-out retained stop without waking or doing guest IO', async () => {
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/')
      ? json({ snapshot }) : json({ sandbox: named('stopped'), session: { ...session, status: 'stopped' }, resumed: false, routes: [] }));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
    expect(calls[0]!.url.searchParams.get('resume')).toBe('false');
    expect(calls.some(call => /cmd|fs/.test(call.url.pathname))).toBe(false);
  });
  it.each(['missing', 'expired'])('never replaces a stopped sandbox whose snapshot is %s', async state => {
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/')
      ? state === 'missing' ? json({}, 404) : json({ snapshot: { ...snapshot, expiresAt: 1999 } })
      : json({ sandbox: named('stopped'), session, resumed: false, routes: [] }));
    expect(await client.power(resource, 'resume')).toEqual({ kind: 'refused', code: 'vercel_snapshot_unavailable' });
    expect(calls.every(call => call.url.searchParams.get('resume') !== 'true' && (!call.init?.method || call.init.method === 'GET'))).toBe(true);
  });
  it('does not operate a reused name with a different creation fact', async () => {
    const { client, calls } = fixture(() => json({ sandbox: { ...named(), createdAt: 9999 }, session, resumed: false, routes: [] }));
    expect(await client.power(resource, 'stop')).toEqual({ kind: 'refused', code: 'vercel_identity_mismatch' });
    expect(calls).toHaveLength(1);
  });
  it('refuses Suspend without any HTTP effect', async () => {
    const { client, calls } = fixture(() => { throw new Error('no HTTP'); });
    expect(await client.power(resource, 'suspend')).toEqual({ kind: 'refused', code: 'vercel_intent_unsupported' });
    expect(calls).toEqual([]);
  });
  it('keeps cancellation after create as uncertain native custody', async () => {
    const controller = new AbortController();
    const { client } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (init?.method === 'POST') { controller.abort(); throw new Error('aborted response'); }
      return json({}, 404);
    }, controller.signal);
    expect(await client.acquire(launch, resource.managedId)).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { managedId: resource.managedId } } });
  });
  it('retains recovery when the credential is unavailable rather than claiming absence', async () => {
    const { client } = fixture(() => json({}, 401));
    const operation: VercelOperation = { kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope };
    expect(await client.recover(operation)).toEqual({ kind: 'pending', nativeOperationRef: reference(operation),
      nativeCause: { httpStatusClass: '4xx' } });
    expect(await client.inspect(resource)).toEqual({ observedAt: 2000, availability: 'unavailable', reason: 'credential_unavailable',
      nativeCause: { httpStatusClass: '4xx' } });
  });
  it.each([400, 403, 503])('preserves a pending acquisition cleanup read failure (%i)', async status => {
    const { client, calls } = fixture(() => json({ private: 'vendor body' }, status));
    const operation: VercelOperation = { kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope };
    expect(RECONCILIATION.destroyResult.parse(await client.destroy({ nativeOperation: operation }))).toEqual({
      kind: 'unknown', code: status === 403 ? 'credential_unavailable' : 'vercel_http_' + status,
      nativeCause: { httpStatusClass: status < 500 ? '4xx' : '5xx' },
    });
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
  });
  it('deletes a stopped sandbox and its snapshot when Vercel requested the session before creating the named sandbox', async () => {
    let sandboxDeleted = false;
    let snapshotDeleted = false;
    const source = { ...session, createdAt: resource.createdAt - 81, status: 'stopped' };
    const { client, calls } = fixture((url, init) => {
      if (url.pathname === '/v2/sandboxes/snapshots') return json({ snapshots: [snapshot], pagination: { next: null } });
      if (url.pathname === `/v2/sandboxes/sessions/${session.id}`) return json({ session: source });
      if (url.pathname === `/v2/sandboxes/snapshots/${snapshot.id}`) {
        return json({ snapshot: { ...snapshot, status: snapshotDeleted ? 'deleted' : 'created' } });
      }
      if (init?.method === 'DELETE') {
        sandboxDeleted = true;
        snapshotDeleted = url.searchParams.get('deleteOrphanSnapshots') === 'true';
      }
      return sandboxDeleted ? json({}, 404) : json({ sandbox: named('stopped'), session: source });
    });
    const issued = await client.destroy({ resource });
    expect(issued).toMatchObject({ kind: 'accepted', nativeOperationRef: { value: { kind: 'delete', phase: 'delete', snapshotIds: [snapshot.id] } } });
    if (issued.kind !== 'accepted' || !issued.nativeOperationRef) throw new Error('Expected retained deletion handle');
    expect(await client.destroy({ nativeOperation: VercelOperationSchema.parse(issued.nativeOperationRef.value) })).toEqual({ kind: 'confirmed' });
    expect(sandboxDeleted && snapshotDeleted).toBe(true);
    expect(calls.filter(call => call.init?.method === 'POST')).toEqual([]);
  });

  it.each(['older-snapshot', 'other-sandbox'])('refuses cleanup of an %s despite an early session request', async mismatch => {
    const source = { ...session, createdAt: resource.createdAt - 81,
      sourceSandboxName: mismatch === 'other-sandbox' ? 'another-sandbox' : resource.name };
    const candidate = { ...snapshot, createdAt: mismatch === 'older-snapshot' ? resource.createdAt - 1 : snapshot.createdAt };
    const { client, calls } = fixture(url => {
      if (url.pathname === '/v2/sandboxes/snapshots') return json({ snapshots: [candidate], pagination: { next: null } });
      if (url.pathname === `/v2/sandboxes/sessions/${session.id}`) return json({ session: source });
      return json({ sandbox: named('stopped'), session: source });
    });
    expect(await client.destroy({ resource })).toMatchObject(mismatch === 'other-sandbox'
      ? { kind: 'refused', code: 'vercel_identity_mismatch' }
      : { kind: 'unknown', code: 'vercel_cleanup_unqualified' });
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
  });

  it('keeps deletion incomplete while exact owned snapshot survives', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/') ? json({ snapshot }) : json({}, 404));
    expect(await client.destroy({ nativeOperation: operation })).toEqual({ kind: 'accepted', nativeOperationRef: reference(operation) });
    expect(await client.cleanup(operation)).toEqual({ kind: 'retryable' });
    expect(calls.filter(call => call.init?.method === 'DELETE')).toEqual([]);
  });
  it('observes deletion only after both sandbox and exact snapshots are gone', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client, calls } = fixture(() => json({}, 404));
    expect(await client.cleanup(operation)).toEqual({ kind: 'confirmed' });
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
  });
  it('keeps unknown snapshot cleanup incomplete', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client } = fixture(url => url.pathname.includes('/snapshots/') ? json({}, 503) : json({}, 404));
    expect(await client.cleanup(operation)).toMatchObject({ kind: 'unknown' });
  });
  it('enforces the observed account plan before allocation', async () => {
    const { client, calls } = fixture(url => url.pathname.startsWith('/v2/teams/')
      ? json({ id: scope.teamId, billing: { plan: 'hobby' } }) : json({}, 404));
    expect(await client.acquire({ ...launch, timeoutMs: 86_400_000 }, resource.managedId)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  });
});
