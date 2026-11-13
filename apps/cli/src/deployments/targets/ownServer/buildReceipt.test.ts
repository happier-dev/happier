import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, rmdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OwnServerDeploymentSourceV1 } from '@happier-dev/deployment-protocol';
import type { OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { buildOwnServerDeploymentReceipt, isOwnServerBuildReceiptComplete, requiresOwnServerBuildReceipt } from './buildReceipt';
import { withOwnServerBuildFixture as withBuilder, withNativeDependencyBuildReceipt, withOwnServerBuildChildHttpFixture } from './buildReceipt.testkit';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function verifyPublishedBuildSource(source: OwnServerDeploymentSourceV1, sourceTargetPath: string,
    receipt: OwnServerDeploymentReceipt): Promise<void> {
    expect(source).toMatchObject({ role: 'build', machineId: 'builder-c', installationId: 'installation-c',
        deploymentId: receipt.deployment.id, manifestFingerprint: receipt.content.ownServer!.approvedInputBasis.manifestFingerprint,
        rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(sourceTargetPath)), sharedBinds: [] });
    expect(source.manifestEntries.some(entry => entry.relativePath === 'compose.yaml' && entry.kind === 'file')).toBe(true);
    for (const entry of source.manifestEntries) if (entry.kind === 'file') {
        const bytes = await readFile(join(sourceTargetPath, entry.relativePath));
        expect(entry).toMatchObject({ sizeBytes: bytes.length, digest: digest(bytes) });
    }
}

