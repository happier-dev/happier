import axios from 'axios';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { afterEach, expect, it, vi } from 'vitest';
import { dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';
import { ManagedGetOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('rejoins an unknown %s Workflow acquisition before changed preset or pool selection', async mode => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ sub: 'owner', tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
    const secret = new Uint8Array(32).fill(64);
    const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
    const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const runId = '11111111-1111-4111-8111-111111111111';
    const project = { machineId: 'authored-machine', directory: '/repo',
        sessionPlacement: { kind: 'preset' as const, homeId: 'srv_home', presetId: 'saved-preset' } };
    const target = { kind: 'machine' as const, machineId: 'original-controller', project: { ...project, machineId: 'original-controller' } };
    const start = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'command', actionId: 'machines.command.run', input: { command: { kind: 'literal', value: 'echo reviewed' } } }] } } });
    const binding = { serverIdentityId: 'srv_home', accountId: 'owner', actionId: 'workflow.run.start',
        requestId: 'original-root-request', authentication: { kind: 'account' as const, tokenEpoch: 7 }, target };
    const workflowPreparation = { project, acquisition: { selection: { kind: 'preset' as const,
        homeId: 'srv_home', id: 'saved-preset', revision: 4 },
        controller: { machineId: 'original-controller', installationId: 'installation' } } };
    const original = mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input: start, workflowPreparation }
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding, input: start, workflowPreparation, material, randomBytes: length => new Uint8Array(length).fill(65) });
    const row = ManagedGetOutputV1Schema.parse({ id: 'retained-machine', homeId: 'srv_home', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Original guest', choices: {} },
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, controller: workflowPreparation.acquisition.controller,
        allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        retainedWorkflowRoot: { binding, envelope: original } });
    const paths: string[] = [];
    const minted: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
        return { status: 200, data: { machine: { id: 'original-controller', kind: 'persistent', active: true,
            installationId: 'installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
            runnerContentKeyBinding: null, installationPublicKey: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: mode, accessState: 'ready' } } } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === '/v1/machines/managed/actions/get') {
            expect(body).toEqual({ homeId: 'srv_home', creationRequestId: runId });
            return { status: 200, data: row };
        }
        if (path.endsWith('/execution-authorization')) {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            minted.push(request.envelope);
            expect(request.envelope).toEqual(original);
            return { status: 200, data: { v: 1, token: 'fresh-root-authorization', binding: { ...binding,
                machineId: 'original-controller', custodianAccountId: 'owner', installationId: 'installation', accountEncryptionMode: mode,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(original) } } };
        }
        expect(path).toBe('/v1/actions/workflow.run.start');
        const execution = { ok: true as const, result: { kind: 'approval_request_created', artifactId: 'same-review', actionId: 'workflow.run.start' } };
        return { status: 200, data: original.v === 1 ? { v: 1, actionId: 'workflow.run.start', requestId: binding.requestId, execution }
            : prepareExternalActionResponseV2({ binding, request: original, execution, executedMachineId: 'original-controller',
                material, randomBytes: length => new Uint8Array(length).fill(66) }).response };
    });
    const invoke = (input = start, authoredProject = project, requester = credentials) => dispatchOriginalAccountAction({ actionId: 'workflow.run.start', input,
        requestId: 'new-client-request', target: { kind: 'machine', machineId: authoredProject.machineId, project: authoredProject },
        credentials: requester, serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_home' });
    const initial = await invoke();
    expect(initial, JSON.stringify({ initial, paths })).toMatchObject({ ok: true, result: { artifactId: 'same-review' } });
    expect(minted).toEqual([original]);
    expect(paths).toContain('/v1/machines/managed/actions/get');
    expect(paths.filter(path => path.includes('/presets/') || path.includes('/pools/'))).toEqual([]);
    expect(paths).not.toContain('/v1/machines/authored-machine');
    expect(await invoke({ ...start, inputs: { changed: 'intent' } }))
        .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(await invoke(start, { ...project, directory: '/different-repo' }))
        .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(await invoke(start, { ...project, sessionPlacement: { ...project.sessionPlacement, presetId: 'different-preset' } }))
        .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    const otherAccountToken = `${encode({ alg: 'none' })}.${encode({ sub: 'other-account', tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
    expect(await invoke(start, project, { ...credentials, token: otherAccountToken }))
        .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(minted).toHaveLength(1);
});
