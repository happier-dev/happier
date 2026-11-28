import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDataTeardownContentV1Schema, readDeploymentReceiptActionFactsV1 } from '@happier-dev/deployments/contracts/v1';
import { projectDeploymentReceiptFactsV1, projectDeploymentReceiptHistoryEntryV1, selectDeploymentReceiptRetainedHistoryV1 } from './deploymentReceiptFacts';

describe('receipt facts', () => {
    it.each(['running', 'failed'] as const)('carries controller and %s member step timing through the parsed history read', async state => {
        const { DeploymentReceiptHistoryV1Schema } = await import('@happier-dev/deployments/contracts/v1');
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.steps = [{ id: 'prepare', label: 'Prepare', state: 'succeeded', startedAtMs: 100, settledAtMs: 200, durationMs: 100 }];
        receipt.content.machineResults = [{ machineId: 'machine-a', installationId: 'installation-a',
            steps: [{ id: 'activate', label: 'Activate', state, startedAtMs: 200 }],
            activation: 'pending', health: 'unknown' }];
        const facts = projectDeploymentReceiptHistoryEntryV1(receipt);
        const page = DeploymentReceiptHistoryV1Schema.parse({ ok: true, nextCursor: null,
            items: [{ ...receipt.deployment, steps: facts.steps }] });
        expect(page.items[0]?.steps).toEqual([
            { id: 'prepare', label: 'Prepare', state: 'succeeded', startedAtMs: 100, settledAtMs: 200, durationMs: 100 },
            { id: 'activate', label: 'Activate', state, startedAtMs: 200, machineId: 'machine-a' },
        ]);
    });
    it('projects historical Machines from opened receipt content without consulting current placement', () => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.machines = ['former-runtime'];
        receipt.content.buildMachineId = 'former-builder';
        receipt.deployment.acceptedExecution = { v: 1,
            controller: { machineId: 'former-controller', installationId: 'install-controller' } };
        expect(projectDeploymentReceiptHistoryEntryV1(receipt).machineIds)
            .toEqual(['former-runtime', 'former-builder', 'former-controller']);
    });
    it.each([
        { phase: 'restore', restoration: 'succeeded', health: 'unverified', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unhealthy', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'failed', health: 'unknown', expected: { kind: 'failed' } },
        { phase: 'activate', restoration: 'outcome_unknown', health: 'unknown', expected: { kind: 'outcome_unknown' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unknown', expected: { kind: 'outcome_unknown' } },
        { phase: 'activate', restoration: 'succeeded', health: 'unverified', expected: { kind: 'succeeded', health: 'unverified' } },
        { phase: 'activate', restoration: 'succeeded', health: 'healthy', expected: { kind: 'succeeded', health: 'healthy' } },
    ] as const)('projects one restoration consequence from phase=$phase, restoration=$restoration and health=$health', ({ phase, restoration, health, expected }) => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.failure = { code: 'deployment_failed', phase };
        receipt.content.machineResults = receipt.content.machines.map(machineId => ({ machineId, installationId: 'installation-a',
            steps: [], activation: 'failed', restoration, health }));
        expect(projectDeploymentReceiptFactsV1(receipt).restoration).toEqual(expected);
        receipt.content.machineResults = [...receipt.content.machineResults,
            { machineId: 'second-machine', installationId: 'installation-b', steps: [], activation: 'failed', health: 'unknown' }];
        receipt.content.machines = [...receipt.content.machines, 'second-machine'];
        if (expected.kind === 'succeeded') expect(projectDeploymentReceiptFactsV1(receipt).restoration).toEqual({ kind: 'outcome_unknown' });
    });

    it('projects observed platform addresses and the existing log reference without native stage files', () => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.ownServer = undefined;
        receipt.content.platform = { targetLinkRevision: 1,
            credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'inspect' }, purpose: 'deploy' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
            providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, observation: { v: 1, state: 'succeeded', observedAtMs: 1,
                providerDeploymentId: 'dpl_exact', urls: ['https://app-exact.vercel.app'],
                builtInUrls: ['https://app.vercel.app'] } };
        receipt.deployment.acceptedExecution = undefined;
        expect(projectDeploymentReceiptFactsV1(receipt).logs).toEqual([{ scope: 'operation', excerpt: null, reference: {
            kind: 'build', environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
            targetLinkId: receipt.deployment.targetLinkId } }]);
        expect(projectDeploymentReceiptFactsV1(receipt)).toMatchObject({ urls: ['https://app-exact.vercel.app'],
            builtInUrls: ['https://app.vercel.app'] });
        receipt.content.platform.observation.builtInUrls = [];
        expect(projectDeploymentReceiptFactsV1(receipt).builtInUrls).toEqual([]);
        delete receipt.content.platform.observation.builtInUrls;
        expect(projectDeploymentReceiptFactsV1(receipt).builtInUrls).toBeNull();
    });

    it.each([{ builtSha: 'b'.repeat(40) }, { builtSha: undefined }])('labels Pages Git History and private Action investigation with the observed built commit $builtSha', async ({ builtSha }) => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.ownServer = undefined;
        receipt.content.sourceMethod = 'gitIntegration';
        receipt.content.commitSubject = 'Requested commit';
        receipt.content.platform = {
            targetLinkRevision: 1,
            credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'happier.deploy-cloudflare', localId: 'deploy' }, purpose: 'deploy' },
                target: { kind: 'account', account: { service: { pluginId: 'happier.deploy-cloudflare', localId: 'account' }, accountId: 'provider' } } },
            providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'native', selection: { kind: 'production' } },
            preparedNative: { projectName: 'project', pages: { projectMode: 'gitIntegration', productionBranch: 'main' } },
            observation: { v: 1, state: 'succeeded', observedAtMs: 1, builtSha,
                volumeRemoval: { kind: 'kept', otherEnvironments: 2, url: 'https://railway.com/project/example' } },
        };

        expect(projectDeploymentReceiptHistoryEntryV1(receipt)).toMatchObject({
            source: builtSha ? { kind: 'repository', sha: builtSha } : null,
            historyTitle: builtSha?.slice(0, 7) ?? null,
        });
        expect(receipt.content.sourceIntent).toMatchObject({ kind: 'repository', sha: 'a'.repeat(40) });
        const investigation = await readDeploymentReceiptActionFactsV1({ ok: true, deployment: receipt.deployment }, {
            deploymentId: receipt.deployment.id, projection: 'investigation',
        }, async () => receipt);
        const { DeploymentReceiptGetResultV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
        expect(DeploymentReceiptGetResultV1Schema.parse(investigation)).toMatchObject({ investigation: {
            sourceLabel: builtSha ? { kind: 'repository', sha: builtSha } : null,
            volumeRemoval: receipt.content.platform.observation.volumeRemoval,
        } });
        receipt.content.sourceMethod = 'upload';
        expect(projectDeploymentReceiptHistoryEntryV1(receipt).historyTitle).toBe('aaaaaaa · Requested commit');
    });

    it('projects failed controller build output before a provider deployment exists', async () => {
        const { DeploymentContentV1Schema } = await import('@happier-dev/deployments/contracts/v1');
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment.state = 'failed';
        receipt.content = DeploymentContentV1Schema.parse({ sourceIntent: receipt.content.sourceIntent, sourceMethod: 'upload',
            machines: [], images: [], machineResults: [], steps: [], failure: { code: 'deployment_failed', phase: 'build' },
            platform: { targetLinkRevision: 1, providerEnvironment: { kind: 'native', selection: { kind: 'production' } },
                credentialPrincipal: { kind: 'account', accountId: 'actor',
                    purpose: { consumer: { pluginId: 'acme.alpha', localId: 'upload' }, purpose: 'deploy' },
                    target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
                providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
                observation: { v: 1, state: 'queued', observedAtMs: 1 }, stageLogs: [{ machineId: 'controller', installationId: 'install',
                    relativePath: '.happier/deploy.log', excerpt: { text: 'stdout\\nstderr\\n', truncated: false },
                    steps: [{ ref: 'build', range: { start: 0, end: null } }] }] } });
        expect(projectDeploymentReceiptFactsV1(receipt)).toMatchObject({ failure: { phase: 'build' },
            logs: [{ excerpt: { text: 'stdout\\nstderr\\n', truncated: false }, reference: {
                kind: 'build', machineId: 'controller', installationId: 'install', deploymentId: receipt.deployment.id } }],
            stageLogs: [{ ref: 'build', reference: { ref: 'build', machineId: 'controller' } }] });
    });

    it('says where a receipt ran from its target kind: a platform keeps its own releases, so no Machine keep count (COR4B ui-60)', () => {
        const machine = createDeploymentReceiptDetailV1();
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'serving' });
        const retainedHistory = { receipt: machine.deployment, items: [{ ...machine.deployment, source: projectDeploymentReceiptFactsV1(machine).source }],
            complete: true, runtime, targetLinks: [runtime], retainPreviousDeployments: 0 };
        expect(projectDeploymentReceiptFactsV1(machine, retainedHistory)).toMatchObject({ placement: 'machine', retainedPreviousCount: 0 });
        const platform = createDeploymentReceiptDetailV1();
        platform.content.ownServer = undefined;
        platform.content.platform = { targetLinkRevision: 1,
            credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'inspect' }, purpose: 'deploy' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
            providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, observation: { v: 1, state: 'succeeded', observedAtMs: 1, providerDeploymentId: 'dpl_exact' } };
        // The same history and retention setting: a platform release is not "kept on a Machine", so nothing reads "Off".
        expect(projectDeploymentReceiptFactsV1(platform, { ...retainedHistory, receipt: platform.deployment }))
            .toMatchObject({ placement: 'platform', retainedPreviousCount: null });
    });

    it('joins previous, retained count and rollback to the same history instead of captured admission and configured capacity', () => {
        const base = createDeploymentReceiptDetailV1();
        if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const sourceIntent = { ...base.content.sourceIntent, sha: 'b'.repeat(40) };
        const current = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            id: 'current', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002,
        }), content: { ...base.content, sourceIntent, ownServer: { rollbackTarget: null, approvedInputBasis: {
            v: 1, environmentId: base.deployment.environmentId, environmentRevision: 1,
            targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true },
        } } } });
        const previous = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'previous' }) });
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: current.deployment.id });
        const row = (receipt: typeof current) => ({ ...receipt.deployment, source: projectDeploymentReceiptFactsV1(receipt).source });
        const retainedHistory = { receipt: current.deployment, items: [row(current), row(previous)], complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1 };
        expect(projectDeploymentReceiptFactsV1(current, retainedHistory)).toMatchObject({
            rollbackTarget: null,
            previousVersion: { deploymentId: 'previous', revision: { kind: 'repository', sha: 'a'.repeat(40) } },
            retainedPreviousCount: 1,
            retainedRollbackTarget: { deploymentId: 'previous', revision: { kind: 'repository', sha: 'a'.repeat(40) } },
        });
        // A second receipt of the already-serving commit must not offer a rollback to that commit.
        const sameVersion = createDeploymentReceiptDetailV1({ deployment: previous.deployment, content: current.content });
        expect(projectDeploymentReceiptFactsV1(sameVersion, { ...retainedHistory, receipt: sameVersion.deployment,
            items: [row(current), row(sameVersion)] }))
            .toMatchObject({ retainedRollbackTarget: null });
        // A retention setting of one with no retained predecessor is still a first deployment.
        expect(projectDeploymentReceiptFactsV1(current, { ...retainedHistory, items: [row(current)] }))
            .toMatchObject({ previousVersion: null, retainedPreviousCount: 0, retainedRollbackTarget: null });
    });
    it('selects retained successful predecessors in order, excluding failed attempts, other links and the serving receipt', () => {
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'current' });
        const current = createDeploymentReceiptHeaderV1({ id: 'current', requestedAtMs: 2000,
            startedAtMs: 2001, settledAtMs: 2002 });
        const previous = createDeploymentReceiptHeaderV1({ id: 'previous' });
        const previousVersion = { deploymentId: previous.id, revision: { kind: 'repository' as const, sha: 'a'.repeat(40) } };
        const items = [{ ...current, source: { kind: 'repository' as const, sha: 'b'.repeat(40) } },
            createDeploymentReceiptHeaderV1({ id: 'failed', state: 'failed' }),
            createDeploymentReceiptHeaderV1({ id: 'other-link', targetLinkId: 'unrelated' }), { ...previous, source: previousVersion.revision }];
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items, complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1, placement: 'machine' }))
            .toEqual({ previousVersion, retainedPreviousCount: 1, retainedRollbackTarget: previousVersion });
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items: [current], complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1, placement: 'machine' }))
            .toEqual({ previousVersion: null, retainedPreviousCount: 0, retainedRollbackTarget: null });
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items: [current], complete: false,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1, placement: 'machine' }))
            .toEqual({ previousVersion: undefined, retainedPreviousCount: null, retainedRollbackTarget: null });
    });
    it('reports the settled serving release after a failed attempt, without treating the nearest older receipt as serving', () => {
        const receipt = createDeploymentReceiptHeaderV1({ id: 'failed', state: 'failed', requestedAtMs: 3000,
            startedAtMs: 3001, settledAtMs: 3002 });
        const nearer = { ...createDeploymentReceiptHeaderV1({ id: 'nearer', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }),
            source: { kind: 'repository' as const, sha: 'b'.repeat(40) } };
        const serving = { ...createDeploymentReceiptHeaderV1({ id: 'serving', requestedAtMs: 1000, startedAtMs: 1001, settledAtMs: 1002 }),
            source: { kind: 'repository' as const, sha: 'a'.repeat(40) } };
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: serving.id });
        const input = { receipt, items: [receipt, nearer, serving], complete: true, runtime, targetLinks: [runtime],
            retainPreviousDeployments: 2, placement: 'machine' as const };
        expect(selectDeploymentReceiptRetainedHistoryV1(input)).toMatchObject({ previousVersion: undefined,
            servingVersion: { deploymentId: serving.id, revision: serving.source } });
        const withoutServing = { ...runtime, activeDeploymentId: undefined };
        const facts = selectDeploymentReceiptRetainedHistoryV1({ ...input, runtime: withoutServing, targetLinks: [withoutServing] });
        expect(facts.previousVersion).toBeUndefined();
        expect(facts).not.toHaveProperty('servingVersion');
    });
    it('does not offer a rollback to a successful receipt whose private content was removed', () => {
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'current' });
        const current = createDeploymentReceiptHeaderV1({ id: 'current', requestedAtMs: 2000,
            startedAtMs: 2001, settledAtMs: 2002 });
        const previous = createDeploymentReceiptHeaderV1({ id: 'previous', contentArtifactId: null });
        const items = [{ ...current, source: { kind: 'repository' as const, sha: 'b'.repeat(40) } },
            { ...previous, source: { kind: 'repository' as const, sha: 'a'.repeat(40) } }];
        expect(selectDeploymentReceiptRetainedHistoryV1({ receipt: current, items, complete: true,
            runtime, targetLinks: [runtime], retainPreviousDeployments: 1, placement: 'machine' }))
            .toMatchObject({ retainedRollbackTarget: null, retainedRollbackContentMissing: 'previous' });
    });
    it('omits the serving folder manifest from retained rollback targets', () => {
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'current' });
        const current = createDeploymentReceiptHeaderV1({ id: 'current', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 });
        const previous = createDeploymentReceiptHeaderV1({ id: 'previous', requestedAtMs: 1000 });
        const folder = { kind: 'folder' as const, manifestFingerprint: 'sha256:' + 'a'.repeat(64),
            fileCount: 1, totalBytes: 10, excludedPaths: [] };
        const select = (manifestFingerprint: string) => selectDeploymentReceiptRetainedHistoryV1({
            receipt: current, items: [{ ...current, source: folder }, { ...previous, source: { ...folder, manifestFingerprint } }],
            complete: true, runtime, targetLinks: [runtime], retainPreviousDeployments: 1, placement: 'machine',
        });
        expect(select(folder.manifestFingerprint).retainedRollbackTarget).toBeNull();
        expect(select('sha256:' + 'b'.repeat(64)).retainedRollbackTarget).toMatchObject({ deploymentId: 'previous' });
    });
    it('compares stored releases by their Compose content and treats missing labels as unavailable', async () => {
        const { areDeploymentSourceLabelsEqualV1 } = await import('@happier-dev/protocol/deployments/deploymentReviewV1');
        const release = { kind: 'stored' as const, contentRevision: 1, composeDigest: 'sha256:' + 'a'.repeat(64) };
        expect(areDeploymentSourceLabelsEqualV1(release, { ...release, contentRevision: 2 })).toBe(true);
        expect(areDeploymentSourceLabelsEqualV1(release, null)).toBeNull();
    });
    it.each(['machine', 'platform'] as const)('uses %s retention when selecting a rollback with Docker retention off', placement => {
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'current' });
        const current = createDeploymentReceiptHeaderV1({ id: 'current', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 });
        const previous = createDeploymentReceiptHeaderV1({ id: 'previous', requestedAtMs: 1000 });
        const revision = { kind: 'repository' as const, sha: 'a'.repeat(40) };
        const input = { receipt: current, items: [{ ...current, source: { kind: 'repository' as const, sha: 'b'.repeat(40) } },
            { ...previous, source: revision }], complete: true, runtime, targetLinks: [runtime],
            retainPreviousDeployments: 0, placement };
        expect(selectDeploymentReceiptRetainedHistoryV1(input)).toMatchObject(placement === 'platform'
            ? { retainedPreviousCount: null, previousVersion: { deploymentId: 'previous', revision },
                retainedRollbackTarget: { deploymentId: 'previous', revision } }
            : { retainedPreviousCount: 0, previousVersion: null, retainedRollbackTarget: null });
    });
    it('names a history attempt by its revision and carries its recorded failure as a fact, never a title word', () => {
        const base = createDeploymentReceiptDetailV1();
        const failure = { code: 'native_activate_failed', phase: 'activate' } as const;
        const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }),
            content: { ...base.content, failure } });
        expect(projectDeploymentReceiptHistoryEntryV1(failed)).toMatchObject({ historyTitle: 'aaaaaaa', failure });
        expect(projectDeploymentReceiptHistoryEntryV1(base)).toMatchObject({ historyTitle: 'aaaaaaa', failure: null });
    });
    it('keeps data teardown outcome evidence without inventing an app source revision', () => {
        const receipt = createDeploymentReceiptDetailV1();
        const content = DeploymentDataTeardownContentV1Schema.parse({ machines: [], images: [], machineResults: [],
            steps: [{ id: 'delete', label: 'Delete branch', state: 'failed' }],
            platform: { credentialPrincipal: { kind: 'account', accountId: 'actor',
                purpose: { consumer: { pluginId: 'acme.alpha', localId: 'branch' }, purpose: 'account' },
                target: { kind: 'account', account: { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider' } } },
                providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'branch:A' },
                providerEnvironment: { kind: 'native', selection: { branchId: 'A' } }, targetLinkRevision: 1,
                observation: { v: 1, state: 'failed', observedAtMs: 1000 },
                dataCreation: { reference: { runId: 'run:one', invocationId: 'inv:one' }, retainedProviderResource: true,
                    deleteAction: { pluginId: 'acme.alpha', localId: 'delete' }, operands: { branchId: 'A' } } } });
        expect(projectDeploymentReceiptFactsV1({ ...receipt, content })).toMatchObject({ source: null,
            steps: [{ id: 'delete', state: 'failed' }] });
    });
});
