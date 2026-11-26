import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { AccountStatus, TeamMembershipStatus } from '@/storage/enums.generated';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import {
    acquireTeamCredentialBrokerPoolAdmissionInTx,
    clearTeamCredentialBrokerPoolReferencesInTx,
    readTeamCredentialBrokerPoolReferenceSummaryInTx,
} from './resourceBrokerPoolLifecycle';

async function createScope() {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const pool = await db.machinePool.create({ data: {
        id: crypto.randomUUID(),
        accountId: account.id,
        name: storedPlainPrivateLabel('Credential broker Pool'),
    } });
    return { custodianAccountId: account.id, poolId: pool.id };
}

async function createTeam(name: string, accountId: string) {
    return await db.team.create({ data: {
        name,
        memberships: { create: { accountId, role: 'member' } },
    } });
}

async function createReference(id: string, teamId: string, scope: { custodianAccountId: string; poolId: string }) {
    return await db.teamCredentialResource.create({ data: {
        id,
        teamId,
        custodianAccountId: scope.custodianAccountId,
        displayName: 'Saved provider',
        disclosureCeiling: 'brokered_only',
        sessionUsePolicy: 'personal_allowed',
        sourceBindingJson: JSON.stringify({
            v: 1,
            kind: 'provider_connection',
            connectionId: 'fixture-connection',
            connectionSecurityFingerprint: 'connection-security:v1:fixture',
            credentialSlotId: 'apiKey',
        }),
        brokerPoolId: scope.poolId,
    } });
}

function readSummary(scope: { custodianAccountId: string; poolId: string }) {
    return inTx(tx => readTeamCredentialBrokerPoolReferenceSummaryInTx(tx, scope));
}

describe('Team credential broker Pool reference summary', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({
            tempDirPrefix: 'team-broker-pool-reference-summary-',
            initAuth: false,
        });
    }, 180_000);

    afterAll(async () => { await harness?.close(); });

    it('returns a stable empty summary and excludes references belonging to a foreign custodian', async () => {
        const scope = await createScope();
        const empty = await readSummary(scope);
        expect(empty).toEqual({ assignmentCount: 0, visibleTeamNames: [], witness: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(await readSummary(scope)).toEqual(empty);

        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await createTeam('Foreign credential Team', scope.custodianAccountId);
        await createReference('foreign-resource', team.id, { ...scope, custodianAccountId: foreign.id });
        expect(await readSummary(scope)).toEqual(empty);
    });

    it('counts each assignment and returns distinct trimmed Team names in sorted order', async () => {
        const scope = await createScope();
        const zulu = await createTeam('  Zulu  ', scope.custodianAccountId);
        const alpha = await createTeam('Alpha', scope.custodianAccountId);
        const sameName = await createTeam(' Alpha ', scope.custodianAccountId);
        const blank = await createTeam('   ', scope.custodianAccountId);
        await createReference('visible-zulu-one', zulu.id, scope);
        await createReference('visible-zulu-two', zulu.id, scope);
        expect(await readSummary(scope)).toMatchObject({ assignmentCount: 2, visibleTeamNames: ['Zulu'] });

        await createReference('visible-alpha', alpha.id, scope);
        expect(await readSummary(scope)).toMatchObject({ assignmentCount: 3, visibleTeamNames: ['Alpha', 'Zulu'] });

        await createReference('visible-same-name', sameName.id, scope);
        await createReference('visible-blank-name', blank.id, scope);
        const otherPool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: scope.custodianAccountId,
            name: storedPlainPrivateLabel('Another Pool'),
        } });
        await createReference('other-pool-resource', alpha.id, { ...scope, poolId: otherPool.id });
        expect(await readSummary(scope)).toMatchObject({ assignmentCount: 5, visibleTeamNames: ['Alpha', 'Zulu'] });
    });

    it('hides names after membership removal or suspension and Account suspension while retaining assignments in the witness', async () => {
        const scope = await createScope();
        const departed = await createTeam('Departed Team', scope.custodianAccountId);
        const suspended = await createTeam('Suspended membership Team', scope.custodianAccountId);
        const current = await createTeam('Current Team', scope.custodianAccountId);
        await createReference('departed-resource', departed.id, scope);
        await createReference('suspended-resource', suspended.id, scope);
        await createReference('current-resource', current.id, scope);
        const active = await readSummary(scope);
        expect(active).toEqual({
            assignmentCount: 3,
            visibleTeamNames: ['Current Team', 'Departed Team', 'Suspended membership Team'],
            witness: expect.stringMatching(/^[a-f0-9]{64}$/),
        });

        const membership = (teamId: string) => ({ teamId_accountId: { teamId, accountId: scope.custodianAccountId } });
        await db.teamMembership.delete({ where: membership(departed.id) });
        await db.teamMembership.update({ where: membership(suspended.id), data: { status: TeamMembershipStatus.suspended } });
        expect(await readSummary(scope)).toEqual({ ...active, visibleTeamNames: ['Current Team'] });

        await db.account.update({ where: { id: scope.custodianAccountId }, data: { status: AccountStatus.suspended } });
        expect(await readSummary(scope)).toEqual({ ...active, visibleTeamNames: [] });

        await db.teamCredentialResource.update({ where: { id: 'departed-resource' }, data: { revision: { increment: 1 } } });
        const revised = await readSummary(scope);
        expect(revised).toMatchObject({ assignmentCount: 3, visibleTeamNames: [] });
        expect(revised.witness).not.toBe(active.witness);
    });

    it('changes the witness on replacement and revision advance and restores the empty witness after cleanup', async () => {
        const scope = await createScope();
        const team = await createTeam('Broker Team', scope.custodianAccountId);
        const empty = await readSummary(scope);
        const first = await createReference('replacement-original', team.id, scope);
        const original = await readSummary(scope);
        expect(original).toMatchObject({ assignmentCount: 1, visibleTeamNames: ['Broker Team'] });
        expect(original.witness).not.toBe(empty.witness);

        await db.teamCredentialResource.delete({ where: { id: first.id } });
        const replacement = await createReference('replacement-successor', team.id, scope);
        const replaced = await readSummary(scope);
        expect(replaced).toMatchObject({ assignmentCount: 1, visibleTeamNames: ['Broker Team'] });
        expect(replaced.witness).not.toBe(original.witness);

        await db.teamCredentialResource.update({ where: { id: replacement.id }, data: { revision: { increment: 1 } } });
        const revised = await readSummary(scope);
        expect(revised).toMatchObject({ assignmentCount: 1, visibleTeamNames: ['Broker Team'] });
        expect(revised.witness).not.toBe(replaced.witness);
        expect(await readSummary(scope)).toEqual(revised);

        await inTx(async tx => {
            await acquireTeamCredentialBrokerPoolAdmissionInTx(tx, scope);
            await clearTeamCredentialBrokerPoolReferencesInTx(tx, scope);
            await expect(readTeamCredentialBrokerPoolReferenceSummaryInTx(tx, scope)).resolves.toEqual(empty);
        });
        expect(await readSummary(scope)).toEqual(empty);
    });
});
