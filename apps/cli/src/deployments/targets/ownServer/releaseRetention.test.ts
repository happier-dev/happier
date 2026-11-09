import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OwnServerDeploymentInputBasisV1Schema, type OwnServerDeploymentSourceV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as installationStore from '@/daemon/identity/store';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { resolveNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { resolveDeploymentSourcePathForHost, resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';
import { createOwnServerSourceRetention, projectOwnServerDeploymentRetention, pruneOwnServerDeploymentSource } from './releaseRetention';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentRequest } from './ownServerDeploymentTarget';

const file = (relativePath: string, bytes: string) => ({ kind: 'file' as const, relativePath, sizeBytes: Buffer.byteLength(bytes),
    executable: false, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });

function retentionRecords() {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0].targetLink;
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: { v: 1,
        controller: { machineId: 'machine-a', installationId: 'installation-a' },
        builder: { machineId: 'machine-a', installationId: 'installation-a' } } });
    const approvedInputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1, environmentId: environment.environment.id,
        environmentRevision: environment.environment.revision, targetLinkId: link.id, targetLinkRevision: link.revision,
        sourceIntent: receipt.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
        physicalProjectName: 'project', toolVersion: '2.40.1', services: ['app'], profiles: [], bindings: [],
        images: receipt.content.images, ownServer: environment.content.ownServer,
        members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })) });
    return { environment, link, receipt, approvedInputBasis };
}

it('applies retention zero, one and greater while keeping the uniform and unsettled predecessor sources', () => {
    const { environment, link, receipt, approvedInputBasis } = retentionRecords();
    const older = ['older-1', 'older-2'].map((id, index) => {
        const previous = createDeploymentReceiptDetailV1();
        previous.deployment = { ...previous.deployment, id, requestedAtMs: index + 1 };
        previous.content.machineResults = [];
        previous.content.ownServer = { approvedInputBasis, sources: [{ machineId: 'machine-a', installationId: 'installation-a',
            deploymentId: id, role: 'runtime', rootFingerprint: 'root', manifestFingerprint: 'manifest', manifestEntries: [], sharedBinds: [] }] };
        return previous;
    });
    for (const [retain, expired] of [[0, ['older-1', 'older-2']], [1, ['older-1']], [2, []]] as const) {
        environment.content.retainPreviousDeployments = retain;
        expect(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: [receipt, ...older] }).expiredSources
            .map(source => source.deploymentId)).toEqual(expired);
    }
    environment.content.retainPreviousDeployments = 0;
    const pending = createDeploymentReceiptDetailV1();
    pending.deployment = { ...pending.deployment, id: 'pending', state: 'running', predecessorDeploymentId: 'older-1' };
    expect(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: [receipt, ...older, pending] }).expiredSources
        .map(source => source.deploymentId)).toEqual(['older-2']);
});

