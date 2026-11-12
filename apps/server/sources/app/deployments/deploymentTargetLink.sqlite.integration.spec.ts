import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, computeDeploymentTransitionRequestDigestV1,
    signMachineInstallationProof, DeploymentTargetLinkResultV1Schema, DeploymentTargetLinksListResultV1Schema,
    DeploymentDomainMutationResultV1Schema, deploymentDomainObservationProofPayloadV1,
    nativeCaddyDomainRouteIdsV1, nativeCaddyRemovalSigningBytes,
    DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1, type DeploymentChildRpcV1,
    DeploymentReceiptResultV1Schema, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { readDeploymentTargetInTx } from './deploymentTargetLinkService';
import { readDeploymentMachineReferencesInTx } from './deploymentReadService';
import { auth } from '@/app/auth/auth';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { transitionDeploymentInTx } from './deploymentService';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';

describe('current runtime membership replacement', () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-membership-',
        initEncrypt: true, initAuth: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('replaces a never-deployed own-server first link without inventing a drain receipt, retaining its predecessor', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: crypto.randomUUID(), name: 'First placement' }));
        if (!source.ok) throw new Error(source.error);
        const machines = await Promise.all(['First', 'Replacement'].map(host => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, installationId: crypto.randomUUID(),
            metadata: encodePlainMachineStoredContent({ host, platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } })));
        const content = async (kind: string) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'First placement' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machines[0]!.id, ...await content('deployment-environment.v1') } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/targets`, headers: { 'x-test-user-id': owner.id }, payload });
            const base = { serverId, environmentId: environment.id, targetId: 'own-server', role: 'runtime',
                ...await content('deployment-target-link.v1') };
            const first = await send({ ...base, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
                machines: [{ machineId: machines[0]!.id, installationId: machines[0]!.installationId }] });
            expect(first.statusCode, first.body).toBe(200);
            const replacement = { ...base, expectedRevision: first.json().revision, requestKey: crypto.randomUUID(),
                replacesLinkId: first.json().targetLinkId, expectedTargetLinkRevision: first.json().targetLinkRevision,
                machines: [{ machineId: machines[1]!.id, installationId: machines[1]!.installationId }] };
            const changed = await send(replacement);
            expect(changed.statusCode, changed.body).toBe(200);
            expect((await send(replacement)).json()).toEqual(changed.json());
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, changed.json().targetLinkId)))
                .toMatchObject({ predecessorTargetLinkId: first.json().targetLinkId, machines: [machines[1]!.id] });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(0);
            expect(await db.deploymentTargetLink.findUnique({ where: { id: first.json().targetLinkId } })).not.toBeNull();
            // A failed attempt may already own native resources even without a
            // serving pointer; only the existing teardown owner can release them.
            await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: changed.json().targetLinkId,
                operation: 'deploy', state: 'failed', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
                actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1') } });
            const attempted = await send({ ...replacement, expectedRevision: changed.json().revision,
                replacesLinkId: changed.json().targetLinkId, expectedTargetLinkRevision: changed.json().targetLinkRevision,
                requestKey: crypto.randomUUID(), machines: [{ machineId: machines[0]!.id, installationId: machines[0]!.installationId }] });
            expect(attempted.statusCode, attempted.body).toBe(200);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).runtimeTargetLinkId)
                .toBe(attempted.json().targetLinkId);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: changed.json().targetLinkId } }))
                .toMatchObject({ deletedAt: null, detachedAt: null });

            // Selecting a Move destination retains the exact serving source as
            // its predecessor; only teardown/unlink may release that custody.
            const serving = await db.deployment.create({ data: { environmentId: environment.id,
                targetLinkId: attempted.json().targetLinkId, operation: 'deploy', state: 'succeeded',
                requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
                actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1') } });
            await db.deploymentTargetLink.update({ where: { id: attempted.json().targetLinkId },
                data: { activeDeploymentId: serving.id, state: 'deployed' } });
            const move = { ...replacement, expectedRevision: attempted.json().revision,
                replacesLinkId: attempted.json().targetLinkId, expectedTargetLinkRevision: attempted.json().targetLinkRevision,
                requestKey: crypto.randomUUID(), machines: [{ machineId: machines[1]!.id, installationId: machines[1]!.installationId }] };
            const preparedMove = await send(move);
            expect(preparedMove.statusCode, preparedMove.body).toBe(200);
            expect((await send(move)).json()).toEqual(preparedMove.json());
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: attempted.json().targetLinkId },
                include: { machines: true } })).toMatchObject({ deletedAt: null, detachedAt: null,
                activeDeploymentId: serving.id, machines: [{ machineId: machines[0]!.id }] });
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, preparedMove.json().targetLinkId)))
                .toMatchObject({ predecessorTargetLinkId: attempted.json().targetLinkId, machines: [machines[1]!.id] });
            expect(await db.deployment.count({ where: { environmentId: environment.id, operation: 'teardown' } })).toBe(0);
        });
    });

    it('replaces preview child DATA provider content in place while preserving the captured teardown link identity', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Preview DATA publication' }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Preview', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID() } });
        const artifact = async (kind: string) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Preview DATA' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const placement = { projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', deployerMode: 'managers', controllerMachineId: machine.id,
            ...await artifact('deployment-environment.v1') };
        const parent = await db.deploymentEnvironment.create({ data: { ...placement, purpose: 'standard' } });
        const runtime = await db.deploymentTargetLink.create({ data: { environmentId: parent.id, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            ...await artifact('deployment-target-link.v1') } });
        const child = await db.deploymentEnvironment.create({ data: { ...placement, purpose: 'preview',
            previewTemplateEnvironmentId: parent.id, previewRepositoryId: source.source.id,
            previewPullRequestId: '17', previewTargetLinkId: runtime.id } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${child.id}/targets`, headers: { 'x-test-user-id': owner.id }, payload });
            const base = { serverId, environmentId: child.id, expectedRevision: child.revision, requestKey: crypto.randomUUID(),
                targetId: 'database', role: 'data', source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.supabase', localId: 'database' } },
                targetKind: 'postgres', machines: [], ...await artifact('deployment-target-link.v1') };
            const first = await send(base);
            expect(first.statusCode, first.body).toBe(200);
            const initial = first.json();
            const nativeContent = await artifact('deployment-target-link.v1');
            const replacement = { ...base, ...nativeContent, requestKey: crypto.randomUUID(), expectedRevision: initial.revision,
                replacesLinkId: initial.targetLinkId, expectedTargetLinkRevision: initial.targetLinkRevision };
            const foreign = await send({ ...replacement, targetKind: 'other' });
            expect(foreign.statusCode, foreign.body).toBe(409);
            const changed = await send(replacement);
            expect(changed.statusCode, changed.body).toBe(200);
            expect(changed.json()).toMatchObject({ ok: true, targetLinkId: initial.targetLinkId,
                revision: initial.revision + 1, targetLinkRevision: initial.targetLinkRevision + 1 });
            expect((await send(replacement)).json()).toEqual(changed.json());
            expect(await db.deploymentTargetLink.findMany({ where: { environmentId: child.id } })).toMatchObject([
                { id: initial.targetLinkId, revision: initial.targetLinkRevision + 1, ...nativeContent }]);
        });
    });

    it('stores provisioned plugin runtime beside unchanged Neon data custody and retains runtime predecessors', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(), name: 'Platform links' }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Target', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID() } });
        const controller = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID() } });
        const foreignMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: foreign.id,
            metadata: '{}', installationId: crypto.randomUUID() } });
        async function content(kind: string, value: unknown = { providerIdentity: {
            providerAccountId: 'private-account', providerResourceId: 'private-resource', providerEnvironment: 'production' } }) {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private platform' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: controller.id, buildMachineId: controller.id, ...await content('deployment-environment.v1') } });
        const targetContent = await content('deployment-target-link.v1');
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environment.id}/targets`;
            const base = { serverId, environmentId: environment.id, expectedRevision: 1, machines: [],
                source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'neon' } },
                targetId: 'happier.deploy.neon/neon', targetKind: 'database', role: 'data',
                requestKey: crypto.randomUUID(), ...targetContent };
            const send = (payload: typeof base | Record<string, unknown>) => app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': owner.id }, payload });
            for (const placement of [{ machineId: machine.id, installationId: 'stale' },
                { machineId: foreignMachine.id, installationId: foreignMachine.installationId! }]) {
                const denied = await send({ ...base, ...placement });
                expect(denied.statusCode, denied.body).toBe(503);
                expect(denied.json()).toMatchObject({ error: 'machine_unavailable', role: 'target' });
            }
            const first = await send({ ...base, machineId: machine.id, installationId: machine.installationId! });
            expect(first.statusCode, first.body).toBe(200);
            const saved = DeploymentTargetLinkResultV1Schema.parse(first.json());
            if (!saved.ok) throw new Error(saved.error);
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, saved.targetLinkId))).toMatchObject({
                role: 'data', source: base.source, targetKind: 'database', state: 'configured', ...targetContent, machines: [], members: [],
                machineId: machine.id, installationId: machine.installationId! });
            const dataOnly = await app.inject({ method: 'GET', url: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(dataOnly.statusCode, dataOnly.body).toBe(200);
            expect(dataOnly.json().targetLinks).toMatchObject([{ id: saved.targetLinkId, role: 'data' }]);
            const replacedData = await send({ ...base, expectedRevision: saved.revision, requestKey: crypto.randomUUID(),
                replacesLinkId: saved.targetLinkId, expectedTargetLinkRevision: saved.targetLinkRevision });
            expect(replacedData.statusCode, replacedData.body).toBe(409);
            expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(1);
            const dataReferences = await inTx(tx => readDeploymentMachineReferencesInTx(tx, owner.id, { homeId: serverId, machineId: machine.id }));
            expect(dataReferences).toMatchObject({ coverage: 'complete', references: [{ id: environment.id,
                deploymentRoles: ['data'] }] });
            if ('references' in dataReferences) expect(dataReferences.references[0]?.deploymentRoles).not.toContain('retiring');
            let replayWrites = 0;
            const stopReplay = observeSqliteRequests({ before: request => {
                if (['DeploymentTargetLink', 'DeploymentEnvironment', 'AccountChange'].includes(request.model ?? '')
                    && ['create', 'update', 'updateMany', 'upsert'].includes(request.action)) replayWrites++;
            } });
            const replay = await send({ ...base, machineId: machine.id, installationId: machine.installationId! }).finally(stopReplay);
            expect(replay.json()).toEqual(saved);
            expect(replayWrites, 'an equal request must not change stored links or publish another Environment hint').toBe(0);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).runtimeTargetLinkId).toBeNull();
            const second = await send({ ...base, expectedRevision: saved.revision, requestKey: crypto.randomUUID() });
            expect(second.statusCode, second.body).toBe(200);
            const neonLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: saved.targetLinkId } });
            const neonArtifact = await db.artifact.findUniqueOrThrow({ where: { id: targetContent.contentArtifactId } });
            const runtimeInput = { ...base, role: 'runtime', provisioned: true,
                source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } },
                targetId: 'example.deploy/platform', targetKind: 'platform',
                expectedRevision: second.json().revision, requestKey: crypto.randomUUID(),
                machineId: machine.id, installationId: machine.installationId! };
            const runtime = await send(runtimeInput);
            expect(runtime.statusCode, runtime.body).toBe(200);
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, runtime.json().targetLinkId)))
                .toMatchObject({ role: 'runtime', source: runtimeInput.source, state: 'provisioned', ...targetContent });
            expect((await send(runtimeInput)).json()).toEqual(runtime.json());
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: saved.targetLinkId } })).toEqual(neonLink);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: targetContent.contentArtifactId } })).toEqual(neonArtifact);
            expect(await inTx(tx => readDeploymentMachineReferencesInTx(tx, owner.id, { homeId: serverId, machineId: machine.id })))
                .toMatchObject({ coverage: 'complete', references: [{ id: environment.id,
                    deploymentRoles: expect.arrayContaining(['runtime', 'data']) }] });
            const duplicateRuntime = await send({ ...runtimeInput, expectedRevision: runtime.json().revision, requestKey: crypto.randomUUID() });
            expect(duplicateRuntime.statusCode, duplicateRuntime.body).toBe(409);
            const currentInstallationId = crypto.randomUUID();
            await db.machine.update({ where: { id: machine.id }, data: { installationId: currentInstallationId } });
            const stalePlacement = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/deploy`,
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, environmentId: environment.id,
                    expectedRevision: runtime.json().revision, targetLinkId: runtime.json().targetLinkId,
                    expectedTargetLinkRevision: runtime.json().targetLinkRevision, requestKey: crypto.randomUUID(),
                    actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1', createDeploymentReceiptDetailV1().content) } });
            expect(stalePlacement.statusCode, stalePlacement.body).toBe(503);
            expect(stalePlacement.json()).toMatchObject({ error: 'machine_unavailable', role: 'target', machineIds: [machine.id] });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(0);
            const replacement = await send({ ...runtimeInput, provisioned: undefined, expectedRevision: runtime.json().revision, requestKey: crypto.randomUUID(),
                installationId: currentInstallationId, replacesLinkId: runtime.json().targetLinkId,
                expectedTargetLinkRevision: runtime.json().targetLinkRevision });
            expect(replacement.statusCode, replacement.body).toBe(200);
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, replacement.json().targetLinkId)))
                .toMatchObject({ predecessorTargetLinkId: runtime.json().targetLinkId, state: 'configured' });
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, runtime.json().targetLinkId)))
                .toMatchObject({ state: 'provisioned' });
            expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(4);
            const read = await app.inject({ method: 'GET', url: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json().targetLinks).toHaveLength(4);
            expect(read.body).not.toContain('private-resource');
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            const revokedReplay = await send({ ...base, machineId: machine.id, installationId: machine.installationId! });
            expect(revokedReplay.statusCode, revokedReplay.body).toBe(503);
            expect(revokedReplay.json()).toMatchObject({ error: 'machine_unavailable' });
            expect(await db.deploymentTargetLink.count({ where: { environmentId: environment.id } })).toBe(4);
        });
    });

    it('pages only readable live and retiring links across Sources in the exact current scope without private bodies', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Link scope' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: '{}', installationId: crypto.randomUUID() } });
        async function artifact(kind: string, actorAccountId = owner.id) {
            const created = await createArtifact({ actorUserId: actorAccountId, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private link' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ providerResourceId: 'private-never-list' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        async function seed(label: string, scope: { kind: 'account'; accountId: string } | { kind: 'team'; teamId: string }, actorAccountId = owner.id) {
            const source = await inTx(tx => createProjectSourceInTx(tx, actorAccountId,
                { serverId, requestKey: crypto.randomUUID(), name: label, owner: scope }));
            if (!source.ok) throw new Error(source.error);
            const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: actorAccountId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machine.id, ...await artifact('deployment-environment.v1', actorAccountId) } });
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, id: `${label}-${crypto.randomUUID()}`,
                createdByAccountId: actorAccountId, role: 'data', sourceKind: 'plugin', pluginId: 'example.deploy', contributionLocalId: 'database',
                targetKind: 'database', state: 'provisioned', ...await artifact('deployment-target-link.v1', actorAccountId) } });
            if (scope.kind === 'team') for (const ref of [environment, link]) await db.artifactTeamGrant.create({ data: {
                artifactId: ref.contentArtifactId, teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id } });
            return { environment, link };
        }
        const accountScope = { kind: 'account' as const, accountId: owner.id };
        const a = await seed('a', accountScope), b = await seed('b', accountScope), c = await seed('c', accountScope);
        expect(await inTx(tx => readDeploymentTargetInTx(tx, a.environment.id, a.link.id))).toMatchObject({
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } }, role: 'data',
        });
        const hidden = await seed('hidden', { kind: 'account', accountId: outsider.id }, outsider.id);
        const shared = await seed('team', { kind: 'team', teamId: team.id });
        const deleted = await seed('deleted', accountScope), removed = await seed('removed', accountScope);
        await db.deploymentEnvironment.update({ where: { id: deleted.environment.id }, data: { deletedAt: new Date() } });
        await db.deploymentTargetLink.update({ where: { id: removed.link.id }, data: { deletedAt: new Date() } });
        await db.deploymentTargetLink.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({
            id: `0-hidden-${index}-${crypto.randomUUID()}`, environmentId: hidden.environment.id, createdByAccountId: outsider.id,
            role: 'data', sourceKind: 'plugin', pluginId: 'example.deploy', contributionLocalId: 'database', targetKind: 'database',
            state: 'provisioned', contentArtifactId: hidden.link.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
        })) });
        await db.deploymentTargetLink.update({ where: { id: c.link.id }, data: { detachedAt: new Date() } });
        // A retained predecessor is a readable cleanup dependency even when it is not selected.
        await db.deploymentTargetLink.update({ where: { id: b.link.id }, data: { role: 'runtime' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const list = (payload: Record<string, unknown>, actor = owner.id) => app.inject({ method: 'POST',
                url: '/v1/deployments/targets/list', headers: { 'x-test-user-id': actor }, payload });
            const reads: { model?: string; action: string; args: unknown }[] = [];
            const stop = observeSqliteRequests({ before: request => { reads.push(request); } });
            const first = await list({ serverId, scope: accountScope, limit: 1 });
            stop();
            expect(first.statusCode, first.body).toBe(200);
            const page = DeploymentTargetLinksListResultV1Schema.parse(first.json());
            if (!page.ok) throw new Error(page.error);
            expect(page.items.map(item => item.targetLink.id)).toEqual([a.link.id]);
            expect(page.nextCursor).toBe(a.link.id);
            expect(page.coverage).toBe('complete');
            expect(reads.filter(read => read.model === 'DeploymentTargetLink')).toHaveLength(1);
            expect(reads.filter(read => read.model === 'DeploymentTargetLink')).toMatchObject([{ args: { take: 2 } }]);
            expect(reads.filter(read => read.model === 'Artifact')).toHaveLength(1);
            expect(reads.filter(read => read.model === 'Artifact')).toMatchObject([
                { args: { select: { body: false } } },
            ]);
            const second = await list({ serverId, scope: accountScope, limit: 1, cursor: page.nextCursor });
            expect(second.statusCode, second.body).toBe(200);
            expect(second.json()).toMatchObject({ items: [{ targetLink: { id: b.link.id } }], nextCursor: null, coverage: 'complete' });
            const teamPage = await list({ serverId, scope: { kind: 'team', teamId: team.id } });
            expect(teamPage.statusCode, teamPage.body).toBe(200);
            expect(teamPage.json().items.map((item: { targetLink: { id: string } }) => item.targetLink.id)).toEqual([shared.link.id]);
            expect(first.body + second.body + teamPage.body).not.toContain(hidden.link.id);
            expect(first.body + second.body + teamPage.body).not.toContain('private-never-list');
            const wrongHome = await list({ serverId: `srv_${'a'.repeat(32)}`, scope: accountScope });
            expect(wrongHome.statusCode).toBe(404);
            const wrongScope = await list({ serverId, scope: { kind: 'account', accountId: outsider.id } });
            expect(wrongScope.statusCode).toBe(404);
            const deniedTeam = await list({ serverId, scope: { kind: 'team', teamId: team.id } }, outsider.id);
            expect(deniedTeam.statusCode).toBe(404);
            await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
            const incomplete = await list({ serverId, scope: accountScope });
            expect(incomplete.statusCode, incomplete.body).toBe(200);
            expect(incomplete.json()).toMatchObject({ items: [], nextCursor: null, coverage: 'partial' });
            expect(incomplete.body).not.toContain(a.link.id);
        });
    });

    it.each([
        { count: 1, state: 'succeeded' as const, baseline: false, domain: undefined },
        { count: 2, state: 'succeeded' as const, baseline: false, domain: undefined },
        { count: 2, state: 'succeeded' as const, baseline: false, domain: 'up' },
        { count: 2, state: 'succeeded' as const, baseline: false, domain: 'down' },
        { count: 2, state: 'succeeded' as const, baseline: false, domain: 'pending' },
        { count: 2, state: 'running_unverified' as const, baseline: false, domain: 'up' },
        { count: 2, state: 'running_unverified' as const, baseline: false, domain: 'down' },
        { count: 2, state: 'running_unverified' as const, baseline: false, domain: 'pending' },
        { count: 1, state: 'failed' as const, baseline: false }, { count: 1, state: 'outcome_unknown' as const, baseline: false },
        { count: 2, state: 'failed' as const, baseline: true },
    ])('requires ingress admission and successful release settlement ($count members, $state, baseline=$baseline, domain=$domain)', async ({ count, state, baseline, domain }) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = count === 2 && !baseline ? await db.team.create({ data: { name: 'Shared native rollout' } }) : null;
        if (team) await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const custodian = team ? await db.account.create({ data: { encryptionMode: 'plain' } }) : owner;
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: crypto.randomUUID(),
            ...(team ? { owner: { kind: 'team' as const, teamId: team.id } } : {}),
            name: 'Joining proof', audience: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/joining', cloneUrl: 'https://github.com/owner/joining.git' }, protocol: 'https',
            } }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const members = await Promise.all(Array.from({ length: count }, (_, index) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: index === 0 ? owner.id : custodian.id, installationId: crypto.randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'Release member', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/release', happyHomeDir: '/home/release/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationPublicKey: new Uint8Array(keys.publicKey),
        } })));
        const first = members[0]!;
        const builder = count === 2 && !baseline ? await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, installationId: crypto.randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'Release builder', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/release', happyHomeDir: '/home/release/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationPublicKey: new Uint8Array(keys.publicKey),
        } }) : first;
        if (team) await db.machineTeamGrant.createMany({ data: [...members, builder].map(machine => ({
            machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: machine.accountId,
        })) });
        async function artifact(kind: string, value: unknown) {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Joining proof' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            if (team) await db.artifactTeamGrant.create({ data: { artifactId: created.artifact.id, teamId: team.id,
                accessLevel: 'admin', createdByAccountId: owner.id } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: first.id, buildMachineId: builder.id, ...await artifact('deployment-environment.v1', {}),
        } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
            state: 'configured', ...await artifact('deployment-target-link.v1', {}), machines: { create: members.map((member, position) => ({
                machineId: member.id, installationId: member.installationId!, position, state: baseline ? 'active' : 'joining',
            })) },
        } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const actionOperationId = crypto.randomUUID();
        const basis = createDeploymentReceiptDetailV1();
        let uniformId: string | undefined;
        let originalArtifact: Awaited<ReturnType<typeof db.artifact.findUniqueOrThrow>> | undefined;
        if (baseline) {
            uniformId = crypto.randomUUID();
            const uniformContent = { ...basis.content, machines: members.map(member => member.id), buildMachineId: first.id,
                machineResults: members.map(member => ({ machineId: member.id, installationId: member.installationId!,
                    steps: [], currentDeploymentId: uniformId, activation: 'succeeded', health: 'healthy' })) };
            const uniformRef = await artifact('deployment-receipt.v1', uniformContent);
            await db.deployment.create({ data: { id: uniformId, environmentId: environment.id, targetLinkId: link.id,
                requestedByAccountId: owner.id, operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), ...uniformRef } });
            await db.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: uniformId } });
            originalArtifact = await db.artifact.findUniqueOrThrow({ where: { id: uniformRef.contentArtifactId } });
            await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                requestedByAccountId: owner.id, operation: 'deploy', state: 'failed', requestKey: crypto.randomUUID(),
                predecessorDeploymentId: uniformId, actionOperationId: crypto.randomUUID(),
                ...await artifact('deployment-receipt.v1', { ...uniformContent, onFailure: 'keepPartial',
                    machineResults: uniformContent.machineResults.map((result, index) => ({ ...result,
                        currentDeploymentId: index === 0 ? 'partial-v2' : uniformId,
                        activation: index === 0 ? 'succeeded' : 'failed' })) }),
            } });
        }
        const content = { ...basis.content, machines: members.map(member => member.id), buildMachineId: builder.id,
            machineResults: members.map(member => ({ machineId: member.id, installationId: member.installationId!,
                steps: [], actionOperationId, ...(uniformId ? { currentDeploymentId: uniformId } : {}), activation: 'succeeded', health: 'healthy',
                ...(baseline ? { restoration: 'succeeded' } : {}) })),
        };
        const receiptReference = await artifact('deployment-receipt.v1', content);
        const input = { serverId, environmentId: environment.id, targetLinkId: link.id, expectedRevision: environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(), ...receiptReference };
        const target = { kind: 'machine' as const, machineId: first.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId, accountId: owner.id,
            authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch }, actionId: 'deployments.deploy',
            machineId: first.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const path = `/v1/deployments/environments/${environment.id}/deploy`;
        const payload = { ...input, actionOperationId };
        const admitted: ReturnType<typeof DeploymentReceiptResultV1Schema.parse>[] = [];
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: path, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
                    installationId: first.installationId!, requestId: envelope.requestId, method: 'POST', path,
                    body: payload, privateKey: keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            admitted.push(DeploymentReceiptResultV1Schema.parse(response.json()));
        }, { authentication: 'real' });
        const reserved = admitted[0];
        if (!reserved?.ok || !('deploymentId' in reserved)) throw new Error('Expected captured release receipt');
        const stage = { serverId, environmentId: environment.id, deploymentId: reserved.deploymentId,
            expectedRevision: reserved.deploymentRevision, actionOperationId, machineId: first.id,
            installationId: first.installationId!, kind: 'stage' as const, state: 'running' as const };
        expect(await inTx(tx => transitionDeploymentInTx(tx, owner.id, { ...stage,
            proof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: { version: 1, accountId: owner.id,
                machineId: first.id, installationId: first.installationId!, deploymentTransition: {
                    serverId, environmentId: environment.id, deploymentId: reserved.deploymentId, actionOperationId,
                    expectedRevision: reserved.deploymentRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(stage),
                } } }) }))).toMatchObject({ ok: true, state: 'running' });
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: reserved.deploymentId } });
        expect(receipt).toMatchObject({ acceptedControllerMachineId: first.id, acceptedControllerInstallationId: first.installationId,
            acceptedBuildMachineId: builder.id, acceptedBuildInstallationId: builder.installationId });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
            deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId,
            machineId: first.id, installationId: first.installationId!, kind: 'settle', state,
            ...(baseline ? {} : { expectedTargetLinkRevision: link.revision }),
        };
        const proof = signMachineInstallationProof({ payload: { version: 1, accountId: owner.id,
            machineId: first.id, installationId: first.installationId!, deploymentTransition: { serverId,
                environmentId: environment.id, deploymentId: receipt.id, actionOperationId,
                expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) },
        }, privateKey: keys.secretKey });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            if (domain) {
                const domainId = crypto.randomUUID();
                const created = await app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${environment.id}/domains`, headers: { 'x-test-user-id': owner.id },
                    payload: { serverId, environmentId: environment.id, domainId,
                        expectedRevision: (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision,
                        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
                        actionOperationId, requestId: crypto.randomUUID(), ...await artifact('deployment-domain.v1', {}),
                        placements: members.map(member => ({ machineId: member.id, installationId: member.installationId!,
                            nativeServer: 'private', dockerEngineId: 'membership-engine', listener: 'privateOrigin' })) } });
                expect(created.statusCode, created.body).toBe(200);
                let added = DeploymentDomainMutationResultV1Schema.parse(created.json());
                if (!added.ok) throw new Error(added.error);
                if (domain === 'up') {
                    const observations = added.domain.placements!.map(capture => {
                        const observation = { capture, state: 'active' as const, dnsHealth: { status: 'up' as const,
                            evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'dns' },
                                author: { kind: 'process' as const }, text: 'Existing healthy route' }] } } };
                        return { ...observation, proof: signMachineInstallationProof({ privateKey: keys.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: added.domain.revision, observation }) }) };
                    });
                    const active = await app.inject({ method: 'POST', headers: { 'x-test-user-id': owner.id },
                        url: `/v1/deployments/environments/${environment.id}/domains/${domainId}/transitions`,
                        payload: { serverId, environmentId: environment.id, domainId, expectedDomainRevision: added.domain.revision, observations } });
                    expect(active.statusCode, active.body).toBe(200);
                    added = DeploymentDomainMutationResultV1Schema.parse(active.json());
                    if (!added.ok) throw new Error(added.error);
                    const prepared = { serverId, environmentId: environment.id, domainId,
                        expectedRevision: added.revision, expectedDomainRevision: added.domain.revision,
                        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
                        contentArtifactId: added.domain.contentArtifactId, contentHeaderVersion: added.domain.contentHeaderVersion,
                        contentBodyVersion: added.domain.contentBodyVersion, membershipDeploymentId: receipt.id,
                        membershipMachines: members.map(member => ({ machineId: member.id, installationId: member.installationId! })) };
                    const verifyChild = (params: DeploymentChildRpcV1) => {
                        const method = `${params.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId = crypto.randomUUID();
                        const deploymentChildRouting = projectDeploymentChildRoutingV1(params);
                        const execution = { v: 1 as const, authorization, effectActionId: 'deployments.domains.add', target,
                            installationId: first.installationId!, deploymentChildRouting,
                            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                                effectActionId: 'deployments.domains.add', target, installationId: first.installationId!, method,
                                requestId, params, deploymentChildRouting, privateKey: keys.secretKey }) };
                        return verifyExternalActionMachineRpcExecution(execution,
                            { method, requestId, params, originalActionEnvelope: envelope });
                    };
                    const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
                        input: prepared, machineId: members[1]!.id, installationId: members[1]!.installationId! });
                    expect(await verifyChild(discovery)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domainDiscover' } } });
                    expect(await verifyChild(DeploymentChildRpcV1Schema.parse({ ...discovery,
                        input: { ...prepared, membershipDeploymentId: 'wrong-receipt' } }))).toBeNull();
                    expect(await verifyChild({ ...discovery, installationId: 'wrong-installation' })).toBeNull();
                    await withAuthenticatedTestApp(registerDeploymentRoutes, async real => {
                        const path = `/v1/deployments/environments/${environment.id}/domains`;
                        const reconcile = (change: Partial<typeof prepared> = {}) => {
                            const payload = { ...prepared, ...change, requestId: envelope.requestId, actionOperationId,
                                placements: members.map(member => ({ machineId: member.id, installationId: member.installationId!,
                                    nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'membership-engine' })) };
                            return real.inject({ method: 'POST', url: path, payload, headers: {
                                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.domains.add',
                                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                                    effectActionId: 'deployments.domains.add', target, installationId: first.installationId!,
                                    requestId: envelope.requestId, method: 'POST', path, body: payload, privateKey: keys.secretKey }),
                            } });
                        };
                        for (const change of [{ membershipDeploymentId: 'foreign-receipt' },
                            { membershipMachines: [{ machineId: first.id, installationId: 'wrong-installation' }] }]) {
                            const denied = await reconcile(change);
                            expect(denied.statusCode, denied.body).toBe(403);
                        }
                        const reconciled = await reconcile();
                        expect(reconciled.statusCode, reconciled.body).toBe(200);
                        added = DeploymentDomainMutationResultV1Schema.parse(reconciled.json());
                    }, { authentication: 'real' });
                    if (!added.ok) throw new Error(added.error);
                    expect(added.domain.placements!.every(capture => capture.placement.requestId === envelope.requestId)).toBe(true);
                    const capture = added.domain.placements!.find(capture => capture.placement.machineId === members[1]!.id)!;
                    const native = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.add',
                        input: { serverId, environmentId: environment.id, domainId }, expectedDomainRevision: added.domain.revision,
                        actionOperationId, capture, machineId: capture.placement.machineId, installationId: capture.placement.installationId });
                    expect(await verifyChild(native)).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'domain' } } });
                }
                if (domain !== 'pending') {
                    const observations = added.domain.placements!.map(capture => {
                        const observation = { capture, state: 'active' as const,
                            dnsHealth: { status: domain === 'up' ? 'up' as const : 'down' as const, evidence: { v: 1 as const,
                                items: [{ source: { kind: 'alert' as const, label: 'dns' }, author: { kind: 'process' as const }, text: 'Membership DNS observation' }] } } };
                        return { ...observation, proof: signMachineInstallationProof({ privateKey: keys.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: added.domain.revision, observation }) }) };
                    });
                    const observed = await app.inject({ method: 'POST', headers: { 'x-test-user-id': owner.id },
                        url: `/v1/deployments/environments/${environment.id}/domains/${domainId}/transitions`,
                        payload: { serverId, environmentId: environment.id, domainId, expectedDomainRevision: added.domain.revision, observations } });
                    expect(observed.statusCode, observed.body).toBe(200);
                }
            }
            if (count === 2 && !baseline) {
                const { expectedTargetLinkRevision, ...stageBasis } = body;
                for (const signer of [members[1]!, builder]) {
                    const signed = async (change: Pick<DeploymentTransitionInputV1, 'kind' | 'state'> & Partial<Pick<DeploymentTransitionInputV1, 'expectedTargetLinkRevision' | 'teardownProof'>>,
                        expectedRevision = receipt.revision) => {
                        const memberBody = { ...stageBasis, ...change, expectedRevision,
                            machineId: signer.id, installationId: signer.installationId! };
                        return app.inject({ method: 'POST',
                            url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                            headers: { 'x-test-user-id': owner.id }, payload: { ...memberBody,
                                proof: signMachineInstallationProof({ payload: { version: 1, accountId: owner.id,
                                    machineId: signer.id, installationId: signer.installationId!, deploymentTransition: {
                                        serverId, environmentId: environment.id, deploymentId: receipt.id, actionOperationId,
                                        expectedRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(memberBody),
                                    } }, privateKey: keys.secretKey }),
                            } });
                    };
                    const stage = await signed({ kind: 'stage', state: 'running' });
                    expect(stage.statusCode, stage.body).toBe(200);
                    if (team) {
                        await db.machineTeamGrant.deleteMany({ where: { machineId: signer.id, teamId: team.id } });
                        const withdrawn = await signed({ kind: 'stage', state: 'running' });
                        expect(withdrawn.statusCode, 'captured work continues after grant withdrawal').toBe(200);
                        await db.machineTeamGrant.create({ data: { machineId: signer.id, teamId: team.id,
                            accessLevel: 'view', createdByAccountId: signer.accountId } });
                    }
                    const malformedStage = await signed({ kind: 'stage', state: 'failed' });
                    expect(malformedStage.statusCode, malformedStage.body).toBe(400);
                    for (const change of [
                        { kind: 'settle' as const, state: 'failed' as const },
                        { kind: 'settle' as const, state: 'outcome_unknown' as const },
                        { kind: 'settle' as const, state: 'succeeded' as const, expectedTargetLinkRevision },
                        { kind: 'settle' as const, state: 'succeeded' as const, teardownProof: {
                            targetLinkRevision: link.revision,
                            machines: [{ machineId: signer.id, installationId: signer.installationId! }],
                            workloadAbsent: true, retainedProviderResource: false,
                            steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'],
                        } satisfies NonNullable<DeploymentTransitionInputV1['teardownProof']> },
                    ]) {
                        const refused = await signed(change);
                        expect(refused.statusCode, refused.body).toBe(403);
                        expect(refused.json()).toMatchObject({ error: 'deployment_access_denied' });
                        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } }))
                            .toMatchObject({ state: 'running', revision: receipt.revision });
                        expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).activeDeploymentId).toBeNull();
                    }
                    const stale = await signed({ kind: 'stage', state: 'running' }, receipt.revision + 1);
                    expect(stale.statusCode, stale.body).toBe(409);
                }
            }
            const settled = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id }, payload: { ...body, proof } });
            const successful = (state === 'succeeded' || state === 'running_unverified') && (!domain || domain === 'up');
            expect(settled.statusCode, settled.body).toBe(domain === 'down' || domain === 'pending' ? 409 : successful || baseline ? 200 : 400);
            expect((await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId: link.id } })).map(member => member.state))
                .toEqual(Array.from({ length: count }, () => baseline || successful ? 'active' : 'joining'));
            expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).activeDeploymentId)
                .toBe(uniformId ?? (successful ? receipt.id : null));
            if (!successful && !baseline) expect((await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe('running');
            if (baseline && originalArtifact) {
                expect((await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe('failed');
                expect(await db.artifact.findUniqueOrThrow({ where: { id: originalArtifact.id } })).toEqual(originalArtifact);
            }
            if (domain === 'up') {
                const currentLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
                const operation = crypto.randomUUID();
                const teardownInput = { serverId, environmentId: environment.id, targetLinkId: link.id,
                    expectedRevision: (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision,
                    expectedTargetLinkRevision: currentLink.revision, requestKey: crypto.randomUUID(), reason: 'manual' as const,
                    machines: [members[1]!.id], ...await artifact('deployment-receipt.v1', {}) };
                const teardownEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: teardownInput };
                const teardownAuthorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                    accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
                    actionId: 'deployments.teardown', machineId: first.id, target, requestId: teardownEnvelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(teardownEnvelope) }, { input: teardownInput });
                await withAuthenticatedTestApp(registerDeploymentRoutes, async real => {
                    const invoke = (path: string, effectActionId: 'deployments.teardown' | 'deployments.domains.add', payload: unknown) =>
                        real.inject({ method: 'POST', url: path, payload, headers: {
                            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: teardownAuthorization.token,
                            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                                authorizationToken: teardownAuthorization.token, effectActionId, target,
                                installationId: first.installationId!, requestId: teardownEnvelope.requestId,
                                method: 'POST', path, body: payload, privateKey: keys.secretKey }),
                        } });
                    const accepted = await invoke(`/v1/deployments/environments/${environment.id}/teardown`,
                        'deployments.teardown', { ...teardownInput, actionOperationId: operation });
                    expect(accepted.statusCode, accepted.body).toBe(200);
                    const reserved = DeploymentReceiptResultV1Schema.parse(accepted.json());
                    if (!reserved.ok || !('deploymentId' in reserved)) throw new Error('Expected selective teardown receipt');
                    const selected = { machineId: members[1]!.id, installationId: members[1]!.installationId! };
                    expect((await db.deployment.findUniqueOrThrow({ where: { id: reserved.deploymentId } })).teardownProof)
                        .toEqual({ admittedMachines: [selected] });
                    const domainRow = await db.deploymentDomain.findFirstOrThrow({ where: { environmentId: environment.id } });
                    expect(domainRow.state).toBe('active');
                    const transition = async (input: Omit<DeploymentTransitionInputV1, 'proof'>) => app.inject({ method: 'POST',
                        url: `/v1/deployments/environments/${environment.id}/deployments/${reserved.deploymentId}/transitions`,
                        headers: { 'x-test-user-id': owner.id }, payload: { ...input,
                            proof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: { version: 1,
                                accountId: owner.id, machineId: first.id, installationId: first.installationId!, deploymentTransition: {
                                    serverId, environmentId: environment.id, deploymentId: reserved.deploymentId,
                                    actionOperationId: operation, expectedRevision: input.expectedRevision,
                                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(input) } } }) } });
                    const stage = { serverId, environmentId: environment.id, deploymentId: reserved.deploymentId,
                        actionOperationId: operation, expectedRevision: reserved.deploymentRevision, machineId: first.id,
                        installationId: first.installationId!, kind: 'stage' as const, state: 'running' as const };
                    const running = await transition(stage);
                    expect(running.statusCode, running.body).toBe(200);
                    const runningReceipt = DeploymentReceiptResultV1Schema.parse(running.json());
                    if (!runningReceipt.ok || !('deploymentRevision' in runningReceipt)) throw new Error('Expected running teardown');
                    const teardownProof: NonNullable<DeploymentTransitionInputV1['teardownProof']> = { targetLinkRevision: currentLink.revision, machines: [selected], workloadAbsent: true,
                        retainedProviderResource: false,
                        steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] };
                    const settle = { ...stage, expectedRevision: runningReceipt.deploymentRevision, kind: 'settle' as const,
                        state: 'succeeded' as const, teardownProof };
                    const premature = await transition(settle);
                    expect(premature.statusCode, premature.body).toBe(409);
                    expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).activeDeploymentId).toBe(receipt.id);
                    const domainInput = { serverId, environmentId: environment.id, domainId: domainRow.id,
                        targetLinkId: link.id, expectedTargetLinkRevision: currentLink.revision,
                        expectedRevision: (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision,
                        expectedDomainRevision: domainRow.revision, contentArtifactId: domainRow.contentArtifactId,
                        contentHeaderVersion: domainRow.contentHeaderVersion, contentBodyVersion: domainRow.contentBodyVersion,
                        membershipDeploymentId: reserved.deploymentId,
                        membershipMachines: [{ machineId: first.id, installationId: first.installationId! }],
                        requestKey: crypto.randomUUID(), requestId: teardownEnvelope.requestId, actionOperationId: operation,
                        placements: [{ machineId: first.id, installationId: first.installationId!, nativeServer: 'private' as const,
                            listener: 'privateOrigin' as const, dockerEngineId: 'membership-engine' }] };
                    const domainPath = `/v1/deployments/environments/${environment.id}/domains`;
                    const wrongScope = await invoke(domainPath, 'deployments.domains.add', { ...domainInput, membershipMachines: [selected] });
                    expect(wrongScope.statusCode, wrongScope.body).toBe(403);
                    const reconciled = await invoke(domainPath, 'deployments.domains.add', domainInput);
                    expect(reconciled.statusCode, reconciled.body).toBe(200);
                    const changed = DeploymentDomainMutationResultV1Schema.parse(reconciled.json());
                    if (!changed.ok) throw new Error(changed.error);
                    expect(changed.domain.placements!.some(capture => !capture.desired && capture.placement.machineId === selected.machineId)).toBe(true);
                    const observations = changed.domain.placements!.map(capture => {
                        const ids = nativeCaddyDomainRouteIdsV1(domainRow.id, capture.listener);
                        const observation = capture.desired ? { capture, state: 'active' as const, dnsHealth: { status: 'up' as const,
                            evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'dns' },
                                author: { kind: 'process' as const }, text: 'Remaining route healthy' }] } } }
                            : { capture, state: 'removed' as const, removal: { kind: 'removed' as const,
                                placement: capture.placement, routeIds: ids.removalIds, proof: { version: 1 as const, algorithm: 'ed25519' as const,
                                    signature: encodeBase64(nacl.sign.detached(nativeCaddyRemovalSigningBytes(capture.placement,
                                        ids.removalIds), keys.secretKey), 'base64url') } } };
                        return { ...observation, proof: signMachineInstallationProof({ privateKey: keys.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: changed.domain.revision, observation }) }) };
                    });
                    const observed = await app.inject({ method: 'POST', headers: { 'x-test-user-id': owner.id },
                        url: `${domainPath}/${domainRow.id}/transitions`, payload: { serverId, environmentId: environment.id,
                            domainId: domainRow.id, expectedDomainRevision: changed.domain.revision, observations } });
                    expect(observed.statusCode, observed.body).toBe(200);
                    const persisted = await db.deploymentDomain.findUniqueOrThrow({ where: { id: domainRow.id } });
                    expect(persisted).toMatchObject({ state: 'active', capturedPlacements: [{ desired: true,
                        placement: { machineId: first.id, installationId: first.installationId! } }] });
                    expect(Array.isArray(persisted.capturedPlacements) && persisted.capturedPlacements.length).toBe(1);
                    const completed = await transition(settle);
                    expect(completed.statusCode, completed.body).toBe(200);
                    expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } }))
                        .toMatchObject({ activeDeploymentId: receipt.id, revision: currentLink.revision });
                }, { authentication: 'real' });
            }
        });
    });

    it('keeps proved common installations active, admits only new joining members and retains custody on an unproved removal', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Membership', audience: [], owner: { kind: 'account', accountId: owner.id },
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/membership', cloneUrl: 'https://github.com/owner/membership.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machines = await Promise.all(['a', 'b', 'd'].map(label => db.machine.create({ data: {
            id: `${label}-${crypto.randomUUID()}`, accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Membership', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: crypto.randomUUID(),
        } })));
        async function artifact(kind: string, value: unknown = {}) {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Membership' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machines[0]!.id, buildMachineId: machines[0]!.id,
            ...await artifact('deployment-environment.v1'),
        } });
        const content = await artifact('deployment-target-link.v1');
        const memberInputs = machines.map(machine => ({ machineId: machine.id, installationId: machine.installationId! }));
        const previous = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...content,
            machines: { create: memberInputs.slice(0, 2).map((member, position) => ({ ...member, position, state: 'active' })) },
        } });
        const uniformId = crypto.randomUUID();
        const uniformBasis = createDeploymentReceiptDetailV1().content;
        const uniform = await db.deployment.create({ data: { id: uniformId, environmentId: environment.id, targetLinkId: previous.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1', { ...uniformBasis,
                machines: machines.slice(0, 2).map(machine => machine.id), buildMachineId: machines[0]!.id,
                machineResults: memberInputs.slice(0, 2).map(member => ({ ...member, steps: [], activation: 'succeeded',
                    health: 'healthy', currentDeploymentId: uniformId })),
            }),
        } });
        await db.deploymentTargetLink.update({ where: { id: previous.id }, data: { activeDeploymentId: uniform.id } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: previous.id } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
                targetId: 'own-server', role: 'runtime', requestKey: crypto.randomUUID(), machines: memberInputs,
                replacesLinkId: previous.id, expectedTargetLinkRevision: previous.revision, ...content };
            const url = `/v1/deployments/environments/${environment.id}/targets`;
            const added = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(added.statusCode, added.body).toBe(200);
            const selected = DeploymentTargetLinkResultV1Schema.parse(added.json());
            if (!selected.ok) throw new Error(selected.error);
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, selected.targetLinkId))).toMatchObject({
                machines: memberInputs.map(member => member.machineId), predecessorTargetLinkId: previous.id, activeDeploymentId: uniform.id,
                members: memberInputs.map((member, index) => ({ ...member, state: index === 2 ? 'joining' : 'active' })),
            });
            const replay = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(selected);
            const read = await app.inject({ method: 'GET', url: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json().targetLinks.map((link: { id: string }) => link.id).sort()).toEqual([previous.id, selected.targetLinkId].sort());
            const rollbackContent = await artifact('deployment-receipt.v1', { ...uniformBasis,
                machines: memberInputs.map(member => member.machineId), buildMachineId: machines[0]!.id, machineResults: [] });
            const rollback = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/rollback`,
                headers: { 'x-test-user-id': owner.id }, payload: { serverId, environmentId: environment.id,
                    expectedRevision: selected.revision, targetLinkId: selected.targetLinkId, expectedTargetLinkRevision: selected.targetLinkRevision,
                    deploymentId: uniform.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...rollbackContent } });
            expect(rollback.statusCode, 'an older receipt is admitted against all current runtime members').toBe(200);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: rollback.json().deploymentId } })).toMatchObject({
                rollbackOfDeploymentId: uniform.id, targetLinkId: selected.targetLinkId, predecessorDeploymentId: uniform.id,
            });
            await db.deployment.update({ where: { id: rollback.json().deploymentId }, data: { state: 'failed' } });
            const survivors = [memberInputs[0]!, memberInputs[2]!];
            const moved = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': owner.id }, payload: {
                ...input, expectedRevision: (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision,
                requestKey: crypto.randomUUID(), replacesLinkId: selected.targetLinkId,
                expectedTargetLinkRevision: selected.targetLinkRevision, machines: survivors,
            } });
            expect(moved.statusCode, moved.body).toBe(200);
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, moved.json().targetLinkId))).toMatchObject({
                predecessorTargetLinkId: selected.targetLinkId, machines: survivors.map(member => member.machineId),
                activeDeploymentId: uniform.id,
                members: survivors.map((member, index) => ({ ...member, state: index === 0 ? 'active' : 'joining' })),
            });
            expect(await inTx(tx => readDeploymentTargetInTx(tx, environment.id, selected.targetLinkId)))
                .toMatchObject({ machines: memberInputs.map(member => member.machineId), activeDeploymentId: uniform.id });
            // Selection transfers common members; it never releases the omitted
            // installation. Only the physical disposition owner can do that.
            const unlink = await app.inject({ method: 'POST',
                url: `${url}/${selected.targetLinkId}/unlink`, headers: { 'x-test-user-id': owner.id }, payload: {
                    serverId, environmentId: environment.id, targetLinkId: selected.targetLinkId,
                    expectedRevision: moved.json().revision, expectedTargetLinkRevision: selected.targetLinkRevision,
                    requestKey: crypto.randomUUID(),
                } });
            expect(unlink.statusCode, unlink.body).toBe(409);
            expect(unlink.json()).toMatchObject({ ok: false, error: 'deployment_teardown_required' });
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: selected.targetLinkId } }))
                .toMatchObject({ deletedAt: null, detachedAt: null });

        });
    });
});
