import { z } from 'zod/mini';
import { createDeploymentTargetCatalogV1 } from '@happier-dev/deployments';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol';
import { readDeploymentTargetReferenceRolesV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ResolvedDeploymentTargetContribution } from '@/plugins/projection/registry/types';
import { DeploymentOwnServerTargetLinkContentV1Schema, DeploymentTargetV1Schema,
    type DeploymentTargetV1 } from '@happier-dev/deployment-protocol/v1';

/** The consumed S0 daemon contribution. Role references use the public Action front door. */
export const OWN_SERVER_DEPLOYMENT_TARGET_V1: DeploymentTargetV1 = DeploymentTargetV1Schema.parse({
    v: 1, id: 'own-server', source: { kind: 'host', id: 'own-server' },
    role: 'runtime', targetKind: 'ownServer', title: 'Own server', icon: 'server-outline',
    targetSchema: z.toJSONSchema(DeploymentOwnServerTargetLinkContentV1Schema, { target: 'draft-7', io: 'input' }),
    linkSchema: z.toJSONSchema(z.strictObject({ machines: DeploymentOwnServerTargetMachinesV1Schema }),
        { target: 'draft-7', io: 'input' }),
    actions: {
        inspect: { kind: 'host', actionId: 'deployments.environments.get' },
        link: { kind: 'host', actionId: 'deployments.targets.link' },
        deploy: { kind: 'host', actionId: 'deployments.deploy' },
        observe: { kind: 'host', actionId: 'deployments.receipts.get' },
        rollback: { kind: 'host', actionId: 'deployments.rollback' },
    },
});

const hostCatalog = createDeploymentTargetCatalogV1([OWN_SERVER_DEPLOYMENT_TARGET_V1]);

/** Qualifies the admitted declaration's local references at the host projection boundary. */
function normalizeTarget(entry: ResolvedDeploymentTargetContribution): DeploymentTargetV1 {
    const roles: Record<string, unknown> = {};
    for (const binding of readDeploymentTargetReferenceRolesV1(entry.definition)) {
        const ref = binding.targetFamily === 'actions'
            ? { kind: 'plugin', actionId: formatQualifiedPluginActionId({ pluginId: entry.pluginId, localId: binding.reference }) }
            : { kind: 'plugin', resourceId: buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: binding.reference }) };
        const group = binding.path[1]!;
        const leaf = binding.path[2];
        if (leaf === undefined) roles[group] = ref;
        else {
            const existing = roles[group];
            const nested = existing && typeof existing === 'object' ? existing : {};
            Object.assign(nested, { [leaf]: ref });
            roles[group] = nested;
        }
    }
    const normalizedRoles = entry.definition.role === 'runtime' ? { actions: roles }
        : entry.definition.dataV1 === undefined ? {} : { dataV1: roles };
    return DeploymentTargetV1Schema.parse({ ...entry.definition, v: 1,
        source: { kind: 'plugin', contribution: entry.identity }, ...normalizedRoles,
        ...(entry.definition.role === 'runtime' && entry.definition.failureTransitionEvent
            ? { failureTransitionEvent: buildQualifiedPluginContributionKey({ pluginId: entry.pluginId,
                localId: entry.definition.failureTransitionEvent }) } : {}),
    });
}

/** One catalog owns host identity; consumers never branch on a target/provider id. */
export function readDeploymentTargetV1(source: DeploymentTargetV1['source'],
    declarations: readonly ResolvedDeploymentTargetContribution[] = [],
): DeploymentTargetV1 | null {
    if (source.kind === 'host') return hostCatalog.read(source);
    const declaration = declarations.find(entry => entry.identity.pluginId === source.contribution.pluginId
        && entry.identity.localId === source.contribution.localId);
    return declaration ? createDeploymentTargetCatalogV1([normalizeTarget(declaration)]).read(source) : null;
}

export function listDeploymentTargetsV1(declarations: readonly ResolvedDeploymentTargetContribution[] = []): readonly DeploymentTargetV1[] {
    return declarations.length === 0 ? hostCatalog.list()
        : createDeploymentTargetCatalogV1([OWN_SERVER_DEPLOYMENT_TARGET_V1, ...declarations.map(normalizeTarget)]).list();
}
