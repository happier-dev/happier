import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import { readDeploymentSourceManifestForHost, type DeploymentSourceAdmissionForHost } from './exactCommitRelease';
import type { OwnServerDeploymentSourceV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { resolveDeploymentSourcePathForHost, readDeploymentSourceIdentityForHost } from './paths';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';

/** One invocation consumes canonical receipt history lazily and shares those
 * reads across its native bind set. A path is never a custody proof itself. */
export function createOwnServerSourceCustodyReader(input: Readonly<{
    deploymentRoot: string; environmentId: string; environmentInstanceId: string; machineId: string; installationId: string;
    history: AsyncIterable<DeploymentReceiptDetailV1>; assertCurrent(): Promise<void>;
    readIncumbentReceipt?(fact: NonNullable<DeploymentChildExecutionProofV1['nativeIncumbentSource']>): Promise<DeploymentReceiptDetailV1>;
}>) {
    const iterator = input.history[Symbol.asyncIterator]();
    const sources = new Map<string, OwnServerDeploymentSourceV1 | null>();
    let complete = false;
    let physicalRoot: string | undefined;
    const within = (root: string, path: string) => {
        const suffix = relative(root, path);
        return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
    };
    const refuse = (): never => { throw Object.assign(new Error('Native incumbent source custody changed'), { code: 'deployment_source_unavailable' }); };
    const index = (receipt: DeploymentReceiptDetailV1) => {
        for (const source of receipt.content.ownServer?.sources ?? []) {
            if (source.role !== 'runtime' || source.machineId !== input.machineId || source.installationId !== input.installationId) continue;
            const rootPath = resolveDeploymentSourcePathForHost({ deploymentRoot: physicalRoot!,
                environmentInstanceId: input.environmentInstanceId, deploymentId: source.deploymentId,
                ...(source.restorationForDeploymentId ? { restorationForDeploymentId: source.restorationForDeploymentId } : {}) });
            if (!sources.get(rootPath)) sources.set(rootPath, source);
        }
    };
    return async (path: string, assertNativeMountCurrent?: () => Promise<void>) => {
        await input.assertCurrent();
        physicalRoot ??= await realpath(input.deploymentRoot);
        const selected = await realpathWithAbsentSuffix(path);
        if (!within(physicalRoot, selected)) return undefined;
        for (;;) {
            // Index each consumed receipt once. Native paths walk only their
            // own ancestors, never rescan all historical roots per mount.
            for (let rootPath = selected; within(physicalRoot, rootPath); rootPath = dirname(rootPath)) {
                const source = sources.get(rootPath);
                if (!source) continue;
                if (await realpath(rootPath) !== rootPath || await computeWorkspaceSyncRootFingerprint(rootPath) !== source.rootFingerprint) {
                    throw Object.assign(new Error('Native incumbent source custody changed'), { code: 'deployment_source_unavailable' });
                }
                return { rootPath, manifest: source.manifestEntries };
            }
            if (complete) {
                if (!input.readIncumbentReceipt) return undefined;
                let found = false;
                for (let rootPath = selected; within(physicalRoot, rootPath); rootPath = dirname(rootPath)) {
                    const identity = readDeploymentSourceIdentityForHost({ deploymentRoot: physicalRoot, sourcePath: rootPath });
                    if (!identity || identity.environmentInstanceId !== input.environmentInstanceId) continue;
                    if (sources.has(rootPath) || await realpath(rootPath) !== rootPath) return undefined;
                    const fact = { environmentId: input.environmentId, sourceDeploymentId: identity.deploymentId,
                        ...(identity.restorationForDeploymentId ? { restorationForDeploymentId: identity.restorationForDeploymentId } : {}),
                        rootFingerprint: await computeWorkspaceSyncRootFingerprint(rootPath) };
                    sources.set(rootPath, null);
                    const receipt = await input.readIncumbentReceipt(fact);
                    await input.assertCurrent();
                    await assertNativeMountCurrent?.();
                    if (receipt.deployment.environmentId !== input.environmentId
                        || receipt.deployment.id !== (fact.restorationForDeploymentId ?? fact.sourceDeploymentId)) return refuse();
                    index(receipt);
                    const source = sources.get(rootPath);
                    if (!source || source.rootFingerprint !== fact.rootFingerprint) return refuse();
                    found = true;
                    break;
                }
                if (!found) return undefined;
                continue;
            }
            const next = await iterator.next();
            complete = next.done === true;
            if (!complete) index(next.value);
        }
    };
}

export async function captureOwnServerDeploymentSource(input: Readonly<{
    source: DeploymentSourceMaterializationV1;
    admission: DeploymentSourceAdmissionForHost;
    sharedBinds?: readonly Readonly<{ relativePath: string; services: readonly string[] }>[];
}>): Promise<OwnServerDeploymentSourceV1> {
    await input.source.assertCurrent();
    const expected = await realpath(resolveDeploymentSourcePathForHost(input.admission));
    if (expected !== await realpath(input.source.rootPath)) {
        throw Object.assign(new Error('Deployment source custody changed'), { code: 'deployment_source_unavailable' });
    }
    return { machineId: input.source.machineId, installationId: input.source.installationId,
        deploymentId: input.source.deploymentId, role: input.admission.materializationRole === 'build' ? 'build' : 'runtime',
        ...(input.admission.restorationForDeploymentId ? { restorationForDeploymentId: input.admission.restorationForDeploymentId } : {}),
        rootFingerprint: await computeWorkspaceSyncRootFingerprint(expected),
        manifestFingerprint: input.source.manifestFingerprint,
        manifestEntries: [...readDeploymentSourceManifestForHost(input.source)],
        sharedBinds: (input.sharedBinds ?? []).map(binding => ({ relativePath: binding.relativePath, services: [...binding.services] })) };
}
export function replaceOwnServerDeploymentSource(sources: readonly OwnServerDeploymentSourceV1[] | undefined,
    source: OwnServerDeploymentSourceV1): OwnServerDeploymentSourceV1[] {
    return [...(sources ?? []).filter(value => value.machineId !== source.machineId || value.installationId !== source.installationId
        || value.role !== source.role || value.restorationForDeploymentId !== source.restorationForDeploymentId
        || value.deploymentId !== source.deploymentId), source];
}
