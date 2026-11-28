import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OwnServerDeploymentInputBasisV1Schema, type DeploymentReceiptDetailV1, type OwnServerDeploymentSourceV1 } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as installationStore from '@/daemon/identity/store';
import * as rootIdentity from '@/workspaces/sync/workspaceSyncRootIdentity';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { resolveNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { resolveDeploymentSourcePathForHost, resolveOwnServerDeploymentEnvironmentInstanceIdForHost, resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createOwnServerSourceRetention, projectOwnServerDeploymentRetention, projectOwnServerEnvironmentRemovalArchiveOrigins, pruneOwnServerDeploymentSource } from './releaseRetention';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { resolveOwnServerImageArchivePathForHost } from './releaseProvenance';
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

// SEC-DELETE-ARCHIVES-1126: a Production promoted from a staging release keeps restoring from that
// release's holder archive after staging's own retention window has passed it.
it.each(['staging-only', 'promoted-to-production'] as const)('keeps the serving image and History rollback window after successive native settlements: %s', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'happier-release-images-'));
    // Home's live references for staging's history: Production descends from release-0.
    const liveReferences = scenario === 'promoted-to-production' ? ['release-0'] : [];
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const originalSettingsFile = Object.getOwnPropertyDescriptor(configuration, 'settingsFile')!;
    const { environment, link, receipt: initial, approvedInputBasis } = retentionRecords();
    const history: DeploymentReceiptDetailV1[] = [];
    const imageIds: string[] = [];
    const departedProjects: string[] = [];
    const archivePaths: string[] = [];
    let receipt = initial;
    try {
        const tools = await createOwnServerDockerBoundary(join(root, 'tools'));
        vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        Object.defineProperty(configuration, 'happyHomeDir', { configurable: true, value: root });
        Object.defineProperty(configuration, 'settingsFile', { configurable: true, value: join(root, 'settings.json') });
        const profile = await addServerProfile({ name: 'home', serverUrl: 'https://home.test', webappUrl: 'https://home.test' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: 'srv_retention_home', canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation-a', publicKey: 'installed-public-key', privateKey: 'unused-by-retention' });
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root,
            serverId: 'home', environmentId: environment.environment.id });
        await mkdir(identity.deploymentRoot, { recursive: true });
        const credentials = { token: 'unused-by-retention', encryption: null };
        const host: OwnServerDeploymentTargetHostInput = {
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            async readEnvironment() { return structuredClone(environment); },
            async readReceipt() { return structuredClone(receipt); },
            async readRetentionHeaders() {
                return structuredClone({ environment: environment.environment, deployment: receipt.deployment, link });
            },
            async *readBuildHistory(request) {
                if (request.liveReferences) {
                    for (const id of liveReferences) request.liveReferences.ids.add(id);
                    request.liveReferences.complete = true;
                }
                for (const row of history) yield structuredClone(row);
            },
            async writeTransition() { throw new Error('Terminal retention has no receipt writer'); },
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home',
                serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                async acquirePluginRuntimeRegistryLease() { throw new Error('Retention has no plugin/source/secret acquisition'); } }),
        };
        const retention = createOwnServerSourceRetention(host);
        const windowSize = environment.content.retainPreviousDeployments;
        for (let index = 0; index < windowSize + 4; index++) {
            receipt = structuredClone(initial);
            const deploymentId = `release-${index}`;
            receipt.deployment = { ...receipt.deployment, id: deploymentId, requestedAtMs: index + 1 };
            receipt.content.images = [await tools.registerImage('app', deploymentId)];
            receipt.content.machineResults = receipt.content.machineResults.map(row => ({ ...row, currentDeploymentId: deploymentId }));
            receipt.deployment = { ...receipt.deployment, environmentId: environment.environment.id, targetLinkId: link.id };
            history.push(receipt);
            link.activeDeploymentId = deploymentId;
            const image = receipt.content.images[0]!;
            const archiveHash = createHash('sha256').update(deploymentId).digest('hex');
            const archive = resolveOwnServerImageArchivePathForHost({ ...identity, deploymentId }, archiveHash);
            await mkdir(archive.rootPath, { recursive: true });
            await writeFile(archive.path, deploymentId);
            archivePaths.push(archive.path);
            receipt.content.ownServer = { approvedInputBasis, imageArchives: [{ sha256: archiveHash, image,
                sizeBytes: deploymentId.length, holder: { ...archive, serverId: identity.homeServerIdentityId,
                    machineId: 'machine-a', installationId: 'installation-a' } }] };
            const refs = resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: identity.environmentInstanceId,
                deploymentId, image });
            imageIds.push(await tools.setImagePruneState(image.configDigest, { repoTags: [refs.ownedTag, refs.activationRef], repoDigests: [] }));
            const expiredIndex = index - windowSize - 1;
            if (expiredIndex >= 0) {
                const project = resolveNativeComposeCandidateProjectName(identity.projectName, history[expiredIndex]!.deployment.id);
                await tools.setImageContainerReference(imageIds[expiredIndex]!, 'exited', project);
                departedProjects.push(project);
            }
            const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
                input: { serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                    requestKey: receipt.deployment.requestKey, contentArtifactId: receipt.deployment.contentArtifactId,
                    contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
                receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId, deploymentRevision: receipt.deployment.revision, state: 'succeeded' },
                context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
            expect(await retention.retain({ request, machineId: 'machine-a', installationId: 'installation-a',
                settledTargetLinkRevision: link.revision, settledDeploymentRevision: receipt.deployment.revision,
                activeDeploymentId: deploymentId })).toMatchObject({ ok: true });
            expect([...(await tools.readPruneImageIds())].sort()).toEqual(imageIds.slice(-windowSize - 1).sort());
            if (index === windowSize + 3) {
                const expired = history[0]!;
                const expiredImage = await tools.registerImage('app', 'in-use-expired');
                expired.content.images = [expiredImage];
                const reference = resolveNativeComposeDeploymentImageReferences({ environmentInstanceId: identity.environmentInstanceId,
                    deploymentId: expired.deployment.id, image: expiredImage }).ownedTag;
                const nativeId = await tools.setImagePruneState(expiredImage.configDigest, { repoTags: [reference], repoDigests: [] });
                await tools.setImageContainerReference(nativeId, 'running', 'unrelated-persistent-project');
                expect(await retention.retain({ request, machineId: 'machine-a', installationId: 'installation-a',
                    settledTargetLinkRevision: link.revision, settledDeploymentRevision: receipt.deployment.revision,
                    activeDeploymentId: deploymentId })).toMatchObject({ ok: true,
                    nativeCleanupWarnings: [{ machineId: 'machine-a', code: 'image_removal_failed' }] });
                expect(await tools.readPruneReference(reference)).toBe(nativeId);
            }
            for (const project of departedProjects) expect(await tools.readContainerIds(project)).toEqual([]);
            for (const [releaseIndex, archive] of archivePaths.entries()) {
                if (releaseIndex <= expiredIndex && !liveReferences.includes(history[releaseIndex]!.deployment.id)) {
                    await expect.soft(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' });
                }
                else await expect.soft(readFile(archive, 'utf8')).resolves.toBe(history[releaseIndex]!.deployment.id);
            }
        }
    } finally {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        Object.defineProperty(configuration, 'happyHomeDir', originalHome);
        Object.defineProperty(configuration, 'settingsFile', originalSettingsFile);
        await rm(root, { recursive: true, force: true });
    }
});

