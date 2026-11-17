import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { ArtifactMutationAdmission } from '@/app/artifacts/artifactAccessService';
import { resolveProjectSourceAccessInTx } from '@/app/projects/sources/projectSourceService';
import { projectTeamCreationPolicy } from '@/app/teams/creationPolicy';
import { validateResourceGrantPrincipalsInTx } from '@/app/teams/resourceGrantAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { enforceTeamExternalSharingPolicyInTx, isSubjectExternalToTeamInTx } from '@/app/session/access/sessionAccessExternalSharingPolicy';

async function resolveReviewProjectTeamIdsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; projectSourceId: string; authentication?: SessionAccessAuthentication;
}>): Promise<readonly string[] | null> {
    const access = await resolveProjectSourceAccessInTx(tx, input.actorAccountId, input.projectSourceId,
        input.authentication ? { env: input.authentication.env, authenticationAuthority: input.authentication.authority,
            authenticationEvidence: input.authentication.authenticationEvidence } : {});
    if (!access.ok) return null;
    return [...new Set([access.owner, ...access.source.audience.map(grant => grant.principal)]
        .flatMap(principal => principal.kind === 'account' ? [] : [principal.teamId]))];
}

/** A new Review chooses its audience once; updates and exact-id retries do not call this owner. */
export async function resolveReviewCreationPolicyInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; projectSourceId: string | null; authentication?: SessionAccessAuthentication;
}>): Promise<ArtifactMutationAdmission | null> {
    if (input.projectSourceId === null) return { publicationGrants: [] };
    const teamIds = await resolveReviewProjectTeamIdsInTx(tx, { ...input, projectSourceId: input.projectSourceId });
    if (!teamIds) return null;
    const teams = (await Promise.all(portableQueryChunks({ values: teamIds, bindingsPerValue: 1, fixedBindings: 1 }).map(ids =>
        tx.team.findMany({ where: { id: { in: [...ids] } }, select: { id: true, reviewCreationPolicy: true } })))).flat();
    const publicationGrants: ArtifactMutationAdmission['publicationGrants'] = teams.flatMap(team => {
        const decision = projectTeamCreationPolicy(team.reviewCreationPolicy);
        return decision.defaultGrant ? [{ principal: { kind: 'team' as const, teamId: team.id },
            accessLevel: decision.defaultGrant.accessLevel, requiredByTeamPolicy: decision.requiredByPolicy }] : [];
    });
    const error = publicationGrants.length > 0 ? await validateResourceGrantPrincipalsInTx(tx, {
        actorAccountId: input.actorAccountId, ownerAccountId: input.actorAccountId,
        principals: publicationGrants.map(grant => grant.principal), hasExistingGrant: false,
    }) : null;
    return error ? null : { publicationGrants };
}

/** A later grant increase uses current Source Team policy without rewriting any existing audience. */
export async function mayAdmitReviewExternalGrantInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string; principal: PrincipalRefV1; authentication?: SessionAccessAuthentication;
}>): Promise<boolean> {
    const metadata = await tx.reviewMetadata.findUnique({ where: { artifactId: input.artifactId }, select: { projectSourceId: true } });
    if (!metadata || metadata.projectSourceId === null) return true;
    const teamIds = await resolveReviewProjectTeamIdsInTx(tx, { ...input, projectSourceId: metadata.projectSourceId });
    if (!teamIds) return false;
    for (const primaryTeamId of teamIds) {
        if (!await isSubjectExternalToTeamInTx(tx, { primaryTeamId, subject: input.principal })) continue;
        if (await enforceTeamExternalSharingPolicyInTx(tx, { actorAccountId: input.actorAccountId, primaryTeamId,
            authentication: input.authentication ?? { env: process.env, authority: 'account_automation', authenticationEvidence: undefined } })) return false;
    }
    return true;
}
