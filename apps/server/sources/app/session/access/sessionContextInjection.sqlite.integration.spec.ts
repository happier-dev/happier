import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "./sessionAccessAuthentication.testkit";
import * as contextInjection from "./sessionContextInjection";
import { artifactGrantStorageAdapter } from '@/app/artifacts/artifactGrantStorageAdapter';
import { resolveResourceGrantAccessInTx } from '@/app/teams/resourceGrantAccess';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';
import { readSessionMessagePage } from '@/app/api/routes/session/registerSessionMessageRoutes';

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

/** Builds the verified destination-runtime principal from the test's custody Account. */
function admitRuntime(
    tx: Tx,
    input: { authenticatedAccountId: string; sourceSessionId: string; destinationSessionId: string },
) {
    return contextInjection.assertSessionFollowSourceReadInTx(tx, {
        principal: {
            kind: "destination_runtime",
            destinationRuntimeAccountId: input.authenticatedAccountId,
            authentication,
        },
        sourceSessionId: input.sourceSessionId,
        edge: { sourceSessionId: input.sourceSessionId, destinationSessionId: input.destinationSessionId },
    });
}

async function createAccount() {
    return await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
}

async function createSession(accountId: string) {
    return await db.session.create({ data: { accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
}

async function grant(session: { id: string; accountId: string }, accountId: string, accessLevel: "view" | "edit") {
    await db.sessionGrant.create({ data: { principalKind: 'account',
        sessionId: session.id,
        createdByAccountId: session.accountId,
        accountId: accountId,
        accessLevel,
    } });
}

describe("ordinary authenticated Follow context admission", () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-follow-context-admission-",
        });
    }, 180_000);
    afterEach(async () => {
        if (!harness) return;
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account' } });
        await db.ephemeralRunnerActivation.deleteMany();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.team.deleteMany();
        await db.artifact.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => harness?.close());

    it('rechecks the full executable destination audience at the final transcript read', async () => {
        const owner = await createAccount();
        const reader = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const message = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: [{ type: 'text', text: 'Private source answer' }] } } } });
        const runtimeAuthentication = { ...authentication, authority: 'account_automation' as const, contentDisclosureSessionId: destination.id };
        const read = () => readSessionMessagePage({ userId: owner.id, sessionId: source.id,
            authentication: runtimeAuthentication, query: { messageId: message.id } });
        expect(await read()).toMatchObject({ status: 200, body: { messages: [{ id: message.id }] } });
        // The configuring Account still owns both Sessions. Only the destination
        // audience changed after the Discussion's prior source admission.
        await grant(destination, reader.id, 'view');
        const refused = await read();
        expect(refused.status).toBe(404);
        expect(JSON.stringify(refused.body)).not.toContain('Private source answer');
        expect(await readSessionMessagePage({ userId: owner.id, sessionId: source.id, authentication,
            query: { messageId: message.id } })).toMatchObject({ status: 200 });
        await grant(source, reader.id, 'view');
        expect(await read()).toMatchObject({ status: 200 });
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: source.id, accountId: reader.id } });
        expect(await read()).toMatchObject({ status: 404 });
    });

    it('admits resource quotes only for the full current destination audience in both directions', async () => {
        const owner = await createAccount();
        const reader = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const resourceRow = await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        } });
        // Exercise the generic resource port with the real existing storage adapter.
        // Lane A binds Discussion tables to this same grant port; no policy is mocked.
        const resource = { kind: 'resource' as const, resourceId: resourceRow.id, adapter: {
            ...artifactGrantStorageAdapter,
            // Artifact's real grant policy, under this test's verified present-user authentication.
            resolveConfigurerAccessInTx: (tx: Tx, input: Readonly<{ resourceId: string; actorAccountId: string }>) =>
                resolveResourceGrantAccessInTx(tx, artifactGrantStorageAdapter, input),
        } };
        const quote = () => inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: owner.id, authentication,
            source: { kind: 'session', sessionId: source.id }, destination: resource,
        }));
        const invite = () => inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: owner.id, authentication,
            source: resource, destination: { kind: 'session', sessionId: destination.id },
        }));
        expect(await quote()).toEqual({ ok: true });
        expect(await invite()).toEqual({ ok: true });
        expect(await inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: reader.id, authentication,
            source: { kind: 'session', sessionId: source.id }, destination: resource,
        }))).toEqual({ ok: false, reason: 'configurer_not_allowed' });
        const publication = await db.publicSessionShare.create({ data: {
            sessionId: destination.id, tokenHash: randomBytes(32), createdByUserId: owner.id,
        } });
        expect(await invite()).toEqual({ ok: false, reason: 'destination_public' });
        await db.publicSessionShare.delete({ where: { id: publication.id } });
        const differentRuntime = await createSession(reader.id);
        await grant(differentRuntime, owner.id, 'edit');
        const inviteOtherRuntime = () => inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: owner.id, authentication,
            source: resource, destination: { kind: 'session', sessionId: differentRuntime.id },
        }));
        expect(await inviteOtherRuntime()).toEqual({ ok: false, reason: 'destination_runtime_not_allowed' });
        await db.artifactGrant.create({ data: { principalKind: 'account' as const,
            artifactId: resourceRow.id, accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id,
        } });
        expect(await inviteOtherRuntime()).toEqual({ ok: true });
        expect(await quote()).toEqual({ ok: false, reason: 'destination_audience_broader' });
        await grant(source, reader.id, 'view');
        expect(await quote()).toEqual({ ok: true });
        expect(await inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: reader.id, authentication,
            source: { kind: 'session', sessionId: source.id }, destination: resource,
        }))).toEqual({ ok: false, reason: 'configurer_not_allowed' });
        await grant(destination, reader.id, 'view');
        expect(await invite()).toEqual({ ok: true });
        await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: resourceRow.id, accountId: reader.id } });
        expect(await invite()).toEqual({ ok: false, reason: 'destination_audience_broader' });
        expect(await inviteOtherRuntime()).toEqual({ ok: false, reason: 'destination_runtime_not_allowed' });
        await db.artifact.delete({ where: { id: resourceRow.id } });
        expect(await quote()).toEqual({ ok: false, reason: 'unavailable' });
    });

    it("does not reauthorize a historical configuring actor, but rechecks the current audience on every admission", async () => {
        const runtime = await createAccount();
        const author = await createAccount();
        const reader = await createAccount();
        const source = await createSession(runtime.id);
        const destination = await createSession(runtime.id);
        await grant(source, author.id, "view");
        await grant(destination, author.id, "edit");

        expect(await inTx(tx => contextInjection.mayInjectSessionContextInTx(tx, {
            configuringAccountId: author.id, sourceSessionId: source.id, destinationSessionId: destination.id,
            authentication,
        }))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });

        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', accountId: author.id } });
        expect(await inTx(tx => contextInjection.mayInjectSessionContextInTx(tx, {
            configuringAccountId: author.id, sourceSessionId: source.id, destinationSessionId: destination.id,
            authentication,
        }))).toEqual({ ok: false, reason: "configurer_not_allowed" });

        const input = { authenticatedAccountId: runtime.id, sourceSessionId: source.id, destinationSessionId: destination.id };
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
        await grant(destination, reader.id, "view");
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_audience_broader" });
        await grant(source, reader.id, "view");
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
    });

    it("does not accept a readable collaborator as destination runtime custody and rechecks custody after transfer", async () => {
        const runtime = await createAccount();
        const collaborator = await createAccount();
        const source = await createSession(runtime.id);
        const destination = await createSession(runtime.id);
        await grant(source, collaborator.id, "view");
        await grant(destination, collaborator.id, "edit");

        expect(await inTx(tx => admitRuntime(tx, {
            authenticatedAccountId: collaborator.id, sourceSessionId: source.id, destinationSessionId: destination.id,
        }))).toEqual({ ok: false, reason: "destination_runtime_not_allowed" });

        await db.session.update({ where: { id: destination.id }, data: { accountId: collaborator.id } });
        expect(await inTx(tx => admitRuntime(tx, {
            authenticatedAccountId: runtime.id, sourceSessionId: source.id, destinationSessionId: destination.id,
        }))).toEqual({ ok: false, reason: "destination_runtime_not_allowed" });
        expect(await inTx(tx => admitRuntime(tx, {
            authenticatedAccountId: collaborator.id, sourceSessionId: source.id, destinationSessionId: destination.id,
        }))).toEqual({ ok: true, destinationRuntimeAccountId: collaborator.id });
    });

    it("rechecks the destination runtime's source entitlement after a previously allowed admission", async () => {
        const sourceOwner = await createAccount();
        const runtime = await createAccount();
        const source = await createSession(sourceOwner.id);
        const destination = await createSession(runtime.id);
        await grant(source, runtime.id, "view");
        const input = { authenticatedAccountId: runtime.id, sourceSessionId: source.id, destinationSessionId: destination.id };

        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: source.id, accountId: runtime.id } });
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_runtime_not_allowed" });
        await grant(source, runtime.id, "view");
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
    });

    it("blocks an active destination public link even with exhausted uses, and admits after expiry or removal", async () => {
        const runtime = await createAccount();
        const source = await createSession(runtime.id);
        const destination = await createSession(runtime.id);
        const input = { authenticatedAccountId: runtime.id, sourceSessionId: source.id, destinationSessionId: destination.id };
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
        const publication = await db.publicSessionShare.create({ data: {
            sessionId: destination.id, tokenHash: randomBytes(32), createdByUserId: runtime.id,
            maxUses: 1, useCount: 1,
        } });
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_public" });
        await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: new Date(0) } });
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
        await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: null } });
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_public" });
        await db.publicSessionShare.delete({ where: { id: publication.id } });
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
    });

    it.each(["team", "group"] as const)("rechecks %s audience broadening and source membership history", async (kind) => {
        const runtime = await createAccount();
        const reader = await createAccount();
        const source = await createSession(runtime.id);
        const destination = await createSession(runtime.id);
        const input = { authenticatedAccountId: runtime.id, sourceSessionId: source.id, destinationSessionId: destination.id };
        const team = await db.team.create({ data: { name: randomUUID() } });
        const cutoff = new Date("2026-09-01T00:00:00Z");
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: reader.id, role: kind === "group" ? "guest" : "member",
            sessionAccessStartsAt: cutoff,
        } });
        const group = kind === "group" ? await db.teamGroup.create({ data: {
            teamId: team.id, name: storedPlainPrivateLabel("Readers"),
        } }) : null;
        if (group) await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, sessionAccessStartsAt: cutoff,
        } });
        const grantAudience = async (sessionId: string, effectiveAt: Date) => {
            if (group) {
                await db.sessionGrant.create({ data: { principalKind: 'group', sessionId, teamGroupId: group.id, accessLevel: "view", effectiveAt } });
            } else {
                await db.sessionGrant.create({ data: { principalKind: 'team', sessionId, teamId: team.id, accessLevel: "view", effectiveAt } });
            }
        };
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
        await grantAudience(destination.id, new Date(cutoff.getTime() + 1));
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_audience_broader" });
        await grantAudience(source.id, cutoff);
        // Equal source cutoff remains denied even though both Sessions grant the same subject.
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: false, reason: "destination_audience_broader" });
        if (group) {
            await db.teamGroupMembership.update({ where: { teamGroupId_teamMembershipId: {
                teamGroupId: group.id, teamMembershipId: membership.id,
            } }, data: { sessionAccessStartsAt: null } });
        } else {
            await db.teamMembership.update({ where: { id: membership.id }, data: { sessionAccessStartsAt: null } });
        }
        expect(await inTx(tx => admitRuntime(tx, input))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
    });

    it('admits same-session content disclosure through current authority while Follow still refuses a self-link', async () => {
        const owner = await createAccount();
        const outsider = await createAccount();
        const session = await createSession(owner.id);
        const disclose = (accountId: string) => inTx(tx => contextInjection.mayInjectResourceContextInTx(tx, {
            configuringAccountId: accountId, authentication,
            source: { kind: 'session', sessionId: session.id }, destination: { kind: 'session', sessionId: session.id },
        }));
        expect(await disclose(owner.id)).toEqual({ ok: true });
        expect(await disclose(outsider.id)).toEqual({ ok: false, reason: 'configurer_not_allowed' });
        expect(await inTx(tx => contextInjection.mayInjectSessionContextInTx(tx, {
            configuringAccountId: owner.id, authentication, sourceSessionId: session.id, destinationSessionId: session.id,
        }))).toEqual({ ok: false, reason: 'same_session' });
        await db.publicSessionShare.create({ data: {
            sessionId: session.id, tokenHash: randomBytes(32), createdByUserId: owner.id,
        } });
        expect(await disclose(owner.id)).toEqual({ ok: false, reason: 'destination_public' });
    });

    it("denies same-session and missing-session pairs without manufacturing custody", async () => {
        const runtime = await createAccount();
        const session = await createSession(runtime.id);
        expect(await inTx(tx => admitRuntime(tx, {
            authenticatedAccountId: runtime.id, sourceSessionId: session.id, destinationSessionId: session.id,
        }))).toEqual({ ok: false, reason: "same_session" });
        for (const [sourceSessionId, destinationSessionId] of [[session.id, randomUUID()], [randomUUID(), session.id]]) {
            expect(await inTx(tx => admitRuntime(tx, {
                authenticatedAccountId: runtime.id, sourceSessionId, destinationSessionId,
            }))).toEqual({ ok: false, reason: "unavailable" });
        }
    });

    it("resolves a Runner's credential from its persisted activation instead of an evidence-free automation credential", async () => {
        const creator = await createAccount();
        const destination = await createSession(creator.id);
        const machineId = `runner-${randomUUID()}`;
        await db.machine.create({ data: {
            id: machineId,
            accountId: creator.id,
            metadata: "{}",
            kind: "ephemeral_session_runner",
            installationId: "runner-installation",
            installationPublicKey: randomBytes(32),
        } });
        const activationId = randomUUID();
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId,
            creatorAccountId: creator.id,
            creatorTokenEpoch: creator.tokenEpoch,
            draftId: `draft-${randomUUID()}`,
            sessionId: destination.id,
            machineId,
            state: "materialized",
            workspacePolicy: "choose_on_endpoint",
            homeServerIdentityId: "home",
            activationSigningPublicKey: "a".repeat(43),
            authoringCommitment: "b".repeat(43),
            artifact: {},
            endpointFactsRecipient: {},
            authenticationEvidence: { v: 1, evidence: [{ kind: "home_method", methodId: "email_password" }] },
        } });
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: creator.id,
            activationId,
            sessionId: destination.id,
            machineId,
            installationId: "runner-installation",
            installationPublicKey: "c".repeat(43),
            creatorTokenEpoch: creator.tokenEpoch,
        };

        // The Runner holds no request credential of its own; the activation the
        // creator authorized is its only honest evidence.
        expect(await inTx(tx => contextInjection.resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, principal)))
            .toMatchObject({
                authority: "account_automation",
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
            });

        // An activation that persisted no evidence stays an unqualified
        // automation credential rather than inheriting the observer's.
        const bareActivationId = randomUUID();
        const bareDestination = await createSession(creator.id);
        const bareMachineId = `runner-${randomUUID()}`;
        await db.machine.create({ data: {
            id: bareMachineId,
            accountId: creator.id,
            metadata: "{}",
            kind: "ephemeral_session_runner",
            installationId: "runner-installation-bare",
            installationPublicKey: randomBytes(32),
        } });
        await db.ephemeralRunnerActivation.create({ data: {
            id: bareActivationId,
            creatorAccountId: creator.id,
            creatorTokenEpoch: creator.tokenEpoch,
            draftId: `draft-${randomUUID()}`,
            sessionId: bareDestination.id,
            machineId: bareMachineId,
            state: "materialized",
            workspacePolicy: "choose_on_endpoint",
            homeServerIdentityId: "home",
            activationSigningPublicKey: "a".repeat(43),
            authoringCommitment: "b".repeat(43),
            artifact: {},
            endpointFactsRecipient: {},
        } });
        expect(await inTx(tx => contextInjection.resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, {
            ...principal, activationId: bareActivationId, sessionId: bareDestination.id, machineId: bareMachineId,
        }))).toMatchObject({ authority: "account_automation", authenticationEvidence: undefined });

        // A destination runtime keeps the credential its own request was admitted with.
        expect(await inTx(tx => contextInjection.resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, {
            kind: "destination_runtime",
            destinationRuntimeAccountId: creator.id,
            authentication,
        }))).toEqual(authentication);
    });

    it("admits only the current edge's own source, never a sibling Session the runtime can read", async () => {
        const runtime = await createAccount();
        const source = await createSession(runtime.id);
        const destination = await createSession(runtime.id);
        const sibling = await createSession(runtime.id);
        const edge = { sourceSessionId: source.id, destinationSessionId: destination.id };

        expect(await inTx(tx => contextInjection.assertSessionFollowSourceReadInTx(tx, {
            principal: { kind: "destination_runtime", destinationRuntimeAccountId: runtime.id, authentication },
            sourceSessionId: sibling.id,
            edge,
        }))).toEqual({ ok: false, reason: "unavailable" });
        expect(await inTx(tx => contextInjection.assertSessionFollowSourceReadInTx(tx, {
            principal: { kind: "destination_runtime", destinationRuntimeAccountId: runtime.id, authentication },
            sourceSessionId: source.id,
            edge,
        }))).toEqual({ ok: true, destinationRuntimeAccountId: runtime.id });
    });
});
