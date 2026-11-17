import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import { ProjectDeploymentDefaultsPayloadV1Schema, type ProjectDeploymentDefaultsReadInputV1,
    type ProjectDeploymentDefaultsSetInputV1, type ProjectDeploymentDefaultsChangeHintV1,
    type ProjectDeploymentDefaultsOutputV1 } from '@happier-dev/protocol';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_KIND_V1,
    PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { projectSourceContentTeamCustodyLevels } from './sources/projectSourceContentReferences';
import { isDeploymentEnvironmentUpdateNativeAdmissionV1, isDeploymentBackupConfigureNativeAdmissionV1, isDeploymentTelemetryNativeAdmissionV1, type ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readArtifactForCallerInTx, resolveArtifactAudienceInTx } from '@/app/artifacts/artifactAccessService';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';
import { lockProjectSourceForDefaultsInTx } from './sources/projectSourceWriteLock';
import { resolveProjectSourceAccessInTx, readProjectSourceCustodyInTx, resolveProjectSourceAudienceInTx } from './sources/projectSourceService';

type ContentReference = NonNullable<ProjectDeploymentDefaultsSetInputV1['content']>;
export type ProjectDeploymentDefaultsReadInput = ProjectDeploymentDefaultsReadInputV1;
export type ProjectDeploymentDefaultsSetInput = ProjectDeploymentDefaultsSetInputV1;
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
    if (!read.ok || read.artifact.publicAudience !== 'none' || read.artifact.kindHint !== PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_KIND_V1
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

/** Admit new Source demand once; signed preparation consumes its captured Source before the same content read. */
export async function readProjectDeploymentDefaultsInTx(tx: Tx, actorAccountId: string, input: ProjectDeploymentDefaultsReadInput,
    authentication: Authentication = {},
    admittedBinding?: ExternalActionExecutionAuthorizationBindingV1,
): Promise<ProjectDeploymentDefaultsOutputV1> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return failure('project_defaults_unavailable');
    let sourceRevision: number;
    const native = admittedBinding?.deploymentNativeAdmission;
    if (admittedBinding && (isDeploymentBackupConfigureNativeAdmissionV1(native) || isDeploymentTelemetryNativeAdmissionV1(native)
        || admittedBinding.actionId === 'deployments.environments.update'
            && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) && native.defaultsFor !== undefined)) {
        // The HTTP purpose owner already bound this exact Source to the admitted Environment.
        // Consume custody for the response revision; do not re-admit Source management.
        if (admittedBinding.accountId !== actorAccountId || admittedBinding.serverIdentityId !== input.serverId)
            return failure('project_defaults_unavailable');
        const custody = await readProjectSourceCustodyInTx(tx, input.projectSourceId);
        if (!custody) return failure('project_defaults_unavailable');
        sourceRevision = custody.source.revision;
    } else if (admittedBinding?.deploymentPreparationAdmission) {
        const preparation = admittedBinding.deploymentPreparationAdmission;
        const source: Readonly<{ id: string; revision?: number }> | undefined = preparation.operation === 'setup'
            ? preparation.catalogSources?.find(selected => selected.source.id === input.projectSourceId)?.source
            : 'source' in preparation ? preparation.source : undefined;
        if (admittedBinding.accountId !== actorAccountId || admittedBinding.serverIdentityId !== input.serverId
            || !source || source.id !== input.projectSourceId) return failure('project_defaults_unavailable');
        if (source.revision !== undefined) {
            sourceRevision = source.revision;
        } else {
            // Setup/create capture Source identity only; the response still needs its metadata revision.
            const custody = await readProjectSourceCustodyInTx(tx, source.id);
            if (!custody) return failure('project_defaults_unavailable');
            sourceRevision = custody.source.revision;
        }
    } else {
        const source = await resolveProjectSourceAccessInTx(tx, actorAccountId, input.projectSourceId, authentication);
        if (!source.ok) return failure('project_defaults_unavailable');
        sourceRevision = source.source.revision;
    }
    const loaded = await readProjectDeploymentDefaultsContentInTx(tx, actorAccountId, input.projectSourceId);
    return loaded.ok ? { ...loaded, projectSourceId: input.projectSourceId, sourceRevision } : loaded;
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
        if (prospectiveOwner?.kind === 'team' && !await tx.artifactGrant.findFirst({ where: { principalKind: 'team',
            artifactId: content.contentArtifactId, teamId: prospectiveOwner.teamId,
            accessLevel: { in: projectSourceContentTeamCustodyLevels(PROJECT_DEPLOYMENT_DEFAULTS_ARTIFACT_STORED_KIND_V1) },
            team: { archivedAt: null },
        }, select: { artifactId: true } })) return failure('project_defaults_content_unavailable');
        if (prospectiveOwner?.kind === 'account') {
            const ownerRead = await admitContentInTx(tx, prospectiveOwner.accountId, projectSourceId, content, null, 'write');
            if (!ownerRead.ok) return ownerRead;
        }
    }
    return { ok: true as const, revision: row?.revision ?? 0, content };
}

/** Source and content revisions bind one prepared defaults leaf; configured domain records are untouched. */
export async function setProjectDeploymentDefaultsInTx(tx: Tx, actorAccountId: string, input: ProjectDeploymentDefaultsSetInput,
    authentication: Authentication = {},
): Promise<ProjectDeploymentDefaultsOutputV1> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return failure('project_defaults_unavailable');
    // Serialize the first leaf insertion with Source authority changes at its existing parent.
    await lockProjectSourceForDefaultsInTx(tx, input.projectSourceId);
    const source = await resolveProjectSourceAccessInTx(tx, actorAccountId, input.projectSourceId, authentication);
    if (!source.ok) return failure('project_defaults_unavailable');
    if (!source.canManage) return failure('project_defaults_access_denied');
    const row = await tx.projectDeploymentDefaults.findUnique({ where: { projectSourceId: input.projectSourceId } });
    const previous = reference(row);
    if (malformedReference(row, previous)) return failure('project_defaults_content_unavailable');
    if (source.source.revision !== input.expectedSourceRevision || (row?.revision ?? 0) !== input.expectedRevision) {
        return failure('project_defaults_conflict');
    }
    const audience = await resolveProjectSourceAudienceInTx(tx, [source.source]);
    if (input.content) {
        const admitted = await admitContentInTx(tx, actorAccountId, input.projectSourceId, input.content, audience, 'write');
        if (!admitted.ok) return admitted;
    }
    if (isDeepStrictEqual(previous, input.content)) {
        return { ok: true as const, projectSourceId: input.projectSourceId, sourceRevision: source.source.revision, revision: row?.revision ?? 0, content: input.content };
    }
    const data = input.content ?? { contentArtifactId: null, contentHeaderVersion: null, contentBodyVersion: null };
    if (row) {
        const changed = await tx.projectDeploymentDefaults.updateMany({ where: { projectSourceId: input.projectSourceId, revision: input.expectedRevision },
            data: { ...data, revision: { increment: 1 } } });
        if (changed.count !== 1) return failure('project_defaults_conflict');
    } else {
        await tx.projectDeploymentDefaults.create({ data: { projectSourceId: input.projectSourceId, ...data } });
    }
    const revision = input.expectedRevision + 1;
    await markAccountsChanged(tx, { accountIds: audience, entityId: `projects:${input.projectSourceId}:deploymentDefaults`,
        hint: { projectSourceId: input.projectSourceId, key: 'deploymentDefaults', revision } satisfies ProjectDeploymentDefaultsChangeHintV1 });
    return { ok: true as const, projectSourceId: input.projectSourceId, sourceRevision: source.source.revision, revision, content: input.content };
}
