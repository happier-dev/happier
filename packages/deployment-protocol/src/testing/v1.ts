import { DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentV1Schema, type DeploymentEnvironmentHeaderV1, type DeploymentEnvironmentV1 } from '../v1/environment.js';
import { DeploymentOwnServerTargetLinkContentV1Schema, DeploymentTargetLinkHeaderV1Schema, DeploymentTargetLinkV1Schema, DeploymentTargetLinksListResultV1Schema, DeploymentTargetV1Schema, type DeploymentTargetLinkHeaderV1, type DeploymentTargetLinkV1, type DeploymentTargetLinksListResultV1, type DeploymentTargetV1 } from '../v1/target.js';
import { DeploymentReceiptHeaderV1Schema, DeploymentV1Schema, type DeploymentOwnServerContentV1, type DeploymentReceiptHeaderV1, type DeploymentV1 } from '../v1/deployment.js';
import { DeploymentEnvironmentCollectionV1Schema, DeploymentEnvironmentDetailV1Schema, DeploymentReceiptDetailV1Schema, type DeploymentEnvironmentCollectionV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1 } from '../v1/details.js';
import { z } from 'zod/mini';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentSecretBindingSourceV1Schema, EnvironmentVariableBindingV1Schema, type EnvironmentVariableBindingV1 } from '../v1/environment.js';

type OwnServerDeploymentFixtureV1 = Omit<DeploymentV1, 'content'> & {
    content: { t: 'plain'; v: DeploymentOwnServerContentV1 } | Extract<DeploymentV1['content'], { t: 'encrypted' }>;
};
type OwnServerReceiptDetailFixtureV1 = Omit<DeploymentReceiptDetailV1, 'content'> & { content: DeploymentOwnServerContentV1 };

/** Current producer-built opaque binding fixture; consumers never reconstruct the Saved Secret namespace. */
export function createDeploymentSecretVariableBindingV1(input: Readonly<{
    name: string; phase: 'build' | 'runtime'; resourceId: string; resourceRevision: number;
}>): Pick<EnvironmentVariableBindingV1, 'purpose' | 'name' | 'phase'> & { source: ReturnType<typeof DeploymentSecretBindingSourceV1Schema.parse> } {
    const source = DeploymentSecretBindingSourceV1Schema.parse({ kind: 'secret',
        ref: formatSharedSavedSecretRefV1(input.resourceId), resourceRevision: input.resourceRevision });
    const binding = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', name: input.name, phase: input.phase, source });
    return { ...binding, source };
}

export function createDeploymentTargetV1(overrides: Partial<Extract<DeploymentTargetV1, { role: 'runtime' }>> = {}): Extract<DeploymentTargetV1, { role: 'runtime' }> {
    const target = DeploymentTargetV1Schema.parse({
        v: 1, id: 'own-server', source: { kind: 'host', id: 'own-server' }, role: 'runtime', targetKind: 'ownServer',
        title: 'Own server', icon: 'server-outline',
        targetSchema: z.toJSONSchema(DeploymentOwnServerTargetLinkContentV1Schema, { target: 'draft-7', io: 'input' }),
        linkSchema: z.toJSONSchema(z.strictObject({ machines: DeploymentOwnServerTargetMachinesV1Schema }), { target: 'draft-7', io: 'input' }),
        actions: {
            inspect: { kind: 'host', actionId: 'deployments.environments.get' },
            link: { kind: 'host', actionId: 'deployments.targets.link' },
            deploy: { kind: 'host', actionId: 'deployments.deploy' },
            observe: { kind: 'host', actionId: 'deployments.receipts.get' },
            rollback: { kind: 'host', actionId: 'deployments.rollback' },
        }, ...overrides,
    });
    if (target.role !== 'runtime') throw new TypeError('The own-server fixture requires a runtime target.');
    return target;
}

export function createDeploymentEnvironmentV1(overrides: Partial<DeploymentEnvironmentV1> = {}): DeploymentEnvironmentV1 {
    return DeploymentEnvironmentV1Schema.parse({
        v: 1, id: 'environment-staging', serverId: 'home', projectSourceId: 'source-app', revision: 1,
        owner: { kind: 'account', accountId: 'account-owner' }, protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', runtimeTargetLinkId: 'target-link', controllerMachineId: 'machine-a', buildMachineId: 'machine-a',
        content: { t: 'plain', v: { name: 'Staging', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } },
            bindings: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } } },
        capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true },
        createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000, ...overrides,
    });
}

export function createDeploymentTargetLinkV1(overrides: Partial<DeploymentTargetLinkV1> = {}): DeploymentTargetLinkV1 {
    return DeploymentTargetLinkV1Schema.parse({
        v: 1, id: 'target-link', environmentId: 'environment-staging', revision: 1,
        role: 'runtime', source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer', state: 'deployed',
        machines: ['machine-a'], members: [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }],
        activeDeploymentId: 'deployment-a', content: { t: 'plain', v: {} },
        createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000, ...overrides,
    });
}

