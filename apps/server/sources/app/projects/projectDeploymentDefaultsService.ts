import * as privacyKit from 'privacy-kit';
import { ProjectDeploymentDefaultsPayloadV1Schema, type ProjectDeploymentDefaultsReadInputV1, type ProjectDeploymentDefaultsSetInputV1, type ProjectDeploymentDefaultsOutputV1 } from '@happier-dev/protocol';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readArtifactForCallerInTx, resolveArtifactAudienceInTx } from '@/app/artifacts/artifactAccessService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';
import { readProjectSourceInTx } from './sources/projectSourceService';

type ContentReference = NonNullable<ProjectDeploymentDefaultsSetInputV1['content']>;

export type ProjectDeploymentDefaultsReadInput = ProjectDeploymentDefaultsReadInputV1;

type FailureCode = Extract<ProjectDeploymentDefaultsOutputV1, { ok: false }>['error'];

const failure = (error: FailureCode) => ({ ok: false as const, error });

type Authentication = Partial<TeamOperationAuthenticationContext>;

type DefaultsRow = NonNullable<Awaited<ReturnType<Tx['projectDeploymentDefaults']['findUnique']>>>;


function reference(row: DefaultsRow | null): ContentReference | null {
    return row?.contentArtifactId && row.contentHeaderVersion !== null && row.contentBodyVersion !== null
        && row.contentHeaderVersion > 0 && row.contentBodyVersion > 0
        ? { contentArtifactId: row.contentArtifactId, contentHeaderVersion: row.contentHeaderVersion, contentBodyVersion: row.contentBodyVersion }
        : null;
}


function malformedReference(row: DefaultsRow | null, content: ContentReference | null): boolean {
    return row !== null && (row.contentArtifactId !== null || row.contentHeaderVersion !== null || row.contentBodyVersion !== null) && content === null;
}

/** The existing Artifact owner alone decides mode, key custody and recipient readiness. */

async function admitContentInTx(tx: Tx, actorAccountId: string, projectSourceId: string, content: ContentReference,
    audience: readonly string[] | null, access: 'read' | 'write',
) {
    const read = access === 'write'
        ? await readArtifactForCallerInTx(tx, { actorAccountId, artifactId: content.contentArtifactId })
        : await readArtifactForCallerInTx(tx, { actorAccountId, artifactId: content.contentArtifactId, projection: 'headers' });
    if (!read.ok || read.artifact.publicAudience !== 'none' || read.artifact.kindHint !== 'project-deployment-defaults.v1'
        || (access === 'write' && read.artifact.access === 'view')) return failure('project_defaults_content_unavailable');
    if (read.artifact.headerVersion !== content.contentHeaderVersion || read.artifact.bodyVersion !== content.contentBodyVersion) {
        return failure('project_defaults_conflict');
    }
    if (audience) {
        const artifactAudience = new Set(await resolveArtifactAudienceInTx(tx, content.contentArtifactId));
        if (artifactAudience.size !== audience.length || audience.some(accountId => !artifactAudience.has(accountId))) {
            return failure('project_defaults_content_unavailable');
        }
    }
    if (access === 'write' && read.artifact.encryptionMode === 'plain') {
        if (!read.artifact.body) return failure('project_defaults_content_unavailable');
        const envelope = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(read.artifact.body)));
        if (!envelope.success || typeof envelope.data.body !== 'string') return failure('project_defaults_content_unavailable');
        let body: unknown;
        try { body = JSON.parse(envelope.data.body); } catch { return failure('project_defaults_content_unavailable'); }
        const opened = ProjectDeploymentDefaultsPayloadV1Schema.safeParse(body);
        if (!opened.success || opened.data.projectSourceId !== projectSourceId) return failure('project_defaults_content_unavailable');
    }
    return { ok: true as const };
}

/** Exact Project demand returns only its admitted private Artifact reference, never a body inventory. */

export async function readProjectDeploymentDefaultsInTx(tx: Tx, actorAccountId: string, input: ProjectDeploymentDefaultsReadInput,
    authentication: Authentication = {},
): Promise<ProjectDeploymentDefaultsOutputV1> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return failure('project_defaults_unavailable');
    const source = await readProjectSourceInTx(tx, actorAccountId, { serverId: input.serverId, sourceId: input.projectSourceId }, authentication);
    if (!source.ok) return failure('project_defaults_unavailable');
    const loaded = await readProjectDeploymentDefaultsContentInTx(tx, actorAccountId, input.projectSourceId);
    return loaded.ok ? { ...loaded, projectSourceId: input.projectSourceId, sourceRevision: source.source.revision } : loaded;
}

/** Exact content admission after the caller has admitted the Source in this transaction. */

export async function readProjectDeploymentDefaultsContentInTx(tx: Tx, actorAccountId: string, projectSourceId: string,
    prospectiveOwner?: ProjectSourceOwnerV1,
) {
    const row = await tx.projectDeploymentDefaults.findUnique({ where: { projectSourceId } });
    const content = reference(row);
    if (malformedReference(row, content)) return failure('project_defaults_content_unavailable');
    if (content) {
        const admitted = await admitContentInTx(tx, actorAccountId, projectSourceId, content, null, 'read');
        if (!admitted.ok) return admitted;
        // A member's direct grant cannot replace the future Team's durable write grant.
        if (prospectiveOwner?.kind === 'team' && !await tx.artifactTeamGrant.findFirst({ where: {
            artifactId: content.contentArtifactId, teamId: prospectiveOwner.teamId,
            accessLevel: { in: ['edit', 'admin'] }, team: { archivedAt: null },
        }, select: { artifactId: true } })) return failure('project_defaults_content_unavailable');
        if (prospectiveOwner?.kind === 'account') {
            const ownerRead = await admitContentInTx(tx, prospectiveOwner.accountId, projectSourceId, content, null, 'write');
            if (!ownerRead.ok) return ownerRead;
        }
    }
    return { ok: true as const, revision: row?.revision ?? 0, content };
}

/** Source and content revisions bind one prepared defaults leaf; configured domain records are untouched. */
