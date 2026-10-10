import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';

const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
const credentials = { token, encryption: null, credentialProvenance: 'api_token' as const };
const sourceRef = { id: 'source-ref', serverId: 'source-home', machineId: 'source-coordinator', rootPath: '/source', createdAtMs: 1 };
const input = { workspace: { serverId: 'source-home', refId: sourceRef.id }, serviceName: 'worker', requestId: 'move',
  currentTarget: { kind: 'managed_service', managedServiceId: 'native-instance', machineId: 'old-worker' },
  destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'new-worker' } } };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function network(refs = [sourceRef]) {
  const actions: unknown[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body: unknown = raw ? JSON.parse(raw) : null;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/account/encryption') {
      response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 })); return;
    }
    if (request.url === '/v1/machines') {
      response.end(JSON.stringify([{ id: 'other-default-machine', active: true, revokedAt: null, replacedByMachineId: null, kind: 'persistent' }])); return;
    }
    if (request.url?.endsWith('/list')) {
      response.end(JSON.stringify({ status: 'listed', coverage: 'complete', rows: refs.map(ref => {
        const key = { kind: 'workspace-ref', serverId: ref.serverId, id: ref.id };
        return { key, revision: 0, content: { t: 'plain', v: { key, value: ref } } };
      }) })); return;
    }
    const envelope = body && typeof body === 'object' ? body as Readonly<Record<string, unknown>> : {};
    // Action identity belongs to the real HTTP route, not the strict request body.
    const actionId = request.url?.includes('localServices.actions.stopManaged')
      ? 'localServices.actions.stopManaged' : 'projects.service.relocate';
    actions.push({ actionId, ...envelope });
    response.end(JSON.stringify({ v: 1, actionId, requestId: envelope.requestId,
      execution: { ok: true, result: actionId === 'localServices.actions.stopManaged'
        ? { v: 1, requestId: 'exact-native-stop', action: 'stop_managed', status: 'denied', reasonCode: 'unknown_managed_service', auditEvents: [] }
        : { status: 'unchanged', currentTarget: input.currentTarget } } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing network fixture address');
  return { endpoint: `http://127.0.0.1:${address.port}`, actions };
}

describe('CLI relocation source routing', () => {
  const nativeStop = { requestId: 'exact-native-stop', action: 'stop_managed' as const, force: false,
    target: { kind: 'managed_service' as const, machineId: 'old-worker', managedServiceId: 'observed-native-instance' } };
  const confirmedStop = { ...nativeStop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(nativeStop) };
  it('binds the explicit native control Machine before PAT dispatch without borrowing the configured default', async () => {
    const boundary = await network();
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    await expect(executor.execute('localServices.actions.stopManaged', confirmedStop, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'unknown_managed_service' } });
    expect(boundary.actions).toEqual([expect.objectContaining({ actionId: 'localServices.actions.stopManaged',
      target: { kind: 'machine', machineId: 'old-worker' }, input: confirmedStop })]);
    const scopedTarget = { kind: 'machine' as const, machineId: 'old-worker',
      project: { machineId: 'old-worker', directory: '/old', workspaceRefId: 'old-ref' } };
    await expect(executor.execute('localServices.actions.stopManaged', confirmedStop,
      { surface: 'cli', externalActionTarget: scopedTarget }))
      .resolves.toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'unknown_managed_service' } });
    expect(boundary.actions[1]).toMatchObject({ actionId: 'localServices.actions.stopManaged',
      target: scopedTarget, input: confirmedStop });
  });
  it('refuses explicit native control targets conflicting with captured Machine or existing target authority before PAT dispatch', async () => {
    const boundary = await network();
    const fixed = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint,
      machineId: 'source-coordinator' });
    await expect(fixed.prepare('localServices.actions.stopManaged', confirmedStop, { surface: 'cli' }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'target_unavailable' } });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    await expect(executor.prepare('localServices.actions.stopManaged', confirmedStop,
      { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'source-coordinator' } }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'target_unavailable' } });
    await expect(executor.prepare('localServices.actions.stopManaged', { ...confirmedStop, action: 'restart_managed' }, { surface: 'cli' }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'invalid_parameters' } });
    expect(boundary.actions).toEqual([]);
  });
  it('resolves the accepted qualified source through real rows and SDK transport, not the current native worker or configured Machine', async () => {
    const boundary = await network();
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    await expect(executor.execute('projects.service.relocate', input, { surface: 'cli' })).resolves.toMatchObject({ ok: true });
    expect(boundary.actions).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'source-coordinator' } })]);
  });
  it('refuses captured source target conflicts before PAT dispatch rather than widening their authority', async () => {
    const boundary = await network();
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    await expect(executor.prepare('projects.service.relocate', input, { surface: 'cli',
      externalActionTarget: { kind: 'machine', machineId: 'old-worker' } }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'target_unavailable' } });
    await expect(executor.prepare('projects.service.relocate', input, { surface: 'cli',
      externalActionTarget: { kind: 'session', sessionId: 'captured-session' } }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'target_unavailable' } });
    expect(boundary.actions).toEqual([]);
  });
  it('preserves a matched source Machine project scope in the actual PAT envelope', async () => {
    const boundary = await network();
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    const target = { kind: 'machine' as const, machineId: 'source-coordinator',
      project: { machineId: 'source-coordinator', directory: '/source', workspaceRefId: sourceRef.id } };
    await expect(executor.execute('projects.service.relocate', input, { surface: 'cli', externalActionTarget: target }))
      .resolves.toMatchObject({ ok: true });
    expect(boundary.actions).toEqual([expect.objectContaining({ target })]);
  });
  it('refuses an unavailable source or different Home without sending an Action or borrowing a default Machine', async () => {
    const boundary = await network();
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'source-home', serverApiUrl: boundary.endpoint });
    await expect(executor.prepare('projects.service.relocate', { ...input, workspace: { ...input.workspace, refId: 'unavailable-source' } }, { surface: 'cli' }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'workspace_ref_unavailable' } });
    await expect(executor.prepare('projects.service.relocate', { ...input, workspace: { ...input.workspace, serverId: 'other-home' } }, { surface: 'cli' }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'server_target_mismatch' } });
    expect(boundary.actions).toEqual([]);
  });
});
