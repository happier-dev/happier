import {
    formatSharedSavedSecretRefV1,
    ProtocolDeploymentEnvironmentHeaderV1Schema,
    ProtocolDeploymentReceiptHeaderV1Schema,
    ProtocolDeploymentSecretBindingSourceV1Schema,
    ProtocolDeploymentVariableBindingV1Schema,
    type DeploymentEnvironmentHeaderV1,
    type DeploymentReceiptHeaderV1,
    type EnvironmentVariableBindingV1,
} from '@happier-dev/plugin-sdk/protocol';

/** Current variable content, including its opaque reference, through the strict binding owner. */
export function createDeploymentVariableBindingV1(input: Readonly<Pick<EnvironmentVariableBindingV1, 'name' | 'phase' | 'source'> & {
    grantRef?: string;
}>): EnvironmentVariableBindingV1 {
    return ProtocolDeploymentVariableBindingV1Schema.parse({ purpose: 'variable', ...input,
        grantRef: input.grantRef ?? crypto.randomUUID() });
}

/** Current producer-built opaque binding fixture; consumers never reconstruct the Saved Secret namespace. */
export function createDeploymentSecretVariableBindingV1(input: Readonly<{
    name: string; phase: 'build' | 'runtime'; resourceId: string; resourceRevision: number;
    grantRef?: string;
}>): Omit<EnvironmentVariableBindingV1, 'source'> & {
    source: Extract<EnvironmentVariableBindingV1['source'], { kind: 'secret' }>;
} {
    const source = ProtocolDeploymentSecretBindingSourceV1Schema.parse({ kind: 'secret',
        ref: formatSharedSavedSecretRefV1(input.resourceId), resourceRevision: input.resourceRevision });
    const binding = createDeploymentVariableBindingV1({ name: input.name, phase: input.phase,
        ...(input.grantRef === undefined ? {} : { grantRef: input.grantRef }), source });
    return { ...binding, source };
}

export function createDeploymentEnvironmentHeaderV1(overrides: Partial<DeploymentEnvironmentHeaderV1> = {}): DeploymentEnvironmentHeaderV1 {
    return ProtocolDeploymentEnvironmentHeaderV1Schema.parse({
        v: 1, id: 'environment-staging', serverId: 'home', projectSourceId: 'source-app', revision: 1,
        owner: { kind: 'account', accountId: 'account-owner' }, protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', dataEditorMode: 'off', dataAgentAccess: 'read', runtimeTargetLinkId: 'target-link',
        controllerMachineId: 'machine-a', buildMachineId: 'machine-a',
        capabilities: { role: 'manager', read: true, deploy: true, editData: false, manage: true, manageBindings: true, manageTargets: true, delete: true },
        createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000,
        contentArtifactId: 'artifact-environment', contentHeaderVersion: 1, contentBodyVersion: 1, ...overrides,
    });
}

export function createDeploymentReceiptHeaderV1(overrides: Partial<DeploymentReceiptHeaderV1> = {}): DeploymentReceiptHeaderV1 {
    return ProtocolDeploymentReceiptHeaderV1Schema.parse({
        v: 1, id: 'deployment-a', environmentId: 'environment-staging', targetLinkId: 'target-link', revision: 1,
        operation: 'deploy', state: 'succeeded', requestKey: 'request-a', requestedByAccountId: 'account-owner',
        actionOperationId: 'operation-a', requestedAtMs: 1000, startedAtMs: 1001, settledAtMs: 1002,
        contentArtifactId: 'artifact-deployment', contentHeaderVersion: 1, contentBodyVersion: 1, ...overrides,
    });
}
