import type { UsageEventIngestRequest } from "@happier-dev/protocol";
import { EphemeralUpdateSchema } from "@happier-dev/protocol/updates";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recordTeamCredentialExternalProviderTerminalUsageInTx } from "@/app/teams/credentials/externalProviderBrokerAdmission";
import {
    recordTeamCredentialAdmissionUsageEventInTx,
    recordTeamCredentialExternalTerminalUsageEventInTx,
    recordUsageEvent,
    type TeamCredentialUsageWriteAuthority,
} from "./usageWriteService";


describe("usageWriteService Team credential attribution", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-usage-write-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.session.deleteMany(),
            () => db.team.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createTeamFixture() {
        const storageAccount = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const actorA = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const actorB = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const team = await db.team.create({ data: { name: `Usage team ${crypto.randomUUID()}` } });
        const membershipA = await db.teamMembership.create({
            data: { teamId: team.id, accountId: actorA.id, role: "member" },
        });
        const membershipB = await db.teamMembership.create({
            data: { teamId: team.id, accountId: actorB.id, role: "member" },
        });
        const createResource = (displayName: string) => db.teamCredentialResource.create({
            data: {
                teamId: team.id,
                custodianAccountId: storageAccount.id,
                displayName,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: crypto.randomUUID(),
                    connectionSecurityFingerprint: `connection-security:v1:${crypto.randomUUID()}`,
                    credentialSlotId: "apiKey",
                }),
            },
        });
        const resourceA = await createResource("Resource A");
        const resourceB = await createResource("Resource B");
        return {
            storageAccount,
            actorA,
            actorB,
            team,
            membershipA,
            membershipB,
            resourceA,
            resourceB,
        };
    }

    function admissionAuthority(params: Readonly<{
        actorAccountId: string;
        resourceId: string;
        externalApiKeyId?: string | null;
        workerMachineId?: string | null;
        brokerMachineId?: string | null;
        sourceCredentialId?: string | null;
        executionRunId?: string | null;
        groupIds?: readonly string[];
    }>): Extract<TeamCredentialUsageWriteAuthority, { kind: "teamCredentialAdmission" }> {
        return {
            kind: "teamCredentialAdmission",
            requestingAccountId: params.actorAccountId,
            resourceId: params.resourceId,
            externalApiKeyId: params.externalApiKeyId ?? null,
            sourceCredentialId: params.sourceCredentialId ?? null,
            workerMachineId: params.workerMachineId ?? null,
            brokerMachineId: params.brokerMachineId ?? "broker-machine-1",
            deliveryMode: params.externalApiKeyId ? "external_api" : "brokered",
            executionRunId: params.executionRunId ?? null,
            groupIds: params.groupIds ?? [],
        };
    }

    it("scopes admission idempotency to storage Account, resource, actor Account, API key, request identity, and source", async () => {
        const fixture = await createTeamFixture();
        expect(fixture.membershipA.id).not.toBe(fixture.actorA.id);
        expect(fixture.membershipB.id).not.toBe(fixture.actorB.id);

        const keyA = await db.teamCredentialExternalApiKey.create({
            data: {
                resourceId: fixture.resourceA.id,
                teamMembershipId: fixture.membershipA.id,
                label: "Actor A key",
                displayPrefix: "hapek_v1_actor_a",
                secretDigest: crypto.randomUUID(),
            },
        });
        const keyB = await db.teamCredentialExternalApiKey.create({
            data: {
                resourceId: fixture.resourceA.id,
                teamMembershipId: fixture.membershipA.id,
                label: "Actor A second key",
                displayPrefix: "hapek_v1_actor_a_2",
                secretDigest: crypto.randomUUID(),
            },
        });
        const firstObservedAt = new Date("2026-09-08T08:00:00.000Z");
        const retryObservedAt = new Date("2026-09-08T09:00:00.000Z");
        const write = (authority: Extract<TeamCredentialUsageWriteAuthority, { kind: "teamCredentialAdmission" }>, observedAt = firstObservedAt) =>
            inTx((tx) => recordTeamCredentialAdmissionUsageEventInTx(tx, {
                accountId: fixture.storageAccount.id,
                sessionId: null,
                turnId: null,
                observedAt,
                externalKey: "provider-request-1",
                authority,
            }));

        const first = await write(admissionAuthority({
            actorAccountId: fixture.actorA.id,
            resourceId: fixture.resourceA.id,
            externalApiKeyId: keyA.id,
        }));
        const retry = await write(admissionAuthority({
            actorAccountId: fixture.actorA.id,
            resourceId: fixture.resourceA.id,
            externalApiKeyId: keyA.id,
        }), retryObservedAt);
        const otherApiKey = await write(admissionAuthority({
            actorAccountId: fixture.actorA.id,
            resourceId: fixture.resourceA.id,
            externalApiKeyId: keyB.id,
        }));
        const otherResource = await write(admissionAuthority({
            actorAccountId: fixture.actorA.id,
            resourceId: fixture.resourceB.id,
        }));
        const otherActor = await write(admissionAuthority({
            actorAccountId: fixture.actorB.id,
            resourceId: fixture.resourceA.id,
        }));

        expect(first.created).toBe(true);
        expect(retry).toEqual({ id: first.id, created: false });
        expect(new Set([first.id, otherApiKey.id, otherResource.id, otherActor.id]).size).toBe(4);
        expect(await db.usageEvent.count({ where: { source: "team_credential_admission" } })).toBe(4);
        expect(await db.usageEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
            requestCount: 1, inputTokens: null, outputTokens: null, reasoningTokens: null,
            cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
            reportedCostUsd: null, estimatedCostUsd: null, invoiceCostUsd: null,
        });
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: keyA.id } })).lastUsedAt)
            .toEqual(firstObservedAt);
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: keyB.id } })).lastUsedAt)
            .toEqual(firstObservedAt);

        const terminalAuthority = {
            kind: "teamCredentialExternalTerminal" as const,
            admissionUsageEventId: first.id,
            requestingAccountId: fixture.actorA.id,
            resourceId: fixture.resourceA.id,
            brokerMachineId: "broker-machine-1",
        };
        const terminalInput = {
            accountId: fixture.storageAccount.id,
            requestId: "provider-request-1",
            completedAt: new Date("2026-09-08T08:01:00.000Z"),
            outcome: "succeeded" as const,
            measurement: "reported" as const,
            modelId: "provider-model-1",
            tokens: { input: 5, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 9 },
            cost: { reportedUsd: 0.12, estimatedUsd: null, currency: "USD", costSource: "provider_reported" as const, billingContext: "api_usage" as const },
            authority: terminalAuthority,
        };
        await db.machine.create({ data: { id: "broker-machine-1", accountId: fixture.storageAccount.id,
            metadata: "{}" } });
        // The CLI's real plugin/response observer test produces this strict DTO;
        // keep this suite at the server admission and database boundary.
        const request = { v: 1, admissionUsageEventId: first.id, requestId: terminalInput.requestId,
            brokerMachineId: "broker-machine-1", completedAtMs: terminalInput.completedAt.getTime(),
            measurement: "reported", outcome: terminalInput.outcome, actualModelId: terminalInput.modelId,
            tokens: terminalInput.tokens, reportedCostUsd: 0.12 };
        const terminal = await inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
            authenticatedBrokerAccountId: fixture.storageAccount.id, request,
        }));
        if (!terminal.ok) throw new Error(`Terminal charge rejected: ${terminal.reasonCode}`);
        await expect(inTx((tx) => recordTeamCredentialExternalTerminalUsageEventInTx(tx, terminalInput)))
            .resolves.toEqual({ id: terminal.usageEventId, created: false });
        await expect(inTx((tx) => recordTeamCredentialExternalTerminalUsageEventInTx(tx, {
            ...terminalInput,
            outcome: "failed",
        }))).rejects.toThrow("conflicting team credential terminal usage fact");
        expect(await db.usageEvent.count({ where: { source: "team_credential_external_terminal" } })).toBe(1);
        expect(await db.usageEvent.findUniqueOrThrow({ where: { id: terminal.usageEventId } })).toMatchObject({
            requestCount: 0,
            totalTokens: 9,
            modelId: "provider-model-1",
            reportedCostUsd: 0.12,
            estimatedCostUsd: null,
            invoiceCostUsd: null,
            costSource: "provider_reported",
            teamCredentialActorAccountId: fixture.actorA.id,
            teamCredentialExternalApiKeyId: keyA.id,
        });
        const unavailable = await inTx(tx => recordTeamCredentialExternalTerminalUsageEventInTx(tx, {
            ...terminalInput, measurement: 'unavailable', tokens: null, cost: null,
            authority: { ...terminalAuthority, admissionUsageEventId: otherApiKey.id },
        }));
        expect(await db.usageEvent.findUniqueOrThrow({ where: { id: unavailable.id } })).toMatchObject({
            requestCount: 0, totalTokens: null, inputTokens: null, reportedCostUsd: null,
            estimatedCostUsd: null, invoiceCostUsd: null,
        });
    });

    it("derives ordinary Agent attribution from the immutable turn witness and copies only admitted budget Groups", async () => {
        const fixture = await createTeamFixture();
        const session = await db.session.create({
            data: {
                accountId: fixture.storageAccount.id,
                tag: crypto.randomUUID(),
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                active: true,
            },
        });
        const admittedGroupA = await db.teamGroup.create({
            data: { teamId: fixture.team.id, name: "Admitted A", nameKey: "admitted-a" },
        });
        const admittedGroupB = await db.teamGroup.create({
            data: { teamId: fixture.team.id, name: "Admitted B", nameKey: "admitted-b" },
        });
        const currentOnlyGroup = await db.teamGroup.create({
            data: { teamId: fixture.team.id, name: "Current only", nameKey: "current-only" },
        });
        await db.teamGroupMembership.createMany({
            data: [admittedGroupA, admittedGroupB, currentOnlyGroup].map((group) => ({
                teamId: fixture.team.id,
                teamGroupId: group.id,
                teamMembershipId: fixture.membershipA.id,
            })),
        });
        const turnId = "turn-team-usage";
        await db.sessionTurn.create({
            data: {
                sessionId: session.id,
                turnId,
                status: "active",
                startedAt: 1n,
                updatedAt: 1n,
                usageActorAccountId: fixture.actorA.id,
                teamCredentialResourceId: fixture.resourceA.id,
                credentialDeliveryMode: "brokered",
            },
        });
        const admit = (requestIdentity: string, groupIds: readonly string[]) => inTx((tx) =>
            recordTeamCredentialAdmissionUsageEventInTx(tx, {
                accountId: fixture.storageAccount.id,
                sessionId: session.id,
                turnId,
                observedAt: new Date("2026-09-08T10:00:00.000Z"),
                externalKey: requestIdentity,
                authority: admissionAuthority({
                    actorAccountId: fixture.actorA.id,
                    resourceId: fixture.resourceA.id,
                workerMachineId: "worker-machine-1",
                    sourceCredentialId: "source-member-1",
                    groupIds,
                }),
            }));
        await admit("provider-request-a", [admittedGroupA.id]);
        await admit("provider-request-b", [admittedGroupB.id]);

        const request = {
            sessionId: session.id,
            observedAt: Date.parse("2026-09-08T10:01:00.000Z"),
            agentId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: "worker-machine-1",
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey: "agent-observation-1",
            turnId,
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: {
                reportedUsd: 0.11,
                estimatedUsd: 0,
                invoiceUsd: 0,
                costSource: "provider_reported",
                currency: "USD",
            },
            context: { usedTokens: 12, windowTokens: 200_000 },
        } satisfies UsageEventIngestRequest;

        // New writes reject caller-supplied attribution rather than stripping it.
        // The admitted ordinary request still derives only the immutable turn witness.
        const forgedRequest = {
            ...request,
            teamCredentialResourceId: fixture.resourceB.id,
            teamCredentialActorAccountId: fixture.actorB.id,
            teamCredentialGroups: [currentOnlyGroup.id],
        };
        await expect(recordUsageEvent(fixture.storageAccount.id, forgedRequest)).resolves.toMatchObject({ ok: false, error: "invalid-params" });
        expect(await db.usageEvent.count({ where: { source: "claude_sdk", externalKey: request.externalKey } })).toBe(0);

        await expect(recordUsageEvent(fixture.storageAccount.id, request)).resolves.toMatchObject({ ok: true });

        const rows = await db.usageEvent.findMany({
            where: { accountId: fixture.storageAccount.id },
            orderBy: { observedAt: "asc" },
            select: {
                source: true,
                requestCount: true,
                totalTokens: true,
                reportedCostUsd: true,
                costSource: true,
                machineId: true,
                brokerMachineId: true,
                teamCredentialSourceCredentialId: true,
                teamCredentialResourceId: true,
                teamCredentialActorAccountId: true,
                credentialDeliveryMode: true,
                teamCredentialGroupAttributions: {
                    orderBy: { teamGroupId: "asc" },
                    select: { teamGroupId: true },
                },
            },
        });
        const agentRow = rows.find((row) => row.source === "claude_sdk");
        expect(rows.filter((row) => row.requestCount > 0)).toHaveLength(2);
        expect(rows.filter((row) => row.totalTokens !== null && row.totalTokens > 0)).toHaveLength(1);
        expect(agentRow).toEqual({
            source: "claude_sdk",
            requestCount: 0,
            totalTokens: 12,
            reportedCostUsd: 0.11,
            costSource: "provider_reported",
            machineId: "worker-machine-1",
            brokerMachineId: "broker-machine-1",
            teamCredentialSourceCredentialId: "source-member-1",
            teamCredentialResourceId: fixture.resourceA.id,
            teamCredentialActorAccountId: fixture.actorA.id,
            credentialDeliveryMode: "brokered",
            teamCredentialGroupAttributions: [admittedGroupA.id, admittedGroupB.id]
                .sort()
                .map((teamGroupId) => ({ teamGroupId })),
        });
        expect(agentRow?.teamCredentialGroupAttributions).not.toContainEqual({ teamGroupId: currentOnlyGroup.id });
    });

    it("derives attached Execution Run terminal attribution from its admitted Run-local turn witness", async () => {
        const fixture = await createTeamFixture();
        const session = await db.session.create({
            data: {
                accountId: fixture.storageAccount.id,
                tag: crypto.randomUUID(),
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                active: true,
            },
        });
        const admittedGroup = await db.teamGroup.create({
            data: { teamId: fixture.team.id, name: "Run group", nameKey: "run-group" },
        });
        const turnId = "run-local-turn-1";
        await inTx((tx) => recordTeamCredentialAdmissionUsageEventInTx(tx, {
            accountId: fixture.storageAccount.id,
            sessionId: session.id,
            turnId,
            observedAt: new Date("2026-09-08T12:00:00.000Z"),
            externalKey: "run-provider-request-1",
            authority: admissionAuthority({
                actorAccountId: fixture.actorA.id,
                resourceId: fixture.resourceA.id,
                workerMachineId: "worker-machine-run",
                brokerMachineId: "broker-machine-run",
                sourceCredentialId: "source-member-run",
                executionRunId: "attached-execution-run-1",
                groupIds: [admittedGroup.id],
            }),
        }));

        const terminalRequest = {
            sessionId: session.id,
            observedAt: Date.parse("2026-09-08T12:01:00.000Z"),
            agentId: "codex",
            backendMode: "remote",
            modelId: "gpt-5",
            projectKey: null,
            workspaceId: null,
            machineId: "worker-machine-run",
            source: "codex_sdk",
            scope: "turn_delta",
            externalKey: "run-agent-observation-1",
            turnId,
            isCumulative: false,
            tokens: { input: 9, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 13 },
            cost: { reportedUsd: 0.2, estimatedUsd: 0, invoiceUsd: 0, costSource: "provider_reported", currency: "USD" },
        } satisfies UsageEventIngestRequest;
        const firstTerminalWrite = await recordUsageEvent(fixture.storageAccount.id, terminalRequest);
        expect(firstTerminalWrite).toMatchObject({ ok: true });
        await expect(recordUsageEvent(fixture.storageAccount.id, terminalRequest)).resolves.toEqual(firstTerminalWrite);

        const terminal = await db.usageEvent.findFirstOrThrow({
            where: { source: "codex_sdk", externalKey: "run-agent-observation-1" },
            include: { teamCredentialGroupAttributions: true },
        });
        expect(terminal).toMatchObject({
            sessionId: session.id,
            turnId,
            teamCredentialResourceId: fixture.resourceA.id,
            teamCredentialActorAccountId: fixture.actorA.id,
            credentialDeliveryMode: "brokered",
            machineId: "worker-machine-run",
            brokerMachineId: "broker-machine-run",
            teamCredentialSourceCredentialId: "source-member-run",
            totalTokens: 13,
            reportedCostUsd: 0.2,
        });
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId FROM UsageEvent WHERE id = ${terminal.id}
        `).toEqual([{ executionRunId: "attached-execution-run-1" }]);
        expect(terminal.teamCredentialGroupAttributions).toEqual([
            expect.objectContaining({ teamGroupId: admittedGroup.id }),
        ]);
    });

    it("resolves one Execution Run attribution across several admissions and none for a personal turn", async () => {
        const fixture = await createTeamFixture();
        const session = await db.session.create({
            data: {
                accountId: fixture.storageAccount.id,
                tag: crypto.randomUUID(),
                encryptionMode: "plain",
                metadata: "{}",
                active: true,
            },
        });
        const turnId = "multi-admission-turn";
        for (const requestIndex of [1, 2, 3]) {
            await inTx((tx) => recordTeamCredentialAdmissionUsageEventInTx(tx, {
                accountId: fixture.storageAccount.id,
                sessionId: session.id,
                turnId,
                observedAt: new Date("2026-09-08T12:00:00.000Z"),
                externalKey: `multi-request-${requestIndex}`,
                authority: admissionAuthority({
                    actorAccountId: fixture.actorA.id,
                    resourceId: fixture.resourceA.id,
                    workerMachineId: "worker-multi",
                    brokerMachineId: "broker-multi",
                    sourceCredentialId: "source-multi",
                    executionRunId: "attached-run-multi",
                }),
            }));
        }
        const terminal = (externalKey: string, requestTurnId: string) => ({
            sessionId: session.id,
            observedAt: Date.parse("2026-09-08T12:01:00.000Z"),
            agentId: "codex",
            backendMode: "remote",
            modelId: "gpt-5",
            projectKey: null,
            workspaceId: null,
            machineId: "worker-multi",
            source: "codex_sdk",
            scope: "turn_delta",
            externalKey,
            turnId: requestTurnId,
            isCumulative: false,
            tokens: { input: 4, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 6 },
            cost: {
                reportedUsd: 0.1, estimatedUsd: 0, invoiceUsd: 0,
                costSource: "provider_reported", currency: "USD",
            },
        } satisfies UsageEventIngestRequest);

        expect(await recordUsageEvent(fixture.storageAccount.id, terminal("multi-observation", turnId)))
            .toMatchObject({ ok: true });
        const attributed = await db.usageEvent.findFirstOrThrow({
            where: { source: "codex_sdk", externalKey: "multi-observation" },
        });
        expect(attributed).toMatchObject({
            teamCredentialResourceId: fixture.resourceA.id,
            teamCredentialActorAccountId: fixture.actorA.id,
            brokerMachineId: "broker-multi",
            teamCredentialSourceCredentialId: "source-multi",
        });
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId FROM UsageEvent WHERE id = ${attributed.id}
        `).toEqual([{ executionRunId: "attached-run-multi" }]);

        // A personal turn carries no Team attribution, and the admissions of a
        // different turn never leak into it.
        expect(await recordUsageEvent(fixture.storageAccount.id, terminal("personal-observation", "personal-turn")))
            .toMatchObject({ ok: true });
        const personal = await db.usageEvent.findFirstOrThrow({
            where: { source: "codex_sdk", externalKey: "personal-observation" },
        });
        expect(personal).toMatchObject({
            teamCredentialResourceId: null,
            teamCredentialActorAccountId: null,
            brokerMachineId: null,
            teamCredentialSourceCredentialId: null,
        });
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId FROM UsageEvent WHERE id = ${personal.id}
        `).toEqual([{ executionRunId: null }]);
    });

    it("attributes two broker Machines independently and refuses to move a recorded request between them", async () => {
        const fixture = await createTeamFixture();
        const write = (requestIdentity: string, brokerMachineId: string, executionRunId: string | null = null) => inTx((tx) =>
            recordTeamCredentialAdmissionUsageEventInTx(tx, {
                accountId: fixture.storageAccount.id,
                sessionId: null,
                turnId: null,
                observedAt: new Date("2026-09-08T11:00:00.000Z"),
                externalKey: requestIdentity,
                authority: admissionAuthority({
                    actorAccountId: fixture.actorA.id,
                    resourceId: fixture.resourceA.id,
                    brokerMachineId,
                    executionRunId,
                }),
            }));

        const first = await write("brokered-request-1", "broker-machine-1", "detached-execution-run-1");
        const second = await write("brokered-request-2", "broker-machine-2");
        expect(first.created).toBe(true);
        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
        await expect(write("brokered-request-1", "broker-machine-1", "detached-execution-run-1"))
            .resolves.toEqual({ id: first.id, created: false });

        const rows = await db.usageEvent.findMany({
            where: { source: "team_credential_admission" },
            orderBy: { id: "asc" as const },
            select: { id: true, brokerMachineId: true, externalKey: true },
        });
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: first.id, brokerMachineId: "broker-machine-1", externalKey: "brokered-request-1" }),
            expect.objectContaining({ id: second.id, brokerMachineId: "broker-machine-2", externalKey: "brokered-request-2" }),
        ]));
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId FROM UsageEvent WHERE id = ${first.id}
        `).toEqual([{ executionRunId: "detached-execution-run-1" }]);

        // The same request identity replayed against a different broker
        // Machine is a conflicting fact, never a silent dedupe or a new row.
        await expect(write("brokered-request-1", "broker-machine-2")).rejects.toThrow(
            "conflicting team credential usage admission fact",
        );
        await expect(write("brokered-request-1", "broker-machine-1", "forged-run-id")).rejects.toThrow(
            "conflicting team credential usage admission fact",
        );
        expect(await db.usageEvent.count({ where: { source: "team_credential_admission" } })).toBe(2);
    });

    it("wakes resource, Team and Home usage readers' app connections after each new immutable usage write", async () => {
        const fixture = await createTeamFixture();
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const suspendedManager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const homeAdmin = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", homeRole: "admin" } });
        const homeOwner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", homeRole: "owner" } });
        const suspendedHomeAdmin = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", homeRole: "admin", status: "suspended" },
        });
        const outsider = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        // Overlapping Home and Team audiences still receive one wake per fact.
        await db.account.update({ where: { id: manager.id }, data: { homeRole: "admin" } });
        await db.teamMembership.create({ data: { teamId: fixture.team.id, accountId: manager.id, role: "admin" } });
        await db.teamMembership.create({
            data: { teamId: fixture.team.id, accountId: suspendedManager.id, role: "owner", status: "suspended" },
        });
        const connections: Array<Readonly<{ accountId: string; connection: ClientConnection }>> = [];
        const listen = (accountId: string, connectionType: "user-scoped" | "machine-scoped") => {
            const received: Array<Record<string, unknown>> = [];
            // The socket is the transport boundary; routing, filters and audience stay real.
            const socket = {
                emit: (eventName: string, payload: Record<string, unknown>) => {
                    if (eventName === "ephemeral" && payload.type === "team-credential-usage-changed") received.push(payload);
                },
            } as unknown as ClientConnection["socket"];
            const connection: ClientConnection = connectionType === "user-scoped"
                ? { connectionType, socket, userId: accountId }
                : { connectionType, socket, userId: accountId, machineId: `machine-${accountId}` };
            eventRouter.addConnection(accountId, connection);
            connections.push({ accountId, connection });
            return received;
        };
        try {
            const custodianApp = listen(fixture.storageAccount.id, "user-scoped");
            const managerApp = listen(manager.id, "user-scoped");
            const managerDaemon = listen(manager.id, "machine-scoped");
            const actorApp = listen(fixture.actorA.id, "user-scoped");
            const otherMemberApp = listen(fixture.actorB.id, "user-scoped");
            const suspendedManagerApp = listen(suspendedManager.id, "user-scoped");
            const homeAdminApp = listen(homeAdmin.id, "user-scoped");
            const homeOwnerApp = listen(homeOwner.id, "user-scoped");
            const homeAdminDaemon = listen(homeAdmin.id, "machine-scoped");
            const suspendedHomeAdminApp = listen(suspendedHomeAdmin.id, "user-scoped");
            const outsiderApp = listen(outsider.id, "user-scoped");
            const wake = { type: "team-credential-usage-changed", resourceId: fixture.resourceA.id, teamId: fixture.team.id };

            const session = await db.session.create({
                data: {
                    accountId: fixture.storageAccount.id,
                    tag: crypto.randomUUID(),
                    encryptionMode: "e2ee",
                    metadata: "ciphertext",
                    active: true,
                },
            });
            const turnId = "turn-usage-wake";
            await db.sessionTurn.create({
                data: {
                    sessionId: session.id,
                    turnId,
                    status: "active",
                    startedAt: 1n,
                    updatedAt: 1n,
                    usageActorAccountId: fixture.actorA.id,
                    teamCredentialResourceId: fixture.resourceA.id,
                    credentialDeliveryMode: "brokered",
                },
            });
            const admit = () => inTx((tx) => recordTeamCredentialAdmissionUsageEventInTx(tx, {
                accountId: fixture.storageAccount.id,
                sessionId: session.id,
                turnId,
                observedAt: new Date("2026-09-08T12:00:00.000Z"),
                externalKey: "wake-request-1",
                authority: admissionAuthority({ actorAccountId: fixture.actorA.id, resourceId: fixture.resourceA.id }),
            }));

            await expect(admit()).resolves.toMatchObject({ created: true });
            // Home administration does not require a membership in this Team.
            expect(homeAdminApp).toEqual([wake]);
            expect(homeOwnerApp).toEqual([wake]);
            expect(custodianApp).toEqual([wake]);
            expect(managerApp).toEqual([wake]);
            expect(actorApp).toEqual([wake]);
            expect(EphemeralUpdateSchema.parse(homeAdminApp[0])).toEqual(wake);

            // An idempotent replay records nothing new, so nothing is woken.
            await expect(admit()).resolves.toMatchObject({ created: false });
            expect(managerApp).toEqual([wake]);
            expect(homeAdminApp).toEqual([wake]);

            // The Agent's terminal token/cost observation is the other immutable write.
            await expect(recordUsageEvent(fixture.storageAccount.id, {
                sessionId: session.id,
                observedAt: Date.parse("2026-09-08T12:01:00.000Z"),
                agentId: "claude",
                backendMode: "remote",
                modelId: "claude-sonnet",
                projectKey: null,
                workspaceId: null,
                machineId: "worker-machine-1",
                source: "claude_sdk",
                scope: "turn_delta",
                externalKey: "agent-observation-wake",
                turnId,
                isCumulative: false,
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: { reportedUsd: 0.01, estimatedUsd: 0, invoiceUsd: 0, costSource: "provider_reported", currency: "USD" },
                context: { usedTokens: 2, windowTokens: 200_000 },
            } satisfies UsageEventIngestRequest)).resolves.toMatchObject({ ok: true });
            expect(custodianApp).toEqual([wake, wake]);
            expect(managerApp).toEqual([wake, wake]);
            expect(actorApp).toEqual([wake, wake]);
            expect(homeAdminApp).toEqual([wake, wake]);
            expect(homeOwnerApp).toEqual([wake, wake]);

            // A member reads only their own use; a suspended manager reads nothing;
            // daemons do not render usage and must not rehydrate on it.
            expect(otherMemberApp).toEqual([]);
            expect(suspendedManagerApp).toEqual([]);
            expect(managerDaemon).toEqual([]);
            expect(homeAdminDaemon).toEqual([]);
            expect(suspendedHomeAdminApp).toEqual([]);
            expect(outsiderApp).toEqual([]);
        } finally {
            for (const { accountId, connection } of connections) eventRouter.removeConnection(accountId, connection);
        }
    });
});
