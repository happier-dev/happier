import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type { ClaimedDirectorySource } from "./directorySourceService";
import { catchUpDirectorySource, scanDirectorySource } from "./directorySourceScanner";

const upstream = vi.hoisted(() => ({
    construct: vi.fn(),
    listUsers: vi.fn(),
    listGroups: vi.fn(),
    listEvents: vi.fn(),
}));

// Only the external SDK is replaced. Source identity, Team connection,
// worker environment and currentness are resolved by their production owners.
vi.mock("@workos-inc/node", () => ({
    WorkOS: class {
        constructor(...args: unknown[]) { upstream.construct(...args); }
        directorySync = { listUsers: upstream.listUsers, listGroups: upstream.listGroups };
        events = { listEvents: upstream.listEvents };
    },
}));

const env = { WORKOS_API_KEY: "sk_test_scanner", WORKOS_CLIENT_ID: "client_scanner" };
const claimed: ClaimedDirectorySource = {
    id: "source-workos",
    teamId: "team-workos",
    kind: "workos_directory",
    binding: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_1" },
    reconcileRunId: "run-workos",
    eventCursor: null,
    eventRangeStart: new Date("2026-09-05T09:00:00.000Z"),
    observedManualSyncRequestedAt: null,
};

const expectedCurrentness = {
    kind: "workos_directory_read",
    directorySourceId: claimed.id,
    teamIdentityConnectionId: "connection-workos",
    workosDirectoryId: "directory_1",
    organizationId: "org_1",
    runtimeFingerprint: expect.any(String),
};

function scan(workerEnv = env) {
    return scanDirectorySource({
        source: claimed, env: workerEnv,
        writePeoplePage: async () => true,
        writeGroupsPage: async () => true,
        writeGroupMembersPage: async () => true,
    });
}

function catchUp(workerEnv = env, writeWorkosEvent = vi.fn(async () => true)) {
    return catchUpDirectorySource({
        source: claimed, env: workerEnv, writeWorkosEvent,
        stageWorkosGroupMembersEventPage: async () => true,
    });
}

describe("WorkOS directory source dispatch with real connection resolution", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workos-scanner-", initAuth: false });
        await db.homeGovernancePolicy.create({ data: { id: "home", teamProviderPolicy: {
            v: 1, allowedTeamProviderKinds: ["workos_sso"], teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [],
        } } });
        await db.team.create({ data: { id: claimed.teamId, name: "WorkOS scanner" } });
        await db.identityProviderInstance.create({ data: {
            id: "provider-workos", ownerTeamId: claimed.teamId, kind: "workos_sso", displayName: "WorkOS",
            enabled: true, firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } });
        await db.teamIdentityConnection.create({ data: {
            id: "connection-workos", teamId: claimed.teamId, providerInstanceId: "provider-workos",
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_1", connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        await db.teamDirectorySource.create({ data: {
            id: claimed.id, teamId: claimed.teamId, kind: claimed.kind, state: "initializing",
            displayName: "WorkOS scanner", externalSourceKey: "workos:scanner", bindingConfig: claimed.binding,
            teamIdentityConnectionId: "connection-workos", activeReconcileRunId: claimed.reconcileRunId,
            activeReconcileStartedAt: claimed.eventRangeStart,
        } });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    beforeEach(() => {
        vi.clearAllMocks();
        upstream.listUsers.mockResolvedValue({ data: [], listMetadata: { after: null } });
        upstream.listGroups.mockResolvedValue({ data: [], listMetadata: { after: null } });
        upstream.listEvents.mockResolvedValue({ data: [], listMetadata: { after: null } });
    });

    it("resolves the same persisted source identity for snapshot and replay", async () => {
        const snapshot = await scan();
        const replay = await catchUp();
        expect(snapshot).toEqual({ ok: true, expectedCurrentness });
        expect(replay).toEqual(snapshot);
        expect(upstream.listUsers).toHaveBeenCalledWith({ directory: "directory_1", after: null, limit: 100 });
        expect(upstream.listEvents).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1" }));
    });

    it("uses the worker environment for both phases and refuses missing platform credentials", async () => {
        expect(await scan()).toMatchObject({ ok: true });
        expect(await catchUp()).toMatchObject({ ok: true });
        expect(upstream.construct).toHaveBeenCalledWith(expect.objectContaining({ apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID }));
        expect(await scan({ WORKOS_API_KEY: "", WORKOS_CLIENT_ID: "" })).toEqual({ ok: false, code: "directory_sync_unavailable" });
        expect(await catchUp({ WORKOS_API_KEY: "", WORKOS_CLIENT_ID: "" })).toEqual({ ok: false, code: "directory_sync_unavailable" });
    });

    it("carries resolved currentness with an event before the native write", async () => {
        upstream.listEvents.mockResolvedValueOnce({
            data: [{ id: "event_1", event: "dsync.activated", data: { id: "directory_1", organizationId: "org_1" } }],
            listMetadata: { after: "event_1" },
        });
        const write = vi.fn(async () => true);
        const result = await catchUp(env, write);
        expect(result).toEqual({ ok: true, expectedCurrentness });
        expect(write).toHaveBeenCalledWith({
            expectedPosition: { eventCursor: null, eventRangeStart: claimed.eventRangeStart }, eventId: "event_1",
        }, expect.objectContaining(expectedCurrentness));
    });
});
