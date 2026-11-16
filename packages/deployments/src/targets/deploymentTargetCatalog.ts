import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';
import { readDeploymentTargetReferenceRolesV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { DeploymentTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

export type DeploymentTargetDeclarationV1 = Readonly<{ pluginId: string; identity: PluginContributionIdentityV1; definition: DeploymentTargetContributionV1 }>;
import { DeploymentOwnServerTargetLinkContentV1Schema, DeploymentTargetV1Schema,
    type DeploymentTargetV1 } from '@happier-dev/deployment-protocol/v1';

/** The consumed S0 daemon contribution. Role references use the public Action front door. */
export const OWN_SERVER_DEPLOYMENT_TARGET_V1: DeploymentTargetV1 = DeploymentTargetV1Schema.parse({
    v: 1, id: 'own-server', ...readOwnServerDeploymentTargetDeclarationV1(),
    role: 'runtime', targetKind: 'ownServer', title: 'Own server', icon: 'server-outline',
    accepts: ['static', 'server', 'container', 'compose'], needs: [],
    sources: { gitIntegration: ['github', 'gitlab', 'bitbucket', 'azure-devops'], upload: false },
    targetSchema: z.toJSONSchema(DeploymentOwnServerTargetLinkContentV1Schema, { target: 'draft-7', io: 'input' }),
    linkSchema: z.toJSONSchema(z.strictObject({ machines: DeploymentOwnServerTargetMachinesV1Schema }),
        { target: 'draft-7', io: 'input' }),
});

const hostCatalog = createDeploymentTargetCatalogV1([OWN_SERVER_DEPLOYMENT_TARGET_V1]);

/** Qualifies the admitted declaration's local references at the host projection boundary. */
function normalizeTarget(entry: DeploymentTargetDeclarationV1): DeploymentTargetV1 {
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
    if (entry.definition.role === 'data' && entry.definition.dataV1?.database !== undefined) {
        roles.database = entry.definition.dataV1.database;
    }
    if (entry.definition.role === 'data' && entry.definition.dataV1?.branches?.previewInput !== undefined) {
        const branches = roles.branches ?? {};
        Object.assign(branches, { previewInput: entry.definition.dataV1.branches.previewInput });
        roles.branches = branches;
    }
    const normalizedRoles = entry.definition.role === 'runtime' ? { actions: roles }
        : entry.definition.dataV1 === undefined ? {} : { dataV1: roles };
    return DeploymentTargetV1Schema.parse({ ...entry.definition, v: 1,
        source: { kind: 'plugin', contribution: entry.identity }, ...normalizedRoles,
    });
}

/** One catalog owns host identity; consumers never branch on a target/provider id. */
export function readDeploymentTargetV1(source: DeploymentTargetV1['source'],
    declarations: readonly DeploymentTargetDeclarationV1[] = [],
): DeploymentTargetV1 | null {
    if (source.kind === 'host') return hostCatalog.read(source);
    const declaration = declarations.find(entry => entry.identity.pluginId === source.contribution.pluginId
        && entry.identity.localId === source.contribution.localId);
    return declaration ? createDeploymentTargetCatalogV1([normalizeTarget(declaration)]).read(source) : null;
}

export function listDeploymentTargetsV1(declarations: readonly DeploymentTargetDeclarationV1[] = []): readonly DeploymentTargetV1[] {
    return declarations.length === 0 ? hostCatalog.list()
        : createDeploymentTargetCatalogV1([OWN_SERVER_DEPLOYMENT_TARGET_V1, ...declarations.map(normalizeTarget)]).list();
}

/** Account clients and Machine hosts normalize the same admitted deployment-target declarations. */
export function listDeploymentTargetsFromManifestsV1(declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[]): readonly DeploymentTargetV1[] {
    return listDeploymentTargetsV1(declarations.flatMap(({ manifest }) => (manifest.contributes.deploymentTargets ?? []).map(definition => ({
        pluginId: manifest.id, identity: { pluginId: manifest.id, localId: definition.id }, definition,
    }))));
}


/** Readable during cyclic host initialization: this declaration uses no module-initialized values. */
export function readOwnServerDeploymentTargetDeclarationV1() {
    return {
        source: { kind: 'host', id: 'own-server' },
        actions: {
            inspect: { kind: 'host', actionId: 'deployments.environments.get' },
            link: { kind: 'host', actionId: 'deployments.targets.link' },
            deploy: { kind: 'host', actionId: 'deployments.deploy' },
            observe: { kind: 'host', actionId: 'deployments.receipts.get' },
            rollback: { kind: 'host', actionId: 'deployments.rollback' },
            teardown: { kind: 'host', actionId: 'deployments.teardown' },
        },
    } as const satisfies Pick<Extract<DeploymentTargetV1, { role: 'runtime' }>, 'source' | 'actions'>;
}

/** Native runtime Actions shared by the target declaration and its capability projections. */
export const { source: OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1, actions: OWN_SERVER_DEPLOYMENT_TARGET_ACTIONS_V1 }
    = readOwnServerDeploymentTargetDeclarationV1();

/** Resource removal follows the target's declared teardown role; an unlinked record has no workload to stop. */
export function selectDeploymentTargetTeardownAvailableV1(
    source: DeploymentTargetV1['source'] | undefined,
    targets: readonly Readonly<{ pluginId: string; targetId: string; teardown?: true }>[],
): boolean {
    if (!source) return true;
    if (source.kind === 'host') return source.id === OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1.id
        && Boolean(OWN_SERVER_DEPLOYMENT_TARGET_ACTIONS_V1.teardown);
    return targets.some(target => target.pluginId === source.contribution.pluginId
        && target.targetId === source.contribution.localId && target.teardown === true);
}

/** One removal choice owner for app and Action preparation; historical links are adopted. */
export function selectDeploymentTargetRemovalChoicesV1(
    source: DeploymentTargetV1['source'] | undefined,
    targets: Parameters<typeof selectDeploymentTargetTeardownAvailableV1>[1],
    origin?: 'created',
): Readonly<{ choices: readonly ('unlink' | 'delete')[]; defaultChoice: 'unlink' | 'delete' }> {
    const available = selectDeploymentTargetTeardownAvailableV1(source, targets);
    return { choices: available ? ['unlink', 'delete'] : ['unlink'],
        defaultChoice: available && origin === 'created' ? 'delete' : 'unlink' };
}

export interface DeploymentTargetCatalogV1 {
    list(): readonly DeploymentTargetV1[];
    read(source: DeploymentTargetV1['source']): DeploymentTargetV1 | null;
}

function sourceKey(source: DeploymentTargetV1['source']): string {
    return source.kind === 'host' ? JSON.stringify(['host', source.id])
        : JSON.stringify(['plugin', source.contribution.pluginId, source.contribution.localId]);
}

/** Consumes admitted normalized targets; declaration and invocation admission stay with their owners. */
export function createDeploymentTargetCatalogV1(targets: readonly DeploymentTargetV1[]): DeploymentTargetCatalogV1 {
    const bySource = new Map<string, DeploymentTargetV1>();
    for (const target of targets) {
        const key = sourceKey(target.source);
        if (bySource.has(key)) throw new TypeError('Duplicate admitted deployment target identity.');
        bySource.set(key, target);
    }
    const list = Object.freeze([...targets]);
    return Object.freeze({
        list: () => list,
        read: (source: DeploymentTargetV1['source']) => bySource.get(sourceKey(source)) ?? null,
    });
}


/** Both hosts consume the normalized catalog; no suggestion-specific target list is maintained. */
export function projectDeploymentSuggestionTargetsV1(targets: readonly DeploymentTargetV1[]): Pick<DeploySuggestionCatalogV1, 'targets' | 'stores'> {
    return {
        targets: targets.flatMap(target => target.role === 'runtime' ? [{
            id: target.source.kind === 'host' ? target.source.id
                : buildQualifiedPluginContributionKey(target.source.contribution),
            title: resolvePluginLocalizedStringV2Text(target.title),
            targetClass: target.source.kind === 'host' ? 'ownServer' as const : 'platform' as const,
            availability: 'available' as const,
            ...(target.accepts === undefined ? {} : { accepts: target.accepts }),
            ...(target.needs === undefined ? {} : { needs: target.needs }),
            ...(target.sources === undefined ? {} : { sources: target.sources }),
        }] : []),
        // An engine association does not identify a selected saved store.
        // Linked-store discovery remains with the selected-target owner.
        stores: [],
    };
}
