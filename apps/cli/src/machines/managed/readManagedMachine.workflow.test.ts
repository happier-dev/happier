import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { readManagedMachineRead } from './readManagedMachine';
import { ManagedGetOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

afterEach(() => vi.restoreAllMocks());

it('reads the original Workflow creation by retained run identity without selecting a new preset or pool', async () => {
    const retainedWorkflowRoot = { binding: { serverIdentityId: 'srv_home', accountId: 'owner', actionId: 'workflow.run.start',
        requestId: 'original-request', authentication: { kind: 'account', tokenEpoch: 1 },
        target: { kind: 'machine', machineId: 'controller', project: { machineId: 'controller', directory: '/repo' } } },
        envelope: { v: 1, requestId: 'original-request', target: { kind: 'machine', machineId: 'controller',
            project: { machineId: 'controller', directory: '/repo' } }, input: { runId: '11111111-1111-4111-8111-111111111111',
            source: { kind: 'inline', definition: { version: 1, defaults: {}, blocks: [] } } } } };
    const row = ManagedGetOutputV1Schema.parse({ id: 'original-machine', homeId: 'srv_home', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Original guest', choices: {} },
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, controller: { machineId: 'controller', installationId: 'installation' },
        allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, retainedWorkflowRoot });
    const paths: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        paths.push(new URL(String(url)).pathname);
        expect(body).toEqual({ homeId: 'srv_home', creationRequestId: '11111111-1111-4111-8111-111111111111' });
        return { status: 200, data: row };
    });
    // This public Get union already exists at Home. Passing the canonical arm
    // through the old id-only reader exposes its dropped lookup field.
    const request = { credentials: { token: 'owner-token', encryption: null }, serverHttpBaseUrl: 'https://home.test',
        homeId: 'srv_home', creationRequestId: '11111111-1111-4111-8111-111111111111' };
    const read = await readManagedMachineRead(request);
    expect(read).toEqual(row);
    expect(paths).toEqual(['/v1/machines/managed/actions/get']);
});
