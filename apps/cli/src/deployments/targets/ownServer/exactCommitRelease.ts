import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import type { DeploymentSourceMaterializationPortV1, DeploymentSourceMaterializationRequestV1, DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { WorkspaceManifestEntry } from '@happier-dev/protocol';
import type { OwnServerDeploymentSourceV1 } from '@happier-dev/deployment-protocol';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ScmBackendRegistry } from '@/scm/registry';
import { exportWorkspaceCommit, fetchWorkspaceCommitRef } from '@/scm/workspace/workspaceCommitExport';
import { inspectCommittedWorkspaceTargetMaterialization, materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries } from '@/scm/workspace/workspaceExportArtifacts';
import { admitStoredComposeDefinition, type StoredComposeDefinition } from '@/workspaces/projectSetup/nativeComposeSource';
import { hashWorkspaceFile } from '@/scm/workspace/workspaceExportPackaging/hashWorkspaceFile';
import { rethrowDeploymentSourceAcquisitionFailure } from '@/deployments/deploymentFailure';
import { resolveDeploymentSourcePathForHost } from './paths';
import { createDeploymentSourceOperationLogCustody, type DeploymentSourceProgress } from './sourceOperationLog';
export { resolveDeploymentSourcePathForHost } from './paths';

// The public handle exposes only its fingerprint. Host storage admission keeps
// the original source entries with the same physical materialization custody.
const sourceManifests = new WeakMap<DeploymentSourceMaterializationV1, Readonly<{
    entries: readonly WorkspaceManifestEntry[]; operationLog?: boolean; commitSubject?: string;
}>>();

/** Check only the selected bind subtree, including extra runtime-created files.
 * Source links are followed only after proving their original target and root. */
export async function isDeploymentSourceUnchangedManifestInput(source: DeploymentSourceMaterializationV1, path: string): Promise<boolean> {
    const custody = sourceManifests.get(source);
    if (!custody) return false;
    const manifest = custody.entries;
    await source.assertCurrent();
    return isDeploymentManifestInputUnchanged({ rootPath: source.rootPath, manifest, path,
        ...(custody.operationLog ? { operationLog: custody.operationLog } : {}) });
}

/** Host-only projection of the manifest already admitted by transfer custody. */
export function readDeploymentSourceManifestForHost(source: DeploymentSourceMaterializationV1): readonly WorkspaceManifestEntry[] {
    const manifest = sourceManifests.get(source);
    if (!manifest) throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Deployment source custody is unavailable' });
    return manifest.entries;
}

/** Observation of source already proven by retained receipt custody. It owns no
 * staging bytes, so settlement cannot transfer or remove the serving release. */
export function observeRetainedDeploymentSourceForHost(input: Omit<DeploymentSourceMaterializationV1, 'commit' | 'abort'>
    & Readonly<{ manifest: readonly WorkspaceManifestEntry[] }>): DeploymentSourceMaterializationV1 {
    const { manifest, ...identity } = input;
    const source: DeploymentSourceMaterializationV1 = Object.freeze({ ...identity, async commit() {}, async abort() {} });
    sourceManifests.set(source, { entries: manifest });
    return source;
}

/** Display metadata captured by the same immutable SCM export, not a later repository read. */
export function readDeploymentSourceCommitSubjectForHost(source: DeploymentSourceMaterializationV1): string | undefined {
    return sourceManifests.get(source)?.commitSubject;
}

/** Reload/retention compares the original admitted transfer entries, never a
 * newly invented scan or a manifest of application-created bytes. */
export async function isDeploymentManifestInputUnchanged(input: Readonly<{
    rootPath: string; manifest: readonly WorkspaceManifestEntry[]; path: string;
    operationLog?: boolean;
}>): Promise<boolean> {
    return (await createDeploymentManifestInputReader(input))(input.path);
}