export function createDeploymentV1(overrides?: Partial<OwnServerDeploymentFixtureV1>): OwnServerDeploymentFixtureV1;
export function createDeploymentV1(overrides: Partial<DeploymentV1>): DeploymentV1;
export function createDeploymentV1(overrides: Partial<DeploymentV1> = {}): DeploymentV1 {
    const deploymentId = overrides.id ?? 'deployment-a';
    const actionOperationId = overrides.actionOperationId ?? 'operation-a';
    return DeploymentV1Schema.parse({
        v: 1, id: deploymentId, environmentId: 'environment-staging', targetLinkId: 'target-link', revision: 1,
        operation: 'deploy', state: 'succeeded', requestKey: 'request-a', requestedByAccountId: 'account-owner', actionOperationId,
        content: { t: 'plain', v: {
            sourceIntent: { kind: 'repository', projectSourceId: 'source-app', sourceRevision: 1, sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } },
            machines: ['machine-a'], buildMachineId: 'machine-a',
            onFailure: 'rollbackAll', images: [{ service: 'app', platform: 'linux/amd64', configDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}` }],
            machineResults: [{ machineId: 'machine-a', installationId: 'installation-a', steps: [], actionOperationId, currentDeploymentId: deploymentId, activation: 'succeeded', health: 'healthy' }], steps: [],
        } }, requestedAtMs: 1000, startedAtMs: 1001, settledAtMs: 1002, ...overrides,
    });
}

export function createDeploymentEnvironmentHeaderV1(overrides: Partial<DeploymentEnvironmentHeaderV1> = {}): DeploymentEnvironmentHeaderV1 {
    const { content: _content, ...header } = createDeploymentEnvironmentV1();
    return DeploymentEnvironmentHeaderV1Schema.parse({ ...header, contentArtifactId: 'artifact-environment', contentHeaderVersion: 1, contentBodyVersion: 1, ...overrides });
}

export function createDeploymentTargetLinkHeaderV1(overrides: Partial<DeploymentTargetLinkHeaderV1> = {}): DeploymentTargetLinkHeaderV1 {
    const { content: _content, ...header } = createDeploymentTargetLinkV1();
    return DeploymentTargetLinkHeaderV1Schema.parse({ ...header, contentArtifactId: 'artifact-target-link', contentHeaderVersion: 1, contentBodyVersion: 1, ...overrides });
}

export function createDeploymentTargetLinksListResultV1(
    overrides: Partial<Extract<DeploymentTargetLinksListResultV1, { ok: true }>> = {},
): DeploymentTargetLinksListResultV1 {
    const environment = createDeploymentEnvironmentHeaderV1();
    const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id });
    return DeploymentTargetLinksListResultV1Schema.parse({ ok: true, items: [{ environment, targetLink }],
        nextCursor: null, coverage: 'complete', ...overrides });
}

export function createDeploymentReceiptHeaderV1(overrides: Partial<DeploymentReceiptHeaderV1> = {}): DeploymentReceiptHeaderV1 {
    const { content: _content, ...header } = createDeploymentV1();
    return DeploymentReceiptHeaderV1Schema.parse({ ...header, contentArtifactId: 'artifact-deployment', contentHeaderVersion: 1, contentBodyVersion: 1, ...overrides });
}

export function createDeploymentEnvironmentDetailV1(overrides: Partial<DeploymentEnvironmentDetailV1> = {}): DeploymentEnvironmentDetailV1 {
    const environment = createDeploymentEnvironmentV1();
    const link = createDeploymentTargetLinkV1();
    if (environment.content.t !== 'plain' || link.content.t !== 'plain') throw new Error('Expected opened fixture content');
    return DeploymentEnvironmentDetailV1Schema.parse({
        environment: createDeploymentEnvironmentHeaderV1(), content: environment.content.v,
        targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1(), content: link.content.v }], ...overrides,
    });
}

export function createDeploymentEnvironmentCollectionV1(overrides: Partial<DeploymentEnvironmentCollectionV1> = {}): DeploymentEnvironmentCollectionV1 {
    return DeploymentEnvironmentCollectionV1Schema.parse({
        items: [{ environment: createDeploymentEnvironmentHeaderV1(), title: 'Staging' }], nextCursor: null, ...overrides,
    });
}

export function createDeploymentReceiptDetailV1(overrides?: Partial<OwnServerReceiptDetailFixtureV1>): OwnServerReceiptDetailFixtureV1;
export function createDeploymentReceiptDetailV1(overrides: Partial<DeploymentReceiptDetailV1>): DeploymentReceiptDetailV1;
export function createDeploymentReceiptDetailV1(overrides: Partial<DeploymentReceiptDetailV1> = {}): DeploymentReceiptDetailV1 {
    const deployment = createDeploymentV1();
    if (deployment.content.t !== 'plain') throw new Error('Expected opened fixture content');
    return DeploymentReceiptDetailV1Schema.parse({ deployment: createDeploymentReceiptHeaderV1(), content: deployment.content.v, ...overrides });
}
