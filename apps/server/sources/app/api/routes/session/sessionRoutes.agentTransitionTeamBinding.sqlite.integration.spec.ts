import { randomUUID } from "node:crypto";

import {
    buildSessionAgentTransitionDividerLocalId,
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
} from "@happier-dev/protocol";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitTeamCredentialOperationBindingInTx, listSessionTeamCredentialBindingConsequencesInTx, writeSessionTeamCredentialBindingsInTx } from "@/app/teams/credentials/sessionBinding";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerSessionAgentTransitionRoute } from "./registerSessionAgentTransitionRoute";
import { mutateQualifiedConnectedServiceCredentialInTx, readQualifiedConnectedAccountSourceIdentityInTx } from "../connect/qualifiedConnectedAccounts/credentialRepository";

/**
 * An Agent transition to a target whose Team default resolves must leave the
 * Session with the Team binding its first credential use needs.
 *
 * The Home admits a Team resource for a Session only through the Session's own
 * accepted-selection witness, which the canonical Session create/switch
 * mutation writes in the same transaction as the selection intent (lane 10
 * child 01 principle 3). The cutover IS the transition's one Session switch
 * mutation, so it carries the slot binding. The route, the cutover owner, the
 * binding owner and the database are real; only the authenticated principal is
 * supplied by the test app.
 */

const PRESENT_USER_AUTHENTICATION = {
    env: process.env,
    authority: "present_user",
    authenticationEvidence: [],
} as const;

const CODEX_PURPOSE = {
    consumer: { pluginId: "happier.agent.codex", localId: "codex" },
    purpose: "primary",
} as const;

const OWNER_METADATA = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
const SHARED_METADATA = JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} }));
const TARGET_SHARED_METADATA = JSON.stringify(projectSessionSharedMetadataV1({ metadata: { flavor: "codex" } }));

function dividerContent() {
    return {
        t: "plain" as const,
        v: {
            role: "agent",
            content: {
                type: "event",
                id: "agent-transition-divider",
                data: {
                    type: "message",
                    message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
                    sessionAgentTransitionV1: {
                        v: 1,
                        fromAgentId: "claude",
                        toAgentId: "codex",
                        sourceCutoffSeqInclusive: 0,
                    },
                },
            },
        },
    };
}