/** Reuse the admitted manifest index across a bounded retention pass. */
export async function createDeploymentManifestInputReader(input: Readonly<{
    rootPath: string; manifest: readonly WorkspaceManifestEntry[];
    operationLog?: boolean;
    followSourceSymlinks?: boolean;
}>) {
    const { manifest } = input;
    const root = await realpath(input.rootPath);
    const contained = (candidate: string) => {
        const child = relative(root, candidate);
        return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
    };
    const entries = new Map(manifest.map(entry => [entry.relativePath, entry]));
    const children = new Map<string, Set<string>>();
    for (const entry of manifest) {
        const parent = dirname(entry.relativePath).replaceAll('\\', '/');
        const siblings = children.get(parent) ?? new Set<string>();
        siblings.add(entry.relativePath.split('/').at(-1)!);
        children.set(parent, siblings);
    }
    const visiting = new Set<string>();
    const unchanged = async (candidate: string): Promise<boolean> => {
        if (!contained(candidate) || visiting.has(candidate)) return false;
        visiting.add(candidate);
        try {
            const key = relative(root, candidate).split(sep).join('/');
            const entry = entries.get(key);
            if (key === '.happier/deploy.log' && input.operationLog) {
                return contained(await realpath(candidate)) && (await lstat(candidate)).isFile();
            }
            const stat = await lstat(candidate);
            if (stat.isSymbolicLink()) {
                if (entry?.kind !== 'symlink' || await readlink(candidate) !== entry.target) return false;
                return input.followSourceSymlinks === false || await unchanged(resolve(dirname(candidate), entry.target));
            }
            if (!contained(await realpath(candidate))) return false;
            if (stat.isFile()) return entry?.kind === 'file' && stat.size === entry.sizeBytes
                && ((stat.mode & 0o111) !== 0) === entry.executable && await hashWorkspaceFile({ filePath: candidate }) === entry.digest;
            if (!stat.isDirectory() || key && entry?.kind !== 'directory' && !(key === '.happier' && input.operationLog)) return false;
            const actual = await readdir(candidate);
            const expected = new Set(children.get(key || '.') ?? []);
            if (input.operationLog) {
                if (!key) expected.add('.happier');
                if (key === '.happier') expected.add('deploy.log');
            }
            if (actual.length !== expected.size || actual.some(name => !expected.has(name))) return false;
            for (const name of actual) if (!await unchanged(join(candidate, name))) return false;
            return true;
        } finally { visiting.delete(candidate); }
    };
    return async (path: string): Promise<boolean> => {
        const suppliedRoot = resolve(input.rootPath);
        const suppliedPath = resolve(path);
        const suppliedRelative = relative(suppliedRoot, suppliedPath);
        const selectedPath = !isAbsolute(suppliedRelative) && suppliedRelative !== '..' && !suppliedRelative.startsWith(`..${sep}`)
            ? resolve(root, suppliedRelative) : suppliedPath;
        try { return await unchanged(selectedPath); }
        catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error
                && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return false;
            throw error;
        }
    };
}

/** Host admission captures these facts from the approved role; plugins cannot choose them. */
export type DeploymentSourceAdmissionForHost = Readonly<{
    environmentId: string;
    environmentInstanceId: string;
    deploymentId: string;
    machineId: string;
    installationId: string;
    deploymentRoot: string;
    artifactDirectory: string;
    /** The selected builder must not occupy a same-Machine runtime source destination. */
    materializationRole?: 'build';
    /** Existing parent receipt owns fresh compensation placement, never an overwrite of a serving release. */
    restorationForDeploymentId?: string;
    /** Already activated restoration captured by the generation receipt. */
    retainedRestoration?: OwnServerDeploymentSourceV1;
    /** Finite backup work borrows a generation without occupying its runtime source placement. */
    maintenanceOperationId?: string;
    /** Retain the pinned operation log admitted on this exact installation. */
    operationLog?: boolean;
}> & (Readonly<{ sourcePath: string; commitSha: string; definition?: never;
    pullRequestHead?: Readonly<{ number: number }>; repository?: ProjectSourceRepositorySelectorV1 }>
    | Readonly<{ definition: StoredComposeDefinition; sourcePath?: never; commitSha?: never; pullRequestHead?: never; repository?: never }>);
export type AdmittedDeploymentSourceV1 = DeploymentSourceAdmissionForHost & Readonly<{ assertCurrent(): Promise<void> }>;