it('protects exact uniform, mixed, retained and unsettled image custody and refuses an incomplete protection basis', () => {
    const { environment, link, receipt } = retentionRecords();
    environment.content.retainPreviousDeployments = 1;
    link.activeDeploymentId = 'uniform';
    const records = ['uniform', 'mixed', 'retained', 'expired', 'pending', 'predecessor'].map((id, index) => {
        const row = structuredClone(receipt);
        row.deployment = { ...row.deployment, id, requestedAtMs: id === 'retained' ? 100 : index,
            state: id === 'pending' ? 'outcome_unknown' : id === 'mixed' ? 'failed' : 'succeeded',
            ...(id === 'pending' ? { predecessorDeploymentId: 'predecessor' } : {}) };
        row.content.machineResults = id === 'mixed' ? [{ machineId: link.members[0].machineId,
            installationId: link.members[0].installationId, steps: [], activation: 'succeeded', health: 'healthy',
            currentDeploymentId: id }] : [];
        row.content.images = ['linux/amd64', 'linux/arm64'].map((platform, platformIndex) => ({
            service: 'app', platform, configDigest: `sha256:${String(index + 1).repeat(64)}`,
            manifestDigest: `sha256:${String(platformIndex + 7).repeat(64)}`,
        }));
        return row;
    });
    const settled = records.filter(row => row.deployment.id !== 'pending');
    const protectedRecords = settled.filter(row => ['uniform', 'mixed', 'retained'].includes(row.deployment.id));
    const protection = projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: settled }).imageProtection;
    expect(protection).toEqual({ status: 'complete', images: protectedRecords.flatMap(row => row.content.images.map(image => ({
        deploymentId: row.deployment.id, image,
        ...resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', environment.environment.id),
            deploymentId: row.deployment.id, image }),
    }))) });
    const expiredRecords = settled.filter(row => !protectedRecords.includes(row));
    expect(Reflect.get(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: settled }), 'expiredImages'))
        .toEqual(expiredRecords.flatMap(row => row.content.images.map(image => ({ deploymentId: row.deployment.id, image,
            ...resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', environment.environment.id),
                deploymentId: row.deployment.id, image }),
        }))));
    // Initial reviewed images are nonempty before a build's final platform
    // outputs exist. They must not make unknown native custody pruneable.
    expect(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: records }).imageProtection)
        .toEqual({ status: 'unavailable', deploymentIds: ['pending'] });
    // Missing baseline content is not evidence that its CONFIG/tags are safe to prune.
    expect(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link,
        receipts: settled.filter(row => row.deployment.id !== 'uniform') }).imageProtection)
        .toEqual({ status: 'unavailable', deploymentIds: ['uniform'] });
    const beforeBuild = records.map(row => row.deployment.id === 'pending'
        ? { ...row, content: { ...row.content, images: [] } } : row);
    expect(projectOwnServerDeploymentRetention({ serverId: 'home', environment, link, receipts: beforeBuild }).imageProtection)
        .toEqual({ status: 'unavailable', deploymentIds: ['pending'] });
});