describe("Agent transition cutover — Team binding (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-agent-transition-team-binding-",
            initAuth: false,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            },
        });
    }, 180_000);

    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Transition ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: "member" },
        });
        const broker = await db.machine.create({ data: {
            id: randomUUID(),
            accountId: custodian.id,
            active: true,
            kind: "persistent",
            metadata: "{}",
            metadataVersion: 1,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const createResource = async (service: Readonly<{ pluginId: string; localId: string }>) => {
            const ref = { service, accountId: randomUUID() };
            await expect(inTx(tx => mutateQualifiedConnectedServiceCredentialInTx(tx, {
                accountId: custodian.id, ref, authenticationModeId: "oauth", expectedCredentialRevision: null,
                content: { t: "plain", v: { accessToken: "test-only-token" } }, metadata: { displayName: "Fixture account", scopes: [] },
            }))).resolves.toMatchObject({ status: "written" });
            const identity = await inTx(tx => readQualifiedConnectedAccountSourceIdentityInTx(tx, { accountId: custodian.id, ref }));
            if (!identity) throw new Error("Connected Account source fixture is unavailable");
            return await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: `Shared ${service.localId} account`,
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            brokerMachineId: broker.id,
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "connected_account", target: { kind: "account", account: ref },
                credentialIncarnation: identity.incarnation,
            }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
            } });
        };
        const resource = await createResource({ pluginId: "happier.agent.codex", localId: "openai-codex" });
        // The source Session: stopped (the coordinator confirmed the stop) and
        // on the canonical layout-one tuple, as every 0.3 Session is created.
        const session = await db.session.create({ data: {
            accountId: member.id,
            tag: `transition-team-${randomUUID()}`,
            encryptionMode: "plain",
            currentStorageState: "hosted",
            metadataLayoutVersion: 1,
            metadata: SHARED_METADATA,
            ownerMetadata: JSON.stringify(OWNER_METADATA),
            agentState: null,
            active: false,
        } });
        const binding = {
            v: 1 as const,
            slot: { kind: "connected_service_purpose" as const, purpose: CODEX_PURPOSE },
            resourceId: resource.id,
            expectedResourceRevision: resource.revision,
            deliveryMode: "brokered" as const,
            teamId: team.id,
        };
        const cutoverBody = (bindings: readonly unknown[]) => ({
            v: 1,
            currentView: {
                kind: "envelope_tuple_v1",
                ownerPatch: {
                    mode: "owner_inactive_model_intent",
                    metadataLayoutVersion: 1,
                    expectedOwnerMetadata: OWNER_METADATA,
                    ownerMetadata: OWNER_METADATA,
                    sharedMetadata: { ciphertext: TARGET_SHARED_METADATA, expectedVersion: session.metadataVersion },
                    agentState: { ciphertext: null, expectedVersion: session.agentStateVersion },
                    sessionExpectation: { kind: "inactive_model_intent" },
                },
            },
            divider: {
                localId: buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`),
                content: dividerContent(),
            },
            teamCredentialBindings: bindings,
        });
        const admitFirstUse = () => inTx((tx) => admitTeamCredentialOperationBindingInTx(tx, {
            consumer: { kind: "session", sessionId: session.id },
            accountId: member.id,
            slot: binding.slot,
            deliveryMode: "brokered",
            authentication: PRESENT_USER_AUTHENTICATION,
        }));
        return { member, resource, session, binding, cutoverBody, admitFirstUse, createResource };
    }

    function postCutover(app: FastifyInstance, sessionId: string, accountId: string, payload: object) {
        return app.inject({
            method: "POST",
            url: `/v2/sessions/${sessionId}/agent-transition/cutover`,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                "x-happier-account-stored-content-protocol": "2",
            },
            payload,
        });
    }

    it("writes the target's Team binding with the cutover, so the first credential use is admitted", async () => {
        const current = await fixture();
        await expect(current.admitFirstUse()).resolves.toEqual({ ok: false, reason: "binding_missing" });

        await withAuthenticatedTestApp(
            (app) => registerSessionAgentTransitionRoute(app),
            async (app: FastifyInstance) => {
                const response = await postCutover(
                    app,
                    current.session.id,
                    current.member.id,
                    current.cutoverBody([current.binding]),
                );
                expect(response.statusCode, response.body).toBe(200);
            },
        );

        await expect(current.admitFirstUse()).resolves.toMatchObject({
            ok: true,
            binding: { resourceId: current.resource.id },
        });
    });

    it("commits neither the target view nor the binding when the Home refuses the binding", async () => {
        const current = await fixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: current.session.id, accountId: current.member.id,
            intents: [{ ...current.binding, slot: { kind: "provider_model" } }],
            authentication: PRESENT_USER_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        // The resource changed after the daemon resolved the target default.
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { revision: { increment: 1 } },
        });

        await withAuthenticatedTestApp(
            (app) => registerSessionAgentTransitionRoute(app),
            async (app: FastifyInstance) => {
                const response = await postCutover(
                    app,
                    current.session.id,
                    current.member.id,
                    current.cutoverBody([current.binding]),
                );
                expect(response.statusCode, response.body).toBe(400);
            },
        );

        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: current.session.id } }))
            .resolves.toBe(1);
        await expect(db.sessionTeamCredentialBinding.findFirst({ where: { sessionId: current.session.id } }))
            .resolves.toMatchObject({ slotKind: "provider_model:brokered", resourceRevision: current.resource.revision });
        await expect(db.session.findUniqueOrThrow({
            where: { id: current.session.id },
            select: { metadata: true, metadataVersion: true },
        })).resolves.toEqual({ metadata: SHARED_METADATA, metadataVersion: current.session.metadataVersion });
        await expect(db.sessionMessage.count({ where: { sessionId: current.session.id } })).resolves.toBe(0);
    });

    it.each([false, true])("contracts the departed Agent's qualified witness (target Team default: %s)", async (targetHasTeamDefault) => {
        const current = await fixture();
        const source = await current.createResource({ pluginId: "happier.agent.claude", localId: "claude-subscription" });
        await db.teamCredentialResource.update({ where: { id: source.id }, data: { sessionUsePolicy: "team_context_required" } });
        await db.session.update({ where: { id: current.session.id }, data: { primaryTeamId: current.binding.teamId } });
        const sourceSlot = { kind: "connected_service_purpose", purpose: {
            consumer: { pluginId: "happier.agent.claude", localId: "claude" }, purpose: "model_upstream",
        } } as const;
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: current.session.id, accountId: current.member.id,
            intents: [{ ...current.binding, slot: sourceSlot, resourceId: source.id, expectedResourceRevision: source.revision }], authentication: PRESENT_USER_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        const preview = () => inTx(tx => listSessionTeamCredentialBindingConsequencesInTx(tx, {
            sessionId: current.session.id, teamIds: [current.binding.teamId],
        }));
        await expect(preview()).resolves.toMatchObject([{ resourceId: source.id }]);

        const body = current.cutoverBody(targetHasTeamDefault ? [current.binding] : []);
        const { teamCredentialBindings: _, ...withoutBindings } = body;
        await withAuthenticatedTestApp(app => registerSessionAgentTransitionRoute(app), async app => {
            const response = await postCutover(app, current.session.id, current.member.id,
                targetHasTeamDefault ? body : withoutBindings);
            expect(response.statusCode, response.body).toBe(200);
        });
        await expect(inTx(tx => admitTeamCredentialOperationBindingInTx(tx, {
            consumer: { kind: "session", sessionId: current.session.id }, accountId: current.member.id,
            slot: sourceSlot, deliveryMode: "brokered", authentication: PRESENT_USER_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "binding_missing" });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: current.session.id } }))
            .resolves.toBe(targetHasTeamDefault ? 1 : 0);
        await expect(preview()).resolves.toHaveLength(0);
    });
});