async function exportStoredDefinition(admitted: AdmittedDeploymentSourceV1 & Readonly<{ definition: StoredComposeDefinition }>) {
    const definition = await admitStoredComposeDefinition(admitted.definition);
    await mkdir(admitted.artifactDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(admitted.artifactDirectory, 'stored-compose-'));
    try {
        const sourcePath = join(directory, 'compose.yaml');
        await writeFile(sourcePath, definition.document, { mode: 0o600 });
        const entries = [{ relativePath: 'compose.yaml', sourcePath }];
        for (const file of definition.publicFiles ?? []) {
            const sourcePath = join(directory, file.path);
            await mkdir(dirname(sourcePath), { recursive: true });
            await writeFile(sourcePath, file.content, { mode: 0o600 });
            entries.push({ relativePath: file.path, sourcePath });
        }
        const exported = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({
            entries,
        });
        return { ...exported, async dispose() { await rm(directory, { recursive: true, force: true }); } };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Public source port over SCM export and the one contained manifest/blob materializer. */
export function createDeploymentSourceMaterializationPort(input: Readonly<{
    admit(request: DeploymentSourceMaterializationRequestV1, signal?: AbortSignal): Promise<AdmittedDeploymentSourceV1>;
    registry?: ScmBackendRegistry;
    /** Host-only finite phase facts; never subprocess bytes or a public port operand. */
    onProgress?: (phase: DeploymentSourceProgress) => void | Promise<void>;
    /** Public source acquisition uses the role's captured identity and incumbent cleanup owner. */
    invocation?: Readonly<{
        identity: Readonly<Pick<DeploymentSourceMaterializationRequestV1, 'environmentId' | 'deploymentId'>>;
        signal: AbortSignal;
        assertCurrent(): void;
        retainCleanup(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
    }>;
}>): DeploymentSourceMaterializationPortV1 {
    const assertIdentityMatches = (request: DeploymentSourceMaterializationRequestV1,
        identity: Readonly<{ environmentId: string; deploymentId: string }>) => {
        if (request.environmentId !== identity.environmentId || request.deploymentId !== identity.deploymentId) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'Deployment source admission changed' });
        }
    };
    return {
        async materialize(request, options) {
            input.invocation?.assertCurrent();
            if (input.invocation) assertIdentityMatches(request, input.invocation.identity);
            if (input.invocation) options = { signal: options?.signal
                ? AbortSignal.any([options.signal, input.invocation.signal]) : input.invocation.signal };
            let custody: Readonly<{ abort(): Promise<void> }> | undefined;
            let operation: Promise<DeploymentSourceMaterializationV1> | undefined;
            input.invocation?.retainCleanup({ async dispose() {
                await operation?.catch(() => undefined);
                await custody?.abort();
            } });
            operation = (async () => {
                options?.signal?.throwIfAborted();
                const admitted = await input.admit(request, options?.signal);
                if (!input.invocation) assertIdentityMatches(request, admitted);
                const assertCurrent = async () => {
                    options?.signal?.throwIfAborted();
                    await admitted.assertCurrent();
                    options?.signal?.throwIfAborted();
                };
                await assertCurrent();
                const targetPath = resolveDeploymentSourcePathForHost(admitted);
                await input.onProgress?.('export');
                if (admitted.pullRequestHead) {
                    const number = admitted.pullRequestHead.number;
                    const repository = admitted.repository;
                    const cloneUrl = repository?.protocol === 'ssh' ? repository.repository.sshUrl : repository?.repository.cloneUrl;
                    if (!Number.isSafeInteger(number) || number <= 0 || !cloneUrl) {
                        throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Base repository source is unavailable' });
                    }
                    await fetchWorkspaceCommitRef({ sourcePath: admitted.sourcePath, cloneUrl,
                        ref: `refs/pull/${number}/head`, expectedCommitSha: admitted.commitSha,
                        registry: input.registry, signal: options?.signal }).catch(rethrowDeploymentSourceAcquisitionFailure);
                    await assertCurrent();
                }
                const exported = admitted.definition
                    ? await exportStoredDefinition({ ...admitted, definition: admitted.definition })
                    : await exportWorkspaceCommit({ sourcePath: admitted.sourcePath, commitSha: admitted.commitSha,
                        artifactDirectory: admitted.artifactDirectory, registry: input.registry, signal: options?.signal }).catch(rethrowDeploymentSourceAcquisitionFailure);
                try {
                    await assertCurrent();
                    const manifestFingerprint = exported.workspaceExportArtifacts.manifest.fingerprint!;
                    const retained = admitted.retainedRestoration;
                    const restoration = admitted.restorationForDeploymentId && !admitted.maintenanceOperationId;
                    const existingRoot = restoration ? await realpath(targetPath).catch((error: unknown) => {
                        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
                        throw error;
                    }) : undefined;
                    if (restoration && (retained || existingRoot)) {
                        const unavailable = () => createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Retained restoration source changed' });
                        const physicalTarget = resolveDeploymentSourcePathForHost({ ...admitted,
                            deploymentRoot: await realpath(admitted.deploymentRoot) });
                        // Activation retains these immutable bytes before it can
                        // fail. A failed activation has not published provenance
                        // yet; reopen only the exact contained, unchanged export.
                        const rootFingerprint = retained?.rootFingerprint ?? await computeWorkspaceSyncRootFingerprint(existingRoot!);
                        const assertRetained = async () => {
                            if (await realpath(targetPath) !== physicalTarget
                                || retained && (retained.role !== 'runtime' || retained.machineId !== admitted.machineId
                                || retained.installationId !== admitted.installationId || retained.deploymentId !== admitted.deploymentId
                                || retained.restorationForDeploymentId !== admitted.restorationForDeploymentId
                                || retained.manifestFingerprint !== manifestFingerprint)
                                || await computeWorkspaceSyncRootFingerprint(await realpath(targetPath)) !== rootFingerprint) throw unavailable();
                        };
                        await assertRetained();
                        if (!await isDeploymentManifestInputUnchanged({ rootPath: targetPath, path: targetPath,
                            manifest: exported.workspaceExportArtifacts.manifest.entries })) throw unavailable();
                        return observeRetainedDeploymentSourceForHost({ environmentId: admitted.environmentId,
                            environmentInstanceId: admitted.environmentInstanceId, deploymentId: admitted.deploymentId,
                            machineId: admitted.machineId, installationId: admitted.installationId, rootPath: targetPath,
                            manifestFingerprint, manifest: exported.workspaceExportArtifacts.manifest.entries,
                            assertCurrent: assertRetained });
                    }
                    if (admitted.operationLog && (admitted.materializationRole || admitted.restorationForDeploymentId)) {
                        throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_log_unavailable', error: 'Operation log has a different release placement' });
                    }
                    const operationLog = admitted.operationLog ? await createDeploymentSourceOperationLogCustody({
                        targetPath, entries: exported.workspaceExportArtifacts.manifest.entries,
                    }) : undefined;
                    await input.onProgress?.('materialize');
                    const result = await materializeWorkspaceExportArtifactsWithScmWorkspace({
                        workspaceExportArtifacts: exported.workspaceExportArtifacts,
                        targetPath,
                        admittedTargetRoot: admitted.deploymentRoot,
                        conflictPolicy: 'replace_existing', blobProvider: exported.blobProvider, registry: input.registry,
                        // An immutable receipt gets a fresh destination; replacing a serving release is never authorized.
                        targetFence: { state: 'missing', identity: null },
                        ...(operationLog ? { retainedTargetFile: operationLog } : {}),
                        naming: { siblingCopySuffixBase: 'release', backupDirectoryPrefix: '.happier-release-backup', stagingIdPrefix: 'happier-release' },
                        // Per-file staging is cancellable and physically contained;
                        // remote authority is re-read at the phase boundaries, not
                        // once for every committed file.
                        assertCanContinue: async () => { options?.signal?.throwIfAborted(); },
                    });
                    try { await assertCurrent(); }
                    catch (error) {
                        await result.custody.abort();
                        throw error;
                    }
                    custody = result.custody;
                    const source: DeploymentSourceMaterializationV1 = Object.freeze({ environmentId: admitted.environmentId, environmentInstanceId: admitted.environmentInstanceId,
                        deploymentId: admitted.deploymentId, machineId: admitted.machineId, installationId: admitted.installationId,
                        rootPath: result.targetPath, manifestFingerprint,
                        async assertCurrent() {
                            if (!result.custody.receipt.committed) return await assertCurrent();
                            // The managed-service owner checks each new caller's
                            // authority. Retained release custody checks its physical
                            // object, not the finished deploy caller's lifetime.
                            await inspectCommittedWorkspaceTargetMaterialization({ targetPath: result.targetPath, receipt: result.custody.receipt });
                        },
                        // Settlement only relinquishes rollback custody. Native activation
                        // may already use these bytes even when the invocation was cancelled.
                        async commit() {
                            await result.custody.commit();
                        },
                        async abort() {
                            await result.custody.abort();
                        },
                    });
                    sourceManifests.set(source, { entries: exported.workspaceExportArtifacts.manifest.entries,
                        ...('commitSubject' in exported && typeof exported.commitSubject === 'string' ? { commitSubject: exported.commitSubject } : {}),
                        ...(admitted.operationLog ? { operationLog: admitted.operationLog } : {}) });
                    return source;
                } finally { await exported.blobProvider.dispose?.(); await exported.dispose(); }
            })();
            return await operation;
        },
    };
}
