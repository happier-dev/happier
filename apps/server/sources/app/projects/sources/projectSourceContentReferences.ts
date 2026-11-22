import {
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1,
    PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1,
} from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import type { Tx } from '@/storage/inTx';
import type { ResourceAccessLevelV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

export interface ProjectSourceContentReference {
    readonly projectSourceId: string;
    readonly contentArtifactId: string;
    readonly contentHeaderVersion: number;
    readonly contentBodyVersion: number;
    readonly expectedStoredKind: string;
}

const contentSelect = { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } as const;

/** Read access never permits widening another person's setup through a Source. */
export function mayPublishProjectSourceSetupArtifact(actorAccountId: string, artifactOwnerAccountId: string): boolean {
    return actorAccountId === artifactOwnerAccountId;
}

/** Setup is selected by its Source id; never reverse-scan the Source JSON catalog. */
export function projectSourceSetupContentReference(source: ProjectSourceV1): ProjectSourceContentReference | null {
    const attachment = source.attachments?.find(item => item.purpose === 'setup');
    return attachment?.purpose === 'setup' ? { projectSourceId: source.id, contentArtifactId: attachment.ref.artifactId,
        contentHeaderVersion: attachment.contentRevision.headerVersion, contentBodyVersion: attachment.contentRevision.bodyVersion,
        expectedStoredKind: PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } : null;
}

/** Defaults need durable write custody; deployment definitions and receipts require admin custody. */
export function projectSourceContentTeamCustodyLevels(storedKind: string): ResourceAccessLevelV1[] {
    return storedKind === PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1 ? ['edit', 'admin'] : ['admin'];
}

/** Existing private-content relations only; ordinary Source attachments keep independent Artifact access. */
export async function readProjectSourceContentReferencesInTx(tx: Tx,
    input: Readonly<{ sourceIds: readonly string[] }>
        | Readonly<{ artifactIds: readonly string[]; receiptStates?: readonly string[] }>,
): Promise<ProjectSourceContentReference[]> {
    const references: ProjectSourceContentReference[] = [];
    const receiptStates = 'artifactIds' in input ? input.receiptStates : undefined;
    for (const ids of portableQueryChunks({ values: [...new Set('sourceIds' in input ? input.sourceIds : input.artifactIds)],
        bindingsPerValue: 1, fixedBindings: 1 + (receiptStates?.length ?? 0) })) {
        const sourceWhere = 'sourceIds' in input ? { projectSourceId: { in: [...ids] } } : {};
        const artifactWhere = 'artifactIds' in input ? { contentArtifactId: { in: [...ids] } } : {};
        const environmentWhere = 'sourceIds' in input ? { environment: sourceWhere } : {};
        const [defaults, environments, links, receipts, domains] = await Promise.all([
            tx.projectDeploymentDefaults.findMany({ where: { ...sourceWhere, ...artifactWhere },
                select: { projectSourceId: true, ...contentSelect } }),
            tx.deploymentEnvironment.findMany({ where: { ...sourceWhere, ...artifactWhere },
                select: { projectSourceId: true, ...contentSelect } }),
            tx.deploymentTargetLink.findMany({ where: { ...environmentWhere, ...artifactWhere },
                select: { environment: { select: { projectSourceId: true } }, ...contentSelect } }),
            tx.deployment.findMany({ where: { ...environmentWhere, ...artifactWhere,
                ...(receiptStates ? { state: { in: [...receiptStates] } } : {}) },
                select: { environment: { select: { projectSourceId: true } }, ...contentSelect } }),
            tx.deploymentDomain.findMany({ where: { ...environmentWhere, ...artifactWhere },
                select: { environment: { select: { projectSourceId: true } }, ...contentSelect } }),
        ]);
        for (const row of defaults) if (row.contentArtifactId && row.contentHeaderVersion !== null && row.contentBodyVersion !== null) {
            references.push({ projectSourceId: row.projectSourceId, contentArtifactId: row.contentArtifactId,
                contentHeaderVersion: row.contentHeaderVersion, contentBodyVersion: row.contentBodyVersion,
                expectedStoredKind: PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1 });
        }
        for (const row of environments) references.push({ ...row, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 });
        for (const [rows, expectedStoredKind] of [
            [links, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1],
            [receipts, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1],
            [domains, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1],
        ] as const) for (const { environment, ...content } of rows) {
            if (content.contentArtifactId !== null) {
                references.push({ ...content, contentArtifactId: content.contentArtifactId, projectSourceId: environment.projectSourceId, expectedStoredKind });
            }
        }
    }
    return references;
}

export function isProjectSourceContentStoredKind(kind: string | null): boolean {
    return kind === PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 || kind === PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1
        || kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 || kind === DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1
        || kind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 || kind === DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1;
}
