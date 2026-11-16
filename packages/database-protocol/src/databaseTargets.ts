import { z } from 'zod/mini';
import { WorkspaceAddressV2Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { DeploymentEnvironmentRefV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';

const id = z.string().check(z.minLength(1));

export const DatabaseBuiltinEngineIdV1Schema = z.enum(['postgresql', 'mysql', 'sqlite']);
export type DatabaseBuiltinEngineIdV1 = z.infer<typeof DatabaseBuiltinEngineIdV1Schema>;
/** Contributed engine identities are not restricted to the bundled engines. */
export const DatabaseEngineIdV1Schema = id;
export type DatabaseEngineIdV1 = z.infer<typeof DatabaseEngineIdV1Schema>;

export const DatabaseWorktreeSourceV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('service'), serviceId: id, variable: id }),
    z.strictObject({ kind: z.literal('env_file'), path: id, variable: id }),
    z.strictObject({ kind: z.literal('sqlite_file'), path: id }),
]);
export type DatabaseWorktreeSourceV1 = z.infer<typeof DatabaseWorktreeSourceV1Schema>;

const workspaceContext = {
    accountId: id, workspace: WorkspaceAddressV2Schema, installationId: id, projectKey: id,
};
export const DatabaseWorktreeTargetV1Schema = z.strictObject({
    kind: z.literal('worktree'), ...workspaceContext, source: DatabaseWorktreeSourceV1Schema,
});
export const DatabaseDeploymentServiceTargetV1Schema = z.strictObject({
    kind: z.literal('deployment_service'), environment: DeploymentEnvironmentRefV1Schema,
    deploymentId: id, targetLinkId: id, serviceId: id, database: id,
});
export const DatabaseManagedDeploymentTargetV1Schema = z.strictObject({
    kind: z.literal('managed_deployment'), environment: DeploymentEnvironmentRefV1Schema,
    targetLinkId: id, contribution: z.strictObject({ pluginId: id, contributionId: id }),
    platformProjectId: id, branchId: id, database: id,
});
export const DatabaseManualTargetV1Schema = z.strictObject({
    kind: z.literal('manual'), ...workspaceContext, savedSecretId: id,
});
/** A structural owner reference, never a credential URL or an independent database record. */
export const DatabaseTargetV1Schema = z.discriminatedUnion('kind', [
    DatabaseWorktreeTargetV1Schema, DatabaseDeploymentServiceTargetV1Schema,
    DatabaseManagedDeploymentTargetV1Schema, DatabaseManualTargetV1Schema,
]);
export type DatabaseTargetV1 = z.infer<typeof DatabaseTargetV1Schema>;
export type DatabaseWorktreeTargetV1 = z.infer<typeof DatabaseWorktreeTargetV1Schema>;
export type DatabaseDeploymentServiceTargetV1 = z.infer<typeof DatabaseDeploymentServiceTargetV1Schema>;
export type DatabaseManagedDeploymentTargetV1 = z.infer<typeof DatabaseManagedDeploymentTargetV1Schema>;
export type DatabaseManualTargetV1 = z.infer<typeof DatabaseManualTargetV1Schema>;
