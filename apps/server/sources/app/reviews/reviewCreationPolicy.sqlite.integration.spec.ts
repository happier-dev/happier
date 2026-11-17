import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { REVIEW_ARTIFACT_KIND_V1, ReviewArtifactHeaderV1Schema, ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { setTeamPolicyInTx } from '@/app/teams/policy';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { removeArtifactAccessGrantInTx, setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';

function reviewContent(artifactId: string) {
    const header = ReviewArtifactHeaderV1Schema.parse({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: artifactId, title: 'Policy review' });
    const body = ReviewArtifactBodyV1Schema.parse({ v: 1, rounds: [{ ordinal: 1, state: 'running', startedAt: 10,
        finishedAt: null, reviewerIds: ['reviewer'], runs: [] }] });
    return { header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(header)),
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) };
}

describe('Review Team creation policy (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'review-team-policy-', initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'server_sealed' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('uses independent project Team policy once at create, leaving old audiences intact after policy changes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Review Team', sessionCreationPolicy: 'team_required' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId: 'home', requestKey: crypto.randomUUID(), name: 'Review project', owner: { kind: 'team', teamId: team.id }, audience: [],
        }));
        expect(source).toMatchObject({ ok: true });
        if (!source.ok) throw new Error(source.error);
        const create = (artifactId: string, projectSourceId: string | null = source.source.id) => createArtifact({ actorUserId: owner.id, artifactId,
            ...reviewContent(artifactId),
            ...{ reviewMetadata: { projectSourceId, workflowId: null, subjectKind: 'comparison' as const,
                sourceKind: 'direct' as const, state: 'running' as const, currentRoundOrdinal: 1, startedAt: 10, finishedAt: null } },
        });
        const privateId = crypto.randomUUID();
        expect(await create(privateId)).toMatchObject({ ok: true, didWrite: true });
        expect(await db.artifactGrant.findMany({ where: { artifactId: privateId } })).toEqual([]);
        expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, reviewCreationPolicy: 'team_default' }))).toMatchObject({ ok: true });
        const defaultId = crypto.randomUUID();
        expect(await create(defaultId)).toMatchObject({ ok: true, didWrite: true });
        expect(await db.artifactGrant.findMany({ where: { artifactId: defaultId } })).toMatchObject([
            { principalKind: 'team', teamId: team.id, accessLevel: 'edit', requiredByTeamPolicy: false },
        ]);
        expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, reviewCreationPolicy: 'team_required' }))).toMatchObject({ ok: true });
        const requiredId = crypto.randomUUID();
        expect(await create(requiredId)).toMatchObject({ ok: true, didWrite: true });
        expect(await db.artifactGrant.findMany({ where: { artifactId: requiredId } })).toMatchObject([
            { principalKind: 'team', teamId: team.id, accessLevel: 'edit', requiredByTeamPolicy: true },
        ]);
        const requiredAudience = { actorAccountId: owner.id, artifactId: requiredId, principal: { kind: 'team' as const, teamId: team.id } };
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { ...requiredAudience, accessLevel: 'view' })))
            .toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, requiredAudience)))
            .toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        const nonprojectId = crypto.randomUUID();
        expect(await create(nonprojectId, null)).toMatchObject({ ok: true, didWrite: true });
        expect(await db.artifactGrant.findMany({ where: { artifactId: nonprojectId } })).toEqual([]);
        const inaccessibleId = crypto.randomUUID();
        expect(await create(inaccessibleId, crypto.randomUUID())).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        expect(await db.artifact.findUnique({ where: { id: inaccessibleId } })).toBeNull();
        expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, reviewCreationPolicy: 'private_default' }))).toMatchObject({ ok: true });
        expect(await create(requiredId)).toMatchObject({ ok: true, didWrite: false });
        expect(await db.artifactGrant.findMany({ where: { artifactId: requiredId } })).toMatchObject([{ requiredByTeamPolicy: true }]);
        expect(await db.artifactGrant.findMany({ where: { artifactId: defaultId } })).toMatchObject([{ requiredByTeamPolicy: false }]);
        expect(await db.artifactGrant.findMany({ where: { artifactId: privateId } })).toEqual([]);
        expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).sessionCreationPolicy).toBe('team_required');
    });

    it.each(['private_default', 'team_default', 'team_required'] as const)('applies current source Team external policy at a new grant admission with %s', async reviewCreationPolicy => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [outsider.id]);
        const team = await db.team.create({ data: { name: 'Restricted Review Team', externalSharingPolicy: 'disabled', reviewCreationPolicy } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId: 'home', requestKey: crypto.randomUUID(), name: 'Private Review project', owner: { kind: 'team', teamId: team.id }, audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const artifactId = crypto.randomUUID();
        expect(await createArtifact({ actorUserId: owner.id, artifactId,
            ...reviewContent(artifactId),
            ...{ reviewMetadata: { projectSourceId: source.source.id, workflowId: null, subjectKind: 'comparison' as const,
                sourceKind: 'direct' as const, state: 'running' as const, currentRoundOrdinal: 1, startedAt: 10, finishedAt: null } },
        })).toMatchObject({ ok: true });
        const originalAudience = await db.artifactGrant.findMany({ where: { artifactId } });
        const input = { artifactId, actorAccountId: owner.id, principal: { kind: 'account' as const, accountId: outsider.id }, accessLevel: 'view' as const };
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, input))).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
        expect(await db.artifactGrant.findMany({ where: { artifactId } })).toEqual(originalAudience);
        expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, externalSharingPolicy: 'allowed' }))).toMatchObject({ ok: true });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, input))).toMatchObject({ ok: true });
        expect(await db.artifactGrant.findMany({ where: { artifactId, accountId: outsider.id } })).toMatchObject([{ accountId: outsider.id, accessLevel: 'view' }]);
    });

});