it('selects Environment Delete archive origins only from a complete live-reference set', () => {
    const header = (id: string, change: Partial<ReturnType<typeof createDeploymentReceiptHeaderV1>> = {}) =>
        createDeploymentReceiptHeaderV1({ id, ...change });
    const headers = [header('teardown', { operation: 'teardown', state: 'running' }), header('abandoned'), header('promoted'),
        header('stuck', { state: 'outcome_unknown', predecessorDeploymentId: 'stuck-predecessor' }), header('stuck-predecessor')];
    const select = (complete: boolean) => projectOwnServerEnvironmentRemovalArchiveOrigins({ headers, teardownDeploymentId: 'teardown',
        liveReferences: { ids: new Set(['promoted']), complete } });
    expect(select(true)).toEqual(['abandoned']);
    expect(select(false)).toEqual([]);
});

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

it('keeps the newest attempt log for investigation without retaining its expired release or earlier failed logs', () => {
    const { environment, link, receipt, approvedInputBasis } = retentionRecords();
    environment.content.retainPreviousDeployments = 0;
    const failed = ['earlier-failure', 'latest-failure'].map((id, index) => {
        const value = structuredClone(receipt);
        value.deployment = { ...value.deployment, id, state: 'failed' as const,
            requestedAtMs: receipt.deployment.requestedAtMs + index + 1 };
        value.content.machineResults = [];
        value.content.ownServer = { approvedInputBasis, stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a',
            relativePath: '.happier/deploy.log' }], sources: [{ machineId: 'machine-a', installationId: 'installation-a',
            deploymentId: id, role: 'runtime', rootFingerprint: 'root', manifestFingerprint: 'manifest', manifestEntries: [], sharedBinds: [] }] };
        return value;
    });
    const result = projectOwnServerDeploymentRetention({ serverId: 'home', environment, link,
        receipts: [failed[0]!, receipt, failed[1]!] });
    expect(result.expiredLogs.map(value => value.deploymentId)).toEqual(['earlier-failure']);
    expect(result.expiredSources.map(value => value.deploymentId)).toEqual(['earlier-failure', 'latest-failure']);
    expect(result.expiredImages.map(value => value.deploymentId)).toEqual(['earlier-failure', 'latest-failure']);
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
        await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
        await mkdir(join(sourceRoot, 'nested'));
        const manifestEntries = [{ kind: 'directory' as const, relativePath: 'nested' },
            ...Array.from({ length: 256 }, (_, index) => file(`nested/input-${index}`, 'source'))];
        const writeSources = async () => {
            await mkdir(sourceRoot, { recursive: true });
            await mkdir(join(sourceRoot, 'nested'), { recursive: true });
            for (const entry of manifestEntries) {
                if (entry.kind === 'file') await writeFile(join(sourceRoot, entry.relativePath), 'source');
            }
        };
        await writeSources();
        const source: OwnServerDeploymentSourceV1 = { machineId: 'machine-a', installationId: 'installation-a', deploymentId: 'old', role: 'build',
            rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceRoot)), manifestFingerprint: 'manifest', sharedBinds: [], manifestEntries };
        const old = createDeploymentReceiptDetailV1();
        old.deployment = { ...old.deployment, id: 'old', requestedAtMs: 1 };
        const logRoot = resolveDeploymentSourcePathForHost({ deploymentRoot: placement.deploymentRoot,
            environmentInstanceId: placement.environmentInstanceId, deploymentId: 'old' });
        await mkdir(join(logRoot, '.happier'), { recursive: true, mode: 0o700 });
        await writeFile(join(logRoot, '.happier/deploy.log'), 'redacted builder output');
        await writeFile(join(logRoot, '.happier/foreign'), 'foreign bytes');
        old.content.ownServer = { approvedInputBasis, sources: [source], stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a',
            relativePath: '.happier/deploy.log' }] };
        const pending = createDeploymentReceiptDetailV1();
        pending.deployment = { ...pending.deployment, id: 'pending', state: 'outcome_unknown', requestedAtMs: 3 };
        const referenced = createDeploymentReceiptDetailV1();
        referenced.deployment = { ...referenced.deployment, id: 'pending-predecessor', requestedAtMs: 2 };
        pending.deployment.predecessorDeploymentId = referenced.deployment.id;
        const putLog = async (record: DeploymentReceiptDetailV1) => {
            const path = join(resolveDeploymentSourcePathForHost({ ...placement,
                deploymentId: record.deployment.id, materializationRole: undefined }), '.happier', 'deploy.log');
            await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
            await writeFile(path, record.deployment.id);
            return { path, log: { machineId: 'machine-a', installationId: 'installation-a',
                relativePath: '.happier/deploy.log' as const } };
        };
        const putArchive = async (record: DeploymentReceiptDetailV1) => {
            const id = record.deployment.id;
            const sha256 = createHash('sha256').update(id).digest('hex');
            const archive = resolveOwnServerImageArchivePathForHost({ ...placement, deploymentId: id }, sha256);
            await mkdir(archive.rootPath, { recursive: true });
            await writeFile(archive.path, id);
            return { sha256, image: receipt.content.images[0]!, sizeBytes: id.length,
                holder: { ...archive, serverId: homeServerIdentityId, machineId: 'machine-a', installationId: 'installation-a' } };
        };
        const older = createDeploymentReceiptDetailV1();
        older.deployment = { ...older.deployment, id: 'older', requestedAtMs: 0 };
        const olderLog = await putLog(older);
        older.content.ownServer = { approvedInputBasis, stageLogs: [olderLog.log] };
        const pendingLog = await putLog(pending);
        const referencedLog = await putLog(referenced);
        const oldArchive = await putArchive(old);
        const referencedArchive = await putArchive(referenced);
        old.content.ownServer.imageArchives = [oldArchive, referencedArchive];
        pending.content.ownServer = { approvedInputBasis, stageLogs: [pendingLog.log] };
        referenced.content.ownServer = { approvedInputBasis, stageLogs: [referencedLog.log] };
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
            async *readBuildHistory(request) {
                historyReads++;
                if (request.liveReferences) request.liveReferences.complete = true;
                for (const row of [receipt, old, older, pending, referenced]) yield structuredClone(row);
            },
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
        await expect(readdir(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(logRoot, '.happier/deploy.log'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readdir(join(olderLog.path, '../..'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readdir(join(logRoot, '..'))).resolves.toHaveLength(3);
        await expect(readFile(pendingLog.path, 'utf8')).resolves.toBe('pending');
        await expect(readFile(referencedLog.path, 'utf8')).resolves.toBe('pending-predecessor');
        await expect(readFile(oldArchive.holder.path)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(referencedArchive.holder.path, 'utf8')).resolves.toBe('pending-predecessor');
        expect(await readFile(join(logRoot, '.happier/foreign'), 'utf8')).toBe('foreign bytes');
        const listings = (await tools.readInvocations()).filter(value => value.args[0] === 'ps');
        expect(listings.filter(value => value.args.includes('status=exited'))).toHaveLength(1);
        expect(listings.filter(value => !value.args.includes('status=exited'))).toHaveLength(1);
        await writeSources();
        await machineNativeEffectAdmission.run({ operation: { operationId: 'other-activation', kind: 'deployments.deploy' },
            keys: [{ kind: 'dockerEngine', dockerEndpoint: 's0-docker-engine' }] }, async () => {
            await expect(retention.retain(input)).rejects.toMatchObject({ code: 'effect_in_progress' });
        });
        expect(await readFile(join(sourceRoot, 'nested/input-0'), 'utf8')).toBe('source');
        // A new phase observes the new serving release before retiring any bytes.
        link.activeDeploymentId = 'new-serving-release';
        await expect(retention.retain(input)).rejects.toMatchObject({ code: 'deployment_conflict' });
        expect(await readFile(join(sourceRoot, 'nested/input-0'), 'utf8')).toBe('source');
        expect(await readFile(join(sourceRoot, 'nested/input-1'), 'utf8')).toBe('source');
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
        await writeFile(join(sourceRoot, 'compose.yaml'), 'new application bytes');
        const result = await pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [], operationLog,
            async assertCurrent() {} });
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

it('admits the root once while pruning 50 manifest leaves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retention-count-'));
    try {
        const placement = { deploymentRoot: root, environmentInstanceId: 'environment', deploymentId: 'old' };
        const sourceRoot = resolveDeploymentSourcePathForHost(placement);
        await mkdir(sourceRoot, { recursive: true });
        const manifestEntries = Array.from({ length: 50 }, (_, index) => file(`input-${index}`, 'source'));
        await Promise.all(manifestEntries.map(entry => writeFile(join(sourceRoot, entry.relativePath), 'source')));
        const source: OwnServerDeploymentSourceV1 = { machineId: 'machine', installationId: 'installation',
            deploymentId: 'old', role: 'runtime', rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceRoot)),
            manifestFingerprint: 'manifest', sharedBinds: [], manifestEntries };
        const fingerprint = vi.spyOn(rootIdentity, 'computeWorkspaceSyncRootFingerprint');
        const assertCurrent = vi.fn(async () => {});
        try {
            expect((await pruneOwnServerDeploymentSource({ ...placement, source, nativeBindSources: [], assertCurrent })).removed).toHaveLength(50);
            expect.soft(assertCurrent).toHaveBeenCalledTimes(1);
            expect(fingerprint).toHaveBeenCalledTimes(1);
        } finally { fingerprint.mockRestore(); }
    } finally { await rm(root, { recursive: true, force: true }); }
});