describe('admitted builder receipt production', () => {
    it.each(['secret_build_argument', 'admitted_root'] as const)('retains %s through the real builder and receipt transition', async reason => {
        await withBuilder(async ({ host, request, receipt, root, deploymentRoot, environmentInstanceId, nativeRequests }) => {
            if (reason === 'admitted_root') {
                const outside = join(root, 'outside-admitted-deployments');
                await mkdir(outside);
                await mkdir(join(deploymentRoot, environmentInstanceId), { recursive: true, mode: 0o700 });
                await rmdir(join(deploymentRoot, environmentInstanceId, 'builds'));
                await symlink(outside, join(deploymentRoot, environmentInstanceId, 'builds'), process.platform === 'win32' ? 'junction' : 'dir');
            }
            const result = await buildOwnServerDeploymentReceipt(host, request);
            expect(result).toMatchObject({ ok: false, errorCode: 'invalid_request', failureCause: {
                phase: reason === 'admitted_root' ? 'workspace.materialization.admitted_root' : 'deployment.build.secret_build_argument',
            } });
            expect(receipt.content.failure).toMatchObject({ code: 'invalid_request', phase: 'build',
                failureCause: { phase: reason === 'admitted_root' ? 'workspace.materialization.admitted_root' : 'deployment.build.secret_build_argument' } });
            expect(JSON.stringify(result)).not.toContain('build-owner-secret-sentinel');
            expect(JSON.stringify(receipt.content.failure)).not.toContain(root);
            expect(nativeRequests.some(call => call.args.includes('bake') && !call.args.includes('--print'))).toBe(false);
        }, { secretBuildArgument: reason === 'secret_build_argument' });
    });
    it('executes the approved build after the trusted native tool version changes', async () => {
        await withBuilder(async ({ host, request, receipt, nativeRequests }) => {
            receipt.content.ownServer!.approvedInputBasis.toolVersion = 'reviewed-older-version';
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: true });
            expect(nativeRequests.some(call => call.args.includes('--metadata-file'))).toBe(true);
        });
    });
    it('retains the actual build reference address after preflight resolves an older address', async () => {
        await withBuilder(async ({ host, request, receipt, nativeRequests }) => {
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: true });
            const builds = nativeRequests.filter(call => call.args[0] === 'buildx' && call.args[1] === 'bake');
            const actual = builds.filter(call => !call.args.includes('--print'));
            const preflight = builds.filter(call => call.args.includes('--print')).at(-1);
            expect(actual).not.toHaveLength(0);
            const addresses = [...new Set(actual.map(call => call.env.BUILD_DATABASE_URL))];
            expect(addresses).not.toContain(undefined);
            expect(addresses).not.toContain(preflight?.env.BUILD_DATABASE_URL);
            expect(receipt.content.ownServer?.referenceAddresses).toEqual(addresses.map(address => ({
                machineId: 'builder-c', installationId: 'installation-c', phase: 'build', name: 'BUILD_DATABASE_URL',
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                address,
            })));
        }, { buildReference: true, changingBuildReference: true });
    });
    it('persists failed build diagnostics in the same protected receipt without a log read or raw error message', async () => {
        await withBuilder(async ({ host, request, receipt, boundaryActivity }) => {
            const result = await buildOwnServerDeploymentReceipt(host, request);
            expect(result).toMatchObject({ ok: false });
            if (result.ok) throw new Error('The Docker boundary must fail');
            expect(receipt.content.failure).toMatchObject({ code: result.errorCode, phase: 'build', failureCause: result.failureCause });
            expect(receipt.content.ownServer?.stageLogs?.[0]?.excerpt, JSON.stringify({ errorCode: result.errorCode,
                failure: receipt.content.failure, boundaryActivity }))
                .toMatchObject({ text: expect.stringContaining('build failed [REDACTED]'), truncated: false });
            expect(JSON.stringify(receipt.content)).not.toContain('raw-error-secret-sentinel');
            expect(boundaryActivity.receiptReads).toBe(1);
        }, { failBuild: true });
    });
    it('builds through the real child HTTP composition with one Environment and at most two receipt reads', async () => {
        await withOwnServerBuildChildHttpFixture(async ({ build, reads, receipt, activity }) => {
            const result = await build();
            expect(result, JSON.stringify({ result, reads, activity })).toMatchObject({ ok: true, state: 'running' });
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(reads.environments, JSON.stringify(reads)).toBe(1);
            expect(reads.receipts).toBeLessThanOrEqual(2);
        });
    });
    it('accepts an admitted queued build through real child HTTP composition', async () => {
        await withOwnServerBuildChildHttpFixture(async ({ build, receipt, reads, activity }) => {
            receipt.deployment.state = 'queued';
            const result = await build();
            expect(result, JSON.stringify({ result, reads, activity })).toMatchObject({ ok: true, state: 'running' });
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
        });
    });
    it('refuses an approved-input edit before publishing through real child HTTP composition', async () => {
        await withOwnServerBuildChildHttpFixture(async ({ build, receipt, reads, activity }) => {
            const images = structuredClone(receipt.content.images);
            const result = await build();
            expect(result, JSON.stringify({ result, reads, activity })).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            expect(receipt.content.images).toEqual(images);
            expect(receipt.content.ownServer?.buildSecretRevisions).toBeUndefined();
        }, { editApprovedInputBeforePublish: true });
    });
    it('completes selected prebuilt registry distribution without adopting durable archives and recovers its ACK without more native work', async () => {
        await withBuilder(async ({ host, request, receipt, boundaryActivity, nativeRequests, deploymentRoot, environmentInstanceId }) => {
            const built = await buildOwnServerDeploymentReceipt(host, request);
            expect(built, JSON.stringify({ code: 'errorCode' in built ? built.errorCode : null, boundaryActivity,
                nativePhases: nativeRequests.map(call => call.args.slice(0, 2)) })).toMatchObject({ ok: true, state: 'running' });
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(receipt.content.ownServer?.buildSecretRevisions).toEqual([]);
            expect(receipt.content.ownServer?.imageArchives ?? []).toEqual([]);
            expect(nativeRequests.filter(call => call.args[0] === 'image' && call.args[1] === 'tag')).toEqual([]);
            await expect(access(join(deploymentRoot, environmentInstanceId,
                'image-archives', receipt.deployment.id))).rejects.toMatchObject({ code: 'ENOENT' });
            const nativeWork = nativeRequests.length;
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: true, state: 'running' });
            expect(nativeRequests).toHaveLength(nativeWork);
            for (const invalid of ['pullOnly', 'otherOrigin', 'otherLink', 'missingReference', 'mutableReference'] as const) {
                const content = structuredClone(receipt.content);
                const binding = content.ownServer!.approvedInputBasis.bindings.find(row => row.purpose === 'registry');
                if (binding?.purpose !== 'registry') throw new Error('Registry fixture required');
                if (invalid === 'pullOnly') binding.access = 'pull';
                if (invalid === 'otherOrigin') binding.registryOrigin = 'https://other.example.test';
                if (invalid === 'otherLink') binding.targetLinkId = 'other-link';
                if (invalid === 'missingReference') delete content.images[0]!.registryReference;
                if (invalid === 'mutableReference') content.images[0]!.registryReference = 'example/app:latest';
                expect(isOwnServerBuildReceiptComplete(content), invalid).toBe(false);
            }
        }, { mode: 'prebuilt', registryAccess: 'pushPull' });
    });

    it('completes actual registry publication after finite native archives are disposed without requiring durable adoption', async () => {
        await withNativeDependencyBuildReceipt(async content => {
            expect(content.images.every(image => image.registryReference && image.indexDigest)).toBe(true);
            delete content.ownServer!.imageArchives;
            expect(isOwnServerBuildReceiptComplete(content)).toBe(true);
            const missingImage = structuredClone(content);
            missingImage.images.pop();
            expect(isOwnServerBuildReceiptComplete(missingImage)).toBe(false);
            const missingSecretHistory = structuredClone(content);
            missingSecretHistory.ownServer!.buildSecretRevisions!.pop();
            expect(isOwnServerBuildReceiptComplete(missingSecretHistory)).toBe(false);
        }, { publication: true });
    });

    it('keeps a dispatched receipt on its captured builder after a revision-advancing future placement edit', async () => {
        await withBuilder(async ({ host, request, receipt, environment, boundaryActivity, nativeRequests }) => {
            const capturedBuilder = receipt.content.buildMachineId;
            const capturedRevision = request.receipt.revision;
            // The network/storage fixture returns the updated row; native and
            // source admission consume its real definition and binding basis.
            environment.environment.buildMachineId = 'future-builder';
            environment.environment.revision = capturedRevision + 1;
            const result = await buildOwnServerDeploymentReceipt(host, request);
            expect(result.ok, JSON.stringify({ code: 'errorCode' in result ? result.errorCode : null, boundaryActivity,
                nativePhases: nativeRequests.map(call => call.args.slice(0, 2)) })).toBe(true);
            expect(receipt.content.buildMachineId).toBe(capturedBuilder);
            expect(receipt.content.ownServer?.imageArchives?.every(archive => archive.holder.machineId === capturedBuilder)).toBe(true);
            expect(nativeRequests.some(call => call.args.includes('--metadata-file'))).toBe(true);
        });
    });
    it.each(['definition', 'binding', 'configuration'] as const)('refuses a changed %s after acceptance before native work', async changed => {
        await withBuilder(async ({ host, request, environment, nativeRequests }) => {
            environment.environment.revision++;
            if (changed === 'definition') {
                if (environment.content.definition.kind !== 'repository' || !environment.content.definition.compose) throw new Error('Repository compose fixture required');
                environment.content.definition.compose.path = 'changed-compose.yaml';
            } else if (changed === 'binding') {
                environment.content.bindings.push({ purpose: 'variable', phase: 'build', name: 'NEW_INPUT',
                    source: { kind: 'value', value: 'changed' } });
            } else environment.content.ownServer = { ...environment.content.ownServer, rollout: 'recreate',
                autoRestorePreviousRelease: environment.content.ownServer?.autoRestorePreviousRelease === false };
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            expect(nativeRequests).toEqual([]);
        });
    });
    it('records the exact operation-owned stage log on the captured builder installation', async () => {
        await withBuilder(async ({ host, request, receipt, deploymentRoot, environmentInstanceId }) => {
            const progress: Array<{ label?: string; phase?: string }> = [];
            const progressRequest: typeof request = { ...request, context: { ...request.context,
                operationProgress: { update(value) { progress.push(value); } } } };
            const result = await buildOwnServerDeploymentReceipt(host, progressRequest);
            expect(result, JSON.stringify({ errorCode: result.ok ? null : result.errorCode,
                failure: receipt.content.failure })).toMatchObject({ ok: true });
            expect(receipt.content.ownServer).toMatchObject({ stageLogs: [{ machineId: 'builder-c',
                installationId: 'installation-c', relativePath: '.happier/deploy.log' }] });
            const output = await readFile(join(deploymentRoot, environmentInstanceId,
                'releases', receipt.deployment.id, '.happier', 'deploy.log'), 'utf8');
            expect(progress).toEqual([{ phase: 'sync', label: expect.any(String) }, { phase: 'sync', label: expect.any(String) }]);
            const sourceOutput = progress.map(value => `${value.label}\n`).join('');
            expect(output.startsWith(sourceOutput)).toBe(true);
            expect(receipt.content.ownServer?.stageLogs?.[0]?.steps).toEqual([
                { ref: 'source', range: { start: 0, end: Buffer.byteLength(sourceOutput) } },
                { ref: 'build', range: { start: Buffer.byteLength(sourceOutput), end: null } },
            ]);
            expect(output).not.toContain('build-owner-secret-sentinel');
            const excerpt = receipt.content.ownServer?.stageLogs?.[0]?.excerpt;
            expect(excerpt).toMatchObject({ truncated: false, text: output });
            expect(excerpt?.text).not.toContain('build-owner-secret-sentinel');
            expect(receipt.content.commitSubject).toBeTruthy();
            expect(await buildOwnServerDeploymentReceipt(host, progressRequest)).toMatchObject({ ok: true });
            expect(progress).toHaveLength(2);
            expect(await readFile(join(deploymentRoot, environmentInstanceId,
                'releases', receipt.deployment.id, '.happier', 'deploy.log'), 'utf8')).toBe(output);
        });
    });
    it('accepts exactly the effective service platforms produced by the runtime phase', async () => {
        await withNativeDependencyBuildReceipt(async content => {
            const basis = content.ownServer!.approvedInputBasis;
            expect(basis.runtimeProjections![0]!.platform).toBe('linux/amd64');
            expect(basis.runtimeProjections![0]!.servicePlatforms).toEqual([
                { service: 'web', platform: 'linux/arm64' }, { service: 'worker', platform: 'linux/amd64' }]);
            expect(content.images.map(({ service, platform }) => ({ service, platform }))).toEqual(basis.servicePlatforms);
            expect(isOwnServerBuildReceiptComplete(content)).toBe(true);
            const missingOverride = structuredClone(content);
            delete missingOverride.ownServer!.approvedInputBasis.runtimeProjections![0]!.servicePlatforms;
            expect(isOwnServerBuildReceiptComplete(missingOverride)).toBe(false);
        }, { effectivePlatforms: true });
    });
    it('retains native-built dependency secret history without requiring a dependency output archive', async () => {
        await withNativeDependencyBuildReceipt(async content => {
            expect(content.images.map(image => image.service)).toEqual(['web']);
            expect(content.ownServer!.buildSecretRevisions!.map(row => row.service)).toEqual(['web', 'base']);
            expect(isOwnServerBuildReceiptComplete(content)).toBe(true);
            const wrongMachine = structuredClone(content);
            wrongMachine.ownServer!.buildSecretRevisions![1]!.machineId = 'another-builder';
            expect(isOwnServerBuildReceiptComplete(wrongMachine)).toBe(false);
            const wrongInstallation = structuredClone(content);
            wrongInstallation.ownServer!.buildSecretRevisions![1]!.installationId = 'retired-installation';
            expect(isOwnServerBuildReceiptComplete(wrongInstallation)).toBe(false);
            const missingOutput = structuredClone(content);
            missingOutput.ownServer!.buildSecretRevisions!.shift();
            expect(isOwnServerBuildReceiptComplete(missingOutput)).toBe(false);
        });
    });
    it('acquires cold prebuilt images before activation on the sole builder and runtime Machine', async () => {
        await withBuilder(async ({ host, request, receipt, environment, nativeRequests }) => {
            const basis = receipt.content.ownServer!.approvedInputBasis;
            const member = { machineId: host.machineId, installationId: 'installation-c' };
            receipt.content.machines = [host.machineId];
            basis.members = [member];
            basis.runtimeProjections = [{ ...basis.runtimeProjections![0], ...member }];
            environment.targetLinks[0].targetLink.machines = [host.machineId];
            environment.targetLinks[0].targetLink.members = [{ ...member, state: 'active' }];
            const prepared = requiresOwnServerBuildReceipt(receipt.content)
                ? await buildOwnServerDeploymentReceipt(host, request) : null;
            expect(prepared, JSON.stringify({ prepared, failure: receipt.content.failure,
                native: nativeRequests.map(call => call.args.slice(0, 4)) })).toMatchObject({ ok: true, state: 'running' });
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(receipt.content.ownServer?.imageArchives).toHaveLength(2);
            expect(nativeRequests.filter(call => call.args[0] === 'image' && call.args[1] === 'pull')).toHaveLength(2);
            expect(nativeRequests.some(call => call.args.includes('--metadata-file'))).toBe(false);
        }, { mode: 'prebuilt', coldImages: true });
    });

    it.each(['mixed', 'prebuilt', 'stored', 'closure'] as const)('retains approved %s image pins while exporting every receiver platform', async mode => {
        await withBuilder(async ({ host, request, receipt, nativeRequests, boundaryActivity }) => {
            const approved = structuredClone(receipt.content.images);
            expect(requiresOwnServerBuildReceipt(receipt.content)).toBe(true);
            const built = await buildOwnServerDeploymentReceipt(host, request);
            expect(built, JSON.stringify({ code: 'errorCode' in built ? built.errorCode : null, boundaryActivity,
                nativePhases: nativeRequests.map(call => call.args.slice(0, 2)) })).toMatchObject({ ok: true, state: 'running' });
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(receipt.content.images).toEqual(expect.arrayContaining(approved));
            expect(receipt.content.ownServer?.imageArchives).toHaveLength(4);
            expect(nativeRequests.filter(value => value.args.includes('--metadata-file'))).toHaveLength(mode === 'mixed' ? 2 : 0);
            expect(nativeRequests.filter(value => value.args[0] === 'image' && value.args[1] === 'inspect')
                .some(value => value.args.at(-1)?.endsWith(':reviewed'))).toBe(false);
            if (mode === 'closure') {
                expect(receipt.content.sourceIntent.kind === 'stored' && receipt.content.sourceIntent.services).toEqual(['app']);
                expect(receipt.content.ownServer!.approvedInputBasis.services).toEqual(['app', 'worker']);
            }
            if (mode === 'stored') {
                const alias = structuredClone(receipt.content);
                for (const image of alias.images) if (image.platform === 'linux/arm64') image.platform = 'linux/arm64/v8';
                for (const archive of alias.ownServer!.imageArchives!) {
                    if (archive.image.platform === 'linux/arm64') archive.image.platform = 'linux/arm64/v8';
                }
                expect(isOwnServerBuildReceiptComplete(alias)).toBe(true);
                alias.images.find(image => image.platform === 'linux/arm64/v8')!.platform = 'linux/arm64/v9';
                expect(isOwnServerBuildReceiptComplete(alias)).toBe(false);
            }
        }, { mode });
    });

    it.each(['rotation', 'removal', 'unchanged'] as const)('uses this installation last completed build for %s cache invalidation, even after rollout failure', async change => {
        let previous: OwnServerDeploymentReceipt | undefined;
        await withBuilder(async ({ host, request, receipt }) => {
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: true });
            previous = structuredClone(receipt);
            previous.deployment.state = 'failed';
        }, { deploymentId: 'previous-build', secretRevision: 1 });
        await withBuilder(async ({ host, request, history, nativeRequests }) => {
            history.push(previous!);
            expect(await buildOwnServerDeploymentReceipt(host, request)).toMatchObject({ ok: true });
            const buildSettings = nativeRequests.filter(value => value.args.includes('--metadata-file'))
                .flatMap(value => value.args.filter(arg => arg.endsWith('.no-cache=true')));
            expect(buildSettings).toEqual(change === 'unchanged' ? [] : ['app.no-cache=true', 'app.no-cache=true']);
        }, { secretRevision: change === 'rotation' ? 2 : 1, buildSecret: change !== 'removal' });
    });

    it('builds exact platform variants once, adopts verified archives and publishes one running stage without runtime secrets', async () => {
        await withBuilder(async ({ host, request, receipt, environment, nativeRequests, custody }) => {
            expect(custody.grants).toHaveLength(3);
            for (const installation of custody.installations) {
                const phase = installation.machineId === 'builder-c' ? 'build' : 'runtime';
                const launchInput = { environmentId: request.input.environmentId, machineId: installation.machineId,
                    installationId: installation.installationId, installationPrivateSeed: installation.seed,
                    bindings: custody.bindings, grants: custody.grants.filter(grant => grant.machineId === installation.machineId),
                     async assertCurrent() {} };
                const launch = await prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, phase });
                expect(Object.keys(launch.env)).toEqual([phase === 'build' ? 'BUILD_TOKEN' : 'RUNTIME_TOKEN']);
                launch.dispose();
                // Both variables deliberately reference the same admitted resource.
                // Phase chooses the attachment, not another resource permission.
                const otherPhase = phase === 'build' ? 'runtime' : 'build';
                const otherLaunch = await prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, phase: otherPhase });
                expect(Object.keys(otherLaunch.env)).toEqual([otherPhase === 'build' ? 'BUILD_TOKEN' : 'RUNTIME_TOKEN']);
                otherLaunch.dispose();
            }
            let environmentReads = 0;
            let receiptReads = 0;
            let editedFuturePlacement = false;
            const result = await buildOwnServerDeploymentReceipt({ ...host,
                async readEnvironment(input) { environmentReads++; return host.readEnvironment(input); },
                async readReceipt(input) {
                    receiptReads++;
                    if (!editedFuturePlacement && nativeRequests.some(call => call.args.includes('--metadata-file'))) {
                        environment.environment.buildMachineId = 'future-builder';
                        environment.environment.revision++;
                        editedFuturePlacement = true;
                    }
                    return host.readReceipt(input);
                },
            }, request);
            expect(result.ok, 'errorCode' in result ? result.errorCode : undefined).toBe(true);
            expect(result).toMatchObject({ ok: true, state: 'running' });
            // The build consumes one admitted Environment. Home's receipt CAS
            // carries registration forward; publication checks the approval once.
            expect(environmentReads).toBe(1);
            expect(receiptReads).toBeLessThanOrEqual(2);
            expect(editedFuturePlacement).toBe(true);
            expect(receipt.content.images).toHaveLength(4);
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(receipt.content.ownServer?.imageArchives).toHaveLength(4);
            for (const archive of receipt.content.ownServer!.imageArchives!) {
                const bytes = await readFile(archive.holder.path);
                expect(digest(bytes).slice(7)).toBe(archive.sha256);
                expect(archive.holder.machineId).toBe('builder-c');
            }
            expect(receipt.content.ownServer?.buildSecretRevisions).toEqual([
                { service: 'app', machineId: 'builder-c', installationId: 'installation-c',
                    bindings: [{ ref: formatSharedSavedSecretRefV1('build-token'), resourceRevision: 2 }] },
                { service: 'worker', machineId: 'builder-c', installationId: 'installation-c', bindings: [] },
            ]);
            expect(nativeRequests.filter(value => value.args.includes('--metadata-file'))).toHaveLength(2);
            expect(nativeRequests.some(value => value.args.includes('up'))).toBe(false);
            expect(JSON.stringify(receipt.content)).not.toContain('build-owner-secret-sentinel');
        });
    });

    it.each(['bindings', 'source', 'native fingerprint', 'receipt revision'] as const)('refuses changed %s before publishing the build', async changedInput => {
        await withBuilder(async ({ host, request, receipt, nativeRequests, sourceTargetPath }) => {
            let changed = false;
            let revisionAtEdit: number | undefined;
            const initialContent = structuredClone(receipt.content);
            let publishedSources: OwnServerDeploymentSourceV1[] | undefined;
            const result = await buildOwnServerDeploymentReceipt({ ...host,
                async writeTransition(input) {
                    const source = input.content?.ownServer?.sources?.[0];
                    if (source && !publishedSources) {
                        expect(nativeRequests.some(call => call.args.includes('config') || call.args.includes('--metadata-file'))).toBe(false);
                        await verifyPublishedBuildSource(source, sourceTargetPath, receipt);
                        publishedSources = structuredClone(input.content!.ownServer!.sources);
                    }
                    return host.writeTransition(input);
                },
                async readReceipt(input) {
                    const built = nativeRequests.some(call => call.args.includes('--metadata-file'));
                    if (!changed && built) {
                        const basis = receipt.content.ownServer!.approvedInputBasis;
                        if (changedInput === 'bindings') basis.bindings.push({ purpose: 'variable', phase: 'build', name: 'EDITED',
                            source: { kind: 'value', value: 'unreviewed' } });
                        else if (changedInput === 'source') {
                            if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
                            receipt.content.sourceIntent.sha = 'f'.repeat(40);
                        } else if (changedInput === 'native fingerprint') basis.manifestFingerprint = 'sha256:' + 'f'.repeat(64);
                        else receipt.deployment.revision++;
                        revisionAtEdit = receipt.deployment.revision;
                        changed = true;
                    }
                    return host.readReceipt(input);
                },
            }, request);
            expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            if (result.ok) throw new Error('Changed input must refuse the build');
            expect(changed).toBe(true);
            expect(revisionAtEdit).toBeDefined();
            // A competing revision must not be overwritten. Other approved-input
            // conflicts persist their failure through the incumbent receipt CAS.
            expect(receipt.deployment.revision).toBe(revisionAtEdit! + (changedInput === 'receipt revision' ? 0 : 1));
            if (changedInput !== 'receipt revision') expect(receipt.content.failure).toMatchObject({
                code: 'deployment_conflict', phase: 'build', failureCause: result.failureCause });
            expect(publishedSources).toHaveLength(1);
            expect(receipt.content.images).toStrictEqual(initialContent.images);
            expect(receipt.content.ownServer?.buildSecretRevisions).toBeUndefined();
            const builds = nativeRequests.filter(call => call.args.includes('--metadata-file'));
            expect(builds.length).toBeGreaterThan(0);
            if (changedInput !== 'receipt revision') await expect(access(sourceTargetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }, { mode: 'mixed' });
    });

    it.each(['config', 'build'] as const)('finishes an admitted build after native %s authority withdrawal and refuses the next acquisition', async revokeAfter => {
        await withBuilder(async ({ host, request, receipt, environment, nativeRequests, sourceTargetPath }) => {
            let publishedSources: OwnServerDeploymentSourceV1[] | undefined;
            expect(await buildOwnServerDeploymentReceipt({ ...host, async writeTransition(input) {
                const source = input.content?.ownServer?.sources?.[0];
                if (source && !publishedSources) {
                    expect(nativeRequests.some(call => call.args.includes('config') || call.args.includes('--metadata-file'))).toBe(false);
                    await verifyPublishedBuildSource(source, sourceTargetPath, receipt);
                    publishedSources = structuredClone(input.content!.ownServer!.sources);
                }
                return host.writeTransition(input);
            } }, request)).toMatchObject({ ok: true, state: 'running' });
            expect(publishedSources).toHaveLength(1);
            expect(isOwnServerBuildReceiptComplete(receipt.content)).toBe(true);
            expect(receipt.content.ownServer?.imageArchives).toHaveLength(4);
            expect(nativeRequests.filter(call => call.args.includes('--metadata-file'))).toHaveLength(2);
            const revokedAt = nativeRequests.findIndex(call => revokeAfter === 'config'
                ? call.args.includes('config') : call.args.includes('--metadata-file'));
            expect(revokedAt).toBeGreaterThanOrEqual(0);
            expect(nativeRequests.slice(revokedAt + 1).some(call => call.args[0] === 'image' && call.args[1] === 'save')).toBe(true);
            await expect(access(sourceTargetPath)).resolves.toBeUndefined();
            const nativeCount = nativeRequests.length;
            // A new acquisition is not the completed receipt's ACK-rejoin path.
            await expect(host.runtime.acquire({ actionId: request.actionId, input: request.input,
                context: request.context, executionRole: 'build',
                materialization: { kind: 'deployment', deploymentId: 'next-deployment' } },
            { environment, content: receipt.content, deployment: receipt.deployment }))
                .rejects.toMatchObject({ code: 'authority_revoked' });
            expect(nativeRequests).toHaveLength(nativeCount);
        }, { mode: 'mixed', revokeAfter });
    });

    it('rejoins a receipt after a revision advance while refusing a changed parent operation before native work', async () => {
        await withBuilder(async ({ host, request, nativeRequests, environment }) => {
            expect(await buildOwnServerDeploymentReceipt(host, { ...request,
                context: { operationAcceptance: { operationId: 'other-operation', accept() {} } } }))
                .toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
            expect(nativeRequests).toEqual([]);
            environment.environment.revision++;
            const changed = { ...request, receipt: { ...request.receipt, revision: environment.environment.revision } };
            expect(await buildOwnServerDeploymentReceipt(host, changed)).toMatchObject({ ok: true, state: 'running' });
        });
    });
});