it('admits retention once across unrelated edits and refuses a changed active release at acquisition or overlapping native work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retention-cost-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const originalSettingsFile = Object.getOwnPropertyDescriptor(configuration, 'settingsFile')!;
    const { environment, link, receipt, approvedInputBasis } = retentionRecords();
    environment.content.retainPreviousDeployments = 0;
    try {
        const tools = await createOwnServerDockerBoundary(join(root, 'tools'));
        vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        Object.defineProperty(configuration, 'happyHomeDir', { configurable: true, value: root });
        Object.defineProperty(configuration, 'settingsFile', { configurable: true, value: join(root, 'settings.json') });
        const profile = await addServerProfile({ name: 'home', serverUrl: 'https://home.test', webappUrl: 'https://home.test' });
        const homeServerIdentityId = 'srv_retention_home';
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation-a', publicKey: 'installed-public-key', privateKey: 'unused-by-retention' });
        const placement = { deploymentRoot: join(root, 'servers', 'home', 'deployments'),
            environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environment.environment.id),
            deploymentId: 'old', materializationRole: 'build' as const };
        const sourceRoot = resolveDeploymentSourcePathForHost(placement);
        await mkdir(sourceRoot, { recursive: true });
        const manifestEntries = Array.from({ length: 256 }, (_, index) => file(`input-${index}`, 'source'));
        const writeSources = async () => { for (const entry of manifestEntries) await writeFile(join(sourceRoot, entry.relativePath), 'source'); };
        await writeSources();
        const source: OwnServerDeploymentSourceV1 = { machineId: 'machine-a', installationId: 'installation-a', deploymentId: 'old', role: 'build',
            rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceRoot)), manifestFingerprint: 'manifest', sharedBinds: [], manifestEntries };
        const old = createDeploymentReceiptDetailV1();
        old.deployment = { ...old.deployment, id: 'old', requestedAtMs: 1 };
        const logRoot = resolveDeploymentSourcePathForHost({ deploymentRoot: placement.deploymentRoot,
            environmentInstanceId: placement.environmentInstanceId, deploymentId: 'old' });
        await mkdir(join(logRoot, '.happier'), { recursive: true });
        await writeFile(join(logRoot, '.happier/deploy.log'), 'redacted builder output');
        await writeFile(join(logRoot, '.happier/foreign'), 'foreign bytes');
        old.content.ownServer = { approvedInputBasis, sources: [source], stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a',
            relativePath: '.happier/deploy.log' }] };
        let environmentBodies = 0, receiptBodies = 0, historyReads = 0, headerReads = 0;
        let advanceUnrelatedRevision = true;
        const host: OwnServerDeploymentTargetHostInput = {
            credentials: { token: 'unused-by-retention', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            async readEnvironment() { environmentBodies++; return structuredClone(environment); },
            async readReceipt() { receiptBodies++; return structuredClone(receipt); },
            async readRetentionHeaders() {
                headerReads++;
                if (advanceUnrelatedRevision) {
                    environment.environment.revision++;
                    advanceUnrelatedRevision = false;
                }
                return structuredClone({ environment: environment.environment, deployment: receipt.deployment, link });
            },
            async *readBuildHistory() { historyReads++; yield structuredClone(receipt); yield structuredClone(old); },
            async writeTransition() { throw new Error('Terminal retention has no receipt writer'); },
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'unused-by-retention', encryption: null },
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
                async acquirePluginRuntimeRegistryLease() { throw new Error('Retention has no plugin/source/secret acquisition'); } }),
        };
        const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
            input: { serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                requestKey: receipt.deployment.requestKey, contentArtifactId: receipt.deployment.contentArtifactId,
                contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
            receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'succeeded' },
            context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
        const input = { request, machineId: 'machine-a', installationId: 'installation-a', settledTargetLinkRevision: link.revision,
            settledDeploymentRevision: receipt.deployment.revision, activeDeploymentId: receipt.deployment.id };
        const retention = createOwnServerSourceRetention(host);
        expect(await retention.retain(input)).toMatchObject({ ok: true });
        expect({ environmentBodies, receiptBodies, historyReads }).toEqual({ environmentBodies: 1, receiptBodies: 1, historyReads: 1 });
        expect(headerReads).toBe(1);
        await expect(readFile(join(sourceRoot, 'input-255'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(logRoot, '.happier/deploy.log'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(logRoot, '.happier/foreign'), 'utf8')).toBe('foreign bytes');
        expect((await tools.readInvocations()).filter(value => value.args[0] === 'ps')).toHaveLength(1);
        await writeSources();
        await machineNativeEffectAdmission.run({ operation: { operationId: 'other-activation', kind: 'deployments.deploy' },
            keys: [{ kind: 'dockerEngine', dockerEndpoint: 's0-docker-engine' }] }, async () => {
            await expect(retention.retain(input)).rejects.toMatchObject({ code: 'effect_in_progress' });
        });
        expect(await readFile(join(sourceRoot, 'input-0'), 'utf8')).toBe('source');
        // A new phase observes the new serving release before retiring any bytes.
        link.activeDeploymentId = 'new-serving-release';
        await expect(retention.retain(input)).rejects.toMatchObject({ code: 'deployment_conflict' });
        expect(await readFile(join(sourceRoot, 'input-0'), 'utf8')).toBe('source');
        expect(await readFile(join(sourceRoot, 'input-1'), 'utf8')).toBe('source');
    } finally {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        Object.defineProperty(configuration, 'happyHomeDir', originalHome);
        Object.defineProperty(configuration, 'settingsFile', originalSettingsFile);
        await rm(root, { recursive: true, force: true });
    }
});

