import { afterEach, expect, it } from 'vitest';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { encryptSecretBox } from '@/encryption/libsodium';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { readOriginalAccountActionAuthentication } from '@/sync/api/externalActionAccountTransport';
import { Encryption } from '@/sync/encryption/encryption';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');

afterEach(standardCleanup);

it.each(['plain', 'e2ee'] as const)('publishes accepted inspection facts through the real %s Account row writer without changing inspect success', async mode => {
    await homes.reset();
    const secret = new Uint8Array(32).fill(9);
    const actionEncryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }),
        ...(mode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
    const serverId = await homes.addHome({ name: 'Observation Home', serverUrl: `https://${mode}-repository-observation.test`,
        serverIdentityId: 'srv_repository_observation_home', accountId: 'alice', currentAccount: true, credentials, accountEncryptionMode: mode });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const workspace = { serverId, workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' };
    const plainMachine = createPlainMachineRowFixture({ id: workspace.machineId, accountId: 'alice' });
    const machine = mode === 'plain' ? plainMachine : { ...plainMachine, dataEncryptionKey: null,
        metadata: encodeBase64(encryptSecretBox({ host: 'fixture', platform: 'linux', homeDir: '/home/alice' }, secret)),
        access: { ...plainMachine.access!, resourceMode: 'e2ee' as const } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, 'GET /v1/machines/machine', { body: { machine } });
    const cipher = createProjectAccountRowCipherV1({ mode, material: mode === 'plain' ? null : { type: 'legacy', secret },
        randomBytes: length => new Uint8Array(length).fill(7) });
    const key = { kind: 'workspace-ref' as const, serverId, id: workspace.workspaceId };
    const ref = { id: key.id, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath,
        createdAtMs: 1, label: 'Keep authored name', source: { sourceId: 'source', revision: 3 } };
    const rows = new Map<string, ProjectAccountRowV1>([[buildProjectAccountRowPhysicalKeyV1(key),
        { key, revision: 0, content: cipher.seal({ key, value: ref }) }]]);
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows: [...rows.values()] } }) });
    let refuseWrite = false;
    homes.answer(serverId, 'POST /v1/account/project-rows/mutate', { select: input => {
        if (refuseWrite) return { status: 403, body: { error: 'forbidden' } };
        const request = ProjectAccountRowMutationRequestV1Schema.parse(input);
        for (const mutation of request.mutations) {
            const id = buildProjectAccountRowPhysicalKeyV1(mutation.key);
            const previous = rows.get(id);
            if ((previous?.revision ?? 'absent') !== mutation.expectedRevision) return { body: { status: 'conflict', key: mutation.key, revision: previous?.revision ?? -1 } };
        }
        const updated = request.mutations.map(mutation => ({ key: mutation.key,
            revision: (rows.get(buildProjectAccountRowPhysicalKeyV1(mutation.key))?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of updated) rows.set(buildProjectAccountRowPhysicalKeyV1(row.key), row);
        return { body: { status: 'updated', rows: updated, cursor: 1 } };
    } });
    const observation = { observedAtMs: 10, coverage: 'complete' as const,
        rootFiles: { dockerfile: 'present' as const, compose: 'absent' as const },
        applications: [{ file: 'package.json', framework: 'next', runtime: { name: 'node', version: '22' }, build: null, start: null, port: null }] };
    let observedAtMs = 10;
    homes.answer(serverId, '/v1/actions/projects.inspect', { select: input => {
        const execution = { ok: true, result: { definition: { basis: { kind: 'absent' }, document: null }, importCandidates: [],
            detection: { entries: [], toolchains: [], devcontainers: [], diagnostics: [], ...observation, observedAtMs } } };
        if (mode === 'e2ee') {
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(input);
            const authentication = readOriginalAccountActionAuthentication(credentials.token);
            if (!authentication) throw new Error('Expected current Account authentication');
            const binding = { serverIdentityId: 'srv_repository_observation_home', accountId: 'alice', authentication,
                actionId: 'projects.inspect' as const, requestId: envelope.requestId, target: envelope.target };
            const material = { type: 'dataKey' as const, machineKey: actionEncryption!.getContentPrivateKey() };
            expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                envelope, binding, material })).not.toBeNull();
            return { body: prepareExternalActionResponseV2({ binding, request: envelope, executedMachineId: workspace.machineId,
                execution, material, randomBytes: length => new Uint8Array(length).fill(6) }).response };
        }
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect', requestId: envelope.requestId, execution }) };
    } });
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
    const inspect = () => execute('projects.inspect', { workspace, read: { kind: 'applications' } },
        { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice' });
    const first = await inspect();
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const saved = rows.get(buildProjectAccountRowPhysicalKeyV1(key))!;
    expect(saved.content?.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    expect(cipher.open(key, saved.content!).value).toMatchObject({ ...ref, repositoryObservation: { observedAtMs: 10,
        coverage: observation.coverage, rootFiles: observation.rootFiles, source: ref.source,
        applications: [{ file: 'package.json', framework: 'next', runtime: { name: 'node', version: '22' } }] } });
    // Replayed/unchanged output carries the producer's old time; acceptance cannot re-date it.
    expect(await inspect()).toMatchObject({ ok: true });
    expect(homes.requestsFor('/v1/account/project-rows/mutate')).toHaveLength(1);
    refuseWrite = true;
    observedAtMs = 20;
    expect(await inspect()).toMatchObject({ ok: true });
    expect(rows.get(buildProjectAccountRowPhysicalKeyV1(key))).toBe(saved);
});