it('retires only unchanged manifest leaves and the exact operation log while preserving mounted and runtime bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-retention-'));
    try {
        const placement = { deploymentRoot: root, environmentInstanceId: 'environment', deploymentId: 'old' };
        const sourceRoot = resolveDeploymentSourcePathForHost(placement);
        await mkdir(join(sourceRoot, 'mounted'), { recursive: true });
        await mkdir(join(sourceRoot, 'redirected'));
        await mkdir(join(sourceRoot, '.happier'));
        for (const path of ['compose.yaml', 'data.sqlite', 'mounted/config', 'redirected/input']) await writeFile(join(sourceRoot, path), 'source');
        await symlink('compose.yaml', join(sourceRoot, 'source-link'));
        await writeFile(join(sourceRoot, '.happier/deploy.log'), 'redacted operation output');
        const log = { machineId: 'machine', installationId: 'installation', relativePath: '.happier/deploy.log' as const };
        const source: OwnServerDeploymentSourceV1 = { machineId: 'machine', installationId: 'installation', deploymentId: 'old', role: 'runtime',
            rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceRoot)), manifestFingerprint: 'manifest', sharedBinds: [],
            manifestEntries: [file('compose.yaml', 'source'), file('data.sqlite', 'source'),
                { kind: 'directory', relativePath: 'mounted' }, file('mounted/config', 'source'),
                { kind: 'directory', relativePath: 'redirected' }, file('redirected/input', 'source'),
                { kind: 'symlink', relativePath: 'source-link', target: 'compose.yaml' }] };
        await writeFile(join(sourceRoot, 'data.sqlite'), 'application row');
        await writeFile(join(sourceRoot, 'runtime-data'), 'application data');
        await writeFile(join(sourceRoot, '.happier/foreign'), 'foreign operation data');
        await rename(join(sourceRoot, 'redirected'), join(root, 'foreign'));
        await symlink(join(root, 'foreign'), join(sourceRoot, 'redirected'), 'dir');
        const result = await pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [join(sourceRoot, 'mounted')],
            operationLog: log, async assertCurrent() {} });
        expect(result.removed).toEqual(['compose.yaml', 'source-link', '.happier/deploy.log']);
        expect(result.kept).toEqual(['data.sqlite', 'mounted/config', 'redirected/input']);
        expect(await readFile(join(sourceRoot, 'data.sqlite'), 'utf8')).toBe('application row');
        expect(await readFile(join(sourceRoot, 'runtime-data'), 'utf8')).toBe('application data');
        expect(await readFile(join(sourceRoot, 'mounted/config'), 'utf8')).toBe('source');
        expect(await readFile(join(root, 'foreign/input'), 'utf8')).toBe('source');
        expect(await readFile(join(sourceRoot, '.happier/foreign'), 'utf8')).toBe('foreign operation data');
        expect(await readlink(join(sourceRoot, 'redirected'))).toBe(join(root, 'foreign'));
        expect(await pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [join(sourceRoot, 'mounted')],
            operationLog: log, async assertCurrent() {} })).toMatchObject({ removed: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('rechecks source bytes and root custody while retiring the pinned operation-log path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retention-fence-'));
    try {
        const placement = { deploymentRoot: root, environmentInstanceId: 'environment', deploymentId: 'old' };
        const sourceRoot = resolveDeploymentSourcePathForHost(placement);
        await mkdir(join(sourceRoot, '.happier'), { recursive: true });
        await writeFile(join(sourceRoot, 'compose.yaml'), 'source');
        await writeFile(join(sourceRoot, '.happier/deploy.log'), 'original log');
        const operationLog = { machineId: 'machine', installationId: 'installation', relativePath: '.happier/deploy.log' as const };
        const source: OwnServerDeploymentSourceV1 = { machineId: 'machine', installationId: 'installation', deploymentId: 'old', role: 'runtime',
            rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceRoot)), manifestFingerprint: 'manifest',
            sharedBinds: [], manifestEntries: [file('compose.yaml', 'source')] };
        await rename(join(sourceRoot, '.happier/deploy.log'), join(root, 'old-log'));
        await writeFile(join(sourceRoot, '.happier/deploy.log'), 'replacement');
        let admitted = false;
        const result = await pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [], operationLog,
            async assertCurrent() {
                if (admitted) await writeFile(join(sourceRoot, 'compose.yaml'), 'new application bytes');
                admitted = true;
            } });
        expect(result.removed).toEqual(['.happier/deploy.log']);
        expect(result.kept).toEqual(['compose.yaml']);
        expect(await readFile(join(sourceRoot, 'compose.yaml'), 'utf8')).toBe('new application bytes');
        await expect(readFile(join(sourceRoot, '.happier/deploy.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(root, 'old-log'), 'utf8')).toBe('original log');
        await rename(sourceRoot, join(root, 'original-root'));
        await mkdir(sourceRoot);
        await writeFile(join(sourceRoot, 'compose.yaml'), 'foreign occupant');
        await expect(pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [], async assertCurrent() {} }))
            .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
        expect(await readFile(join(sourceRoot, 'compose.yaml'), 'utf8')).toBe('foreign occupant');
    } finally { await rm(root, { recursive: true, force: true }); }
});
