import { vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    decodeBase64,
    signAccountContentKeyBindingV1,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
} from "@happier-dev/protocol";

import type { SessionAccessProjectionRow } from "@/app/session/access/sessionAccess";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import type { RouteRequestOverrides } from "../../testkit/requestFixtures";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

const testAccountSigningKeyPair = tweetnacl.sign.keyPair();
const testAccountContentKeyPair = tweetnacl.box.keyPair();
const testAccountContentPublicKeySig = signAccountContentKeyBindingV1({
    accountSigningSecretKey: testAccountSigningKeyPair.secretKey,
    contentPublicKey: testAccountContentKeyPair.publicKey,
});
const TEST_E2EE_ACCOUNT_CURRENTNESS_ROW = {
    status: "active",
    encryptionMode: "e2ee",
    publicKey: Buffer.from(
        testAccountSigningKeyPair.publicKey,
    ).toString("hex"),
    contentPublicKey: new Uint8Array(
        testAccountContentKeyPair.publicKey,
    ),
    contentPublicKeySig: new Uint8Array(
        testAccountContentPublicKeySig,
    ),
} as const;

export const emitUpdate = vi.fn();
export const emitEphemeral = vi.fn();
export const buildSessionActivityEphemeral = vi.fn((_sessionId: string, active: boolean, time: number, waitingForUser: boolean) => ({
    t: "session-activity",
    active,
    time,
    waitingForUser,
}));
export const buildNewMessageUpdate = vi.fn((_message: any, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-message" },
}));
export const buildMessageUpdatedUpdate = vi.fn((_message: any, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "message-updated" },
}));
export const buildNewSessionUpdate = vi.fn((_session: any, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-session" },
}));
export const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, metadata: any, agentState: any, projection?: any) => ({
        id: updateId,
        seq,
        body: { t: "update-session", metadata, agentState, ...(projection ?? {}) },
    }),
);
export const buildSessionMetadataRecipientUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, projection: any) => ({
        id: updateId,
        seq,
        body: {
            t: "update-session",
            metadata: {
                value: projection.metadata,
                version: projection.metadataVersion,
            },
            metadataLayoutVersion: projection.metadataLayoutVersion,
            ...("ownerMetadata" in projection
                ? { ownerMetadata: { value: projection.ownerMetadata } }
                : {}),
            ...("agentState" in projection
                && "agentStateVersion" in projection
                ? {
                    agentState: {
                        value: projection.agentState,
                        version: projection.agentStateVersion,
                    },
                }
                : {}),
        },
    }),
);

export const randomKeyNaked = vi.fn(() => "upd-id");
export const createSessionMessage = vi.fn();
export const enqueuePendingMessage = vi.fn();
export const patchSession = vi.fn();
export const updateSessionMetadataEnvelopeTuple = vi.fn();
export const applySessionTurnMutation = vi.fn();
export const applySessionReadCursorOperation = vi.fn();
export const clearSessionRuntimeActivityProjectionInTx = vi.fn(async () => ({
    ok: true,
    didWrite: true,
    projection: {
        runtimeActivityState: "unknown",
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0,
    },
    recipientCursors: [],
    badgeAttentionChanged: false,
}));

export const catchupFetchesInc = vi.fn();
export const catchupReturnedInc = vi.fn();

const sessionDbMocks = createDbMocks({
    homeSettings: ["findUnique"],
    homeGovernancePolicy: ["findUnique"],
    account: ["findMany", "findUnique"],
    machine: ["findFirst"],
    session: ["findMany", "findFirst", "findUnique", "update", "updateMany"],
    sessionPin: ["count", "findMany"],
    sessionFolderAssignment: ["findMany"],
    sessionOrganizationFolder: ["findMany"],
    sessionOrganizationTag: ["findMany"],
    sessionTagAssignment: ["findMany"],
    sessionOrganizationOrderEntry: ["findMany"],
    sessionOrganizationLabel: ["findMany"],
    sessionOrganizationCheckpoint: ["findUnique"],
    sessionShare: ["findMany"],
    sessionMessage: ["findMany", "findFirst", "findUnique"],
    sessionPendingMessage: ["count"],
    sessionTurn: ["findFirst", "findMany"],
    sessionDiscussion: ["aggregate", "findMany"],
    sessionDiscussionMessage: ["findMany"],
    sessionDiscussionReadState: ["findMany"],
} as const);

const txDbMocks = createDbMocks({
    automationRun: ["groupBy"],
    automationTrigger: ["findMany"],
    sessionReportsTo: ["findMany", "findUnique"],
    homeSettings: ["findUnique"],
    homeGovernancePolicy: ["findUnique"],
    identityProviderInstance: ["findMany"],
    teamMembership: ["findMany"],
    sessionTeamGrant: ["findMany"],
    sessionGroupGrant: ["findMany"],
    accountSessionFollow: ["updateMany"],
    sessionFollowEdge: ["findMany"],
    account: ["findMany", "findUnique"],
    accessKey: ["findUnique"],
    ephemeralRunnerActivation: ["findFirst"],
    machine: ["findFirst"],
    session: ["create", "findFirst", "findMany", "findUnique", "update", "updateMany"],
    sessionMessage: ["findMany", "findFirst"],
    sessionShare: ["findMany"],
    sessionTurn: ["findFirst", "findMany"],
    sessionPin: ["count", "deleteMany", "findMany", "findUnique", "upsert"],
    sessionFolderAssignment: ["deleteMany", "findMany", "updateMany", "upsert"],
    sessionOrganizationFolder: ["count", "findMany", "updateMany", "upsert"],
    sessionOrganizationTag: ["count", "deleteMany", "findMany", "updateMany", "upsert"],
    sessionTagAssignment: ["createMany", "deleteMany", "findMany"],
    sessionOrganizationOrderEntry: ["deleteMany", "findMany", "upsert"],
    sessionOrganizationLabel: ["count", "findMany", "updateMany", "upsert"],
    sessionOrganizationCheckpoint: ["findUnique", "upsert"],
    sessionSystemRecord: ["create", "findUnique", "findMany", "findFirst", "update", "updateMany", "deleteMany"],
    sessionDiscussion: ["aggregate", "findMany"],
    sessionDiscussionMessage: ["findMany"],
    sessionDiscussionReadState: ["findMany"],
} as const);
export const txExecuteRawUnsafe = vi.fn(async () => 1);
export const dbQueryRaw = vi.fn(async () => [] as Array<{ sessionId: string }>);
const txDb = Object.assign(txDbMocks.db, {
    $executeRawUnsafe: txExecuteRawUnsafe,
    $queryRaw: dbQueryRaw,
});
// Listing/detail routes execute their visibility predicate and row read in the
// same transaction. Keep a separate delegate object so the transaction and
// top-level fixtures can be bridged without overwriting either mock owner.
const txSessionFindFirstDelegate = txDbMocks.db.session.findFirst;
const txSessionFindManyDelegate = txDbMocks.db.session.findMany;
const txAccountFindManyDelegate = txDbMocks.db.account.findMany;
const txAccountFindUniqueDelegate = txDbMocks.db.account.findUnique;
function readSessionIdFilter(value: unknown): ReadonlySet<string> | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = readSessionIdFilter(child);
            if (found) return found;
        }
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const id = record.id;
    if (id && typeof id === "object" && !Array.isArray(id)) {
        const values = (id as Record<string, unknown>).in;
        if (Array.isArray(values) && values.every((item): item is string => typeof item === "string")) {
            return new Set(values);
        }
    }
    for (const key of ["AND", "OR"] as const) {
        const found = readSessionIdFilter(record[key]);
        if (found) return found;
    }
    return undefined;
}
Object.assign(txDb, { session: Object.assign({}, txDbMocks.db.session) });
txDb.session.findFirst = vi.fn(async (...args: Parameters<typeof txSessionFindFirstDelegate>) => {
    const transactionRow = await txSessionFindFirstDelegate(...args);
    return transactionRow ?? await sessionDbMocks.db.session.findFirst(...args);
});
txDb.session.findMany = vi.fn(async (...args: Parameters<typeof txDbMocks.db.session.findMany>) => {
    const transactionRows = await txSessionFindManyDelegate(...args);
    const fallbackRows = await sessionDbMocks.db.session.findMany(...args);
    if (typeof args[0]?.take === "number" && args[0].take <= 2) {
        return fallbackRows;
    }
    // The initial attention branch deliberately asks for a large candidate
    // window; its transaction fixture is distinct from the regular page.
    if (Array.isArray(transactionRows) && transactionRows.length > 0
        && typeof args[0]?.take === "number" && args[0].take > 2) {
        return transactionRows;
    }
    // Prefer an explicitly programmed top-level fixture whenever it returns
    // rows. Transaction fixtures still supply rows when that surface is empty.
    if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
        return fallbackRows;
    }
    const idFilter = readSessionIdFilter(args[0]?.where);
    const transactionRowsMatchRequestedIds = idFilter
        && Array.isArray(transactionRows)
        && transactionRows.some((row) => idFilter.has(row.id));
    if (transactionRowsMatchRequestedIds) {
        // Preserve the legacy spy's observation surface for list tests while
        // the returned rows remain owned by the transactional delegate.
        return transactionRows;
    }
    // Some list branches (for example pinned-session expansion) select by an
    // explicit id set while other branches use a broad predicate. When a test
    // programs a transactional fixture for the broad branch, it must not mask
    // the top-level fixture for an id-specific query.
    if (idFilter && Array.isArray(transactionRows)) {
        return fallbackRows;
    }
    return transactionRows ?? fallbackRows;
});
Object.assign(txDb, { account: Object.assign({}, txDbMocks.db.account) });
txDb.account.findMany = vi.fn(async (...args: Parameters<typeof txAccountFindManyDelegate>) => {
    const transactionRows = await txAccountFindManyDelegate(...args);
    return transactionRows ?? await sessionDbMocks.db.account.findMany(...args);
});
txDb.account.findUnique = vi.fn(async (...args: Parameters<typeof txAccountFindUniqueDelegate>) => {
    const transactionRow = await txAccountFindUniqueDelegate(...args);
    return transactionRow ?? await sessionDbMocks.db.account.findUnique(...args);
});

export const sessionFindMany = sessionDbMocks.db.session.findMany;
export const sessionFindFirst = sessionDbMocks.db.session.findFirst;
export const sessionFindUnique = sessionDbMocks.db.session.findUnique;
export const accountFindUnique = sessionDbMocks.db.account.findUnique;
export const machineFindFirst = sessionDbMocks.db.machine.findFirst;
export const accountFindMany = sessionDbMocks.db.account.findMany;
export const sessionUpdate = sessionDbMocks.db.session.update;
export const sessionUpdateMany = sessionDbMocks.db.session.updateMany;
export const sessionPinCount = sessionDbMocks.db.sessionPin.count;
export const sessionPinFindMany = sessionDbMocks.db.sessionPin.findMany;
export const sessionFolderAssignmentFindMany = sessionDbMocks.db.sessionFolderAssignment.findMany;
export const sessionOrganizationFolderFindMany = sessionDbMocks.db.sessionOrganizationFolder.findMany;
export const sessionOrganizationTagFindMany = sessionDbMocks.db.sessionOrganizationTag.findMany;
export const sessionTagAssignmentFindMany = sessionDbMocks.db.sessionTagAssignment.findMany;
export const sessionOrganizationOrderEntryFindMany = sessionDbMocks.db.sessionOrganizationOrderEntry.findMany;
export const sessionOrganizationLabelFindMany = sessionDbMocks.db.sessionOrganizationLabel.findMany;
export const sessionOrganizationCheckpointFindUnique = sessionDbMocks.db.sessionOrganizationCheckpoint.findUnique;
export const sessionMessageFindMany = sessionDbMocks.db.sessionMessage.findMany;
export const sessionMessageFindFirst = sessionDbMocks.db.sessionMessage.findFirst;
export const sessionMessageFindUnique = sessionDbMocks.db.sessionMessage.findUnique;
export const sessionPendingMessageCount = sessionDbMocks.db.sessionPendingMessage.count;
export const sessionTurnFindMany = sessionDbMocks.db.sessionTurn.findMany;
export const sessionShareFindMany = sessionDbMocks.db.sessionShare.findMany;
export const sessionDiscussionAggregate = sessionDbMocks.db.sessionDiscussion.aggregate;
export const sessionDiscussionFindMany = sessionDbMocks.db.sessionDiscussion.findMany;
export const sessionDiscussionMessageFindMany = sessionDbMocks.db.sessionDiscussionMessage.findMany;
export const sessionDiscussionReadStateFindMany = sessionDbMocks.db.sessionDiscussionReadState.findMany;

export const txAccountFindMany = txDbMocks.db.account.findMany;
export const txAccessKeyFindUnique = txDbMocks.db.accessKey.findUnique;
export const txEphemeralRunnerActivationFindFirst = txDbMocks.db.ephemeralRunnerActivation.findFirst;
export const txMachineFindFirst = txDbMocks.db.machine.findFirst;
export const txSessionFindFirst = txSessionFindFirstDelegate;
export const txSessionFindMany = txSessionFindManyDelegate;
export const txSessionFindUnique = txDbMocks.db.session.findUnique;
export const txSessionCreate = txDbMocks.db.session.create;
export const txSessionUpdate = txDbMocks.db.session.update;
export const txSessionUpdateMany = txDbMocks.db.session.updateMany;
export const txSessionMessageFindMany = txDbMocks.db.sessionMessage.findMany;
export const txSessionMessageFindFirst = txDbMocks.db.sessionMessage.findFirst;
export const txSessionShareFindMany = txDbMocks.db.sessionShare.findMany;
export const txSessionTurnFindFirst = txDbMocks.db.sessionTurn.findFirst;
export const txSessionTurnFindMany = txDbMocks.db.sessionTurn.findMany;
export const txSessionPinCount = txDbMocks.db.sessionPin.count;
export const txSessionPinDeleteMany = txDbMocks.db.sessionPin.deleteMany;
export const txSessionPinFindMany = txDbMocks.db.sessionPin.findMany;
export const txSessionPinFindUnique = txDbMocks.db.sessionPin.findUnique;
export const txSessionPinUpsert = txDbMocks.db.sessionPin.upsert;
export const txSessionFolderAssignmentDeleteMany = txDbMocks.db.sessionFolderAssignment.deleteMany;
export const txSessionFolderAssignmentFindMany = txDbMocks.db.sessionFolderAssignment.findMany;
export const txSessionFolderAssignmentUpdateMany = txDbMocks.db.sessionFolderAssignment.updateMany;
export const txSessionFolderAssignmentUpsert = txDbMocks.db.sessionFolderAssignment.upsert;
export const txSessionOrganizationFolderCount = txDbMocks.db.sessionOrganizationFolder.count;
export const txSessionOrganizationFolderFindMany = txDbMocks.db.sessionOrganizationFolder.findMany;
export const txSessionOrganizationFolderUpdateMany = txDbMocks.db.sessionOrganizationFolder.updateMany;
export const txSessionOrganizationFolderUpsert = txDbMocks.db.sessionOrganizationFolder.upsert;
export const txSessionOrganizationTagCount = txDbMocks.db.sessionOrganizationTag.count;
export const txSessionOrganizationTagDeleteMany = txDbMocks.db.sessionOrganizationTag.deleteMany;
export const txSessionOrganizationTagFindMany = txDbMocks.db.sessionOrganizationTag.findMany;
export const txSessionOrganizationTagUpdateMany = txDbMocks.db.sessionOrganizationTag.updateMany;
export const txSessionOrganizationTagUpsert = txDbMocks.db.sessionOrganizationTag.upsert;
export const txSessionTagAssignmentCreateMany = txDbMocks.db.sessionTagAssignment.createMany;
export const txSessionTagAssignmentDeleteMany = txDbMocks.db.sessionTagAssignment.deleteMany;
export const txSessionTagAssignmentFindMany = txDbMocks.db.sessionTagAssignment.findMany;
export const txSessionOrganizationOrderEntryDeleteMany = txDbMocks.db.sessionOrganizationOrderEntry.deleteMany;
export const txSessionOrganizationOrderEntryFindMany = txDbMocks.db.sessionOrganizationOrderEntry.findMany;
export const txSessionOrganizationOrderEntryUpsert = txDbMocks.db.sessionOrganizationOrderEntry.upsert;
export const txSessionOrganizationLabelCount = txDbMocks.db.sessionOrganizationLabel.count;
export const txSessionOrganizationLabelFindMany = txDbMocks.db.sessionOrganizationLabel.findMany;
export const txSessionOrganizationLabelUpdateMany = txDbMocks.db.sessionOrganizationLabel.updateMany;
export const txSessionOrganizationLabelUpsert = txDbMocks.db.sessionOrganizationLabel.upsert;
export const txSessionOrganizationCheckpointFindUnique = txDbMocks.db.sessionOrganizationCheckpoint.findUnique;
export const txSessionOrganizationCheckpointUpsert = txDbMocks.db.sessionOrganizationCheckpoint.upsert;
export const txSessionSystemRecordCreate = txDbMocks.db.sessionSystemRecord.create;
export const txSessionSystemRecordFindUnique = txDbMocks.db.sessionSystemRecord.findUnique;
export const txSessionSystemRecordFindMany = txDbMocks.db.sessionSystemRecord.findMany;
export const txSessionSystemRecordFindFirst = txDbMocks.db.sessionSystemRecord.findFirst;
export const txSessionSystemRecordUpdate = txDbMocks.db.sessionSystemRecord.update;
export const txSessionSystemRecordUpdateMany = txDbMocks.db.sessionSystemRecord.updateMany;
export const txSessionSystemRecordDeleteMany = txDbMocks.db.sessionSystemRecord.deleteMany;
export const txAccountFindUnique = txDbMocks.db.account.findUnique;
export const txSessionDiscussionAggregate = txDbMocks.db.sessionDiscussion.aggregate;
export const txSessionDiscussionFindMany = txDbMocks.db.sessionDiscussion.findMany;
export const txSessionDiscussionMessageFindMany = txDbMocks.db.sessionDiscussionMessage.findMany;
export const txSessionDiscussionReadStateFindMany = txDbMocks.db.sessionDiscussionReadState.findMany;

interface MaterializedRunnerCurrentnessFixtureOverrides {
    readonly activation?: Readonly<{ id: string }> | null;
    readonly session?: Readonly<{ id: string }> | null;
    readonly machine?: Readonly<{ installationPublicKey: Uint8Array }> | null;
    readonly accessKey?: Readonly<{ accountId: string }> | null;
    readonly installationPublicKey?: string;
    readonly tokenEpoch?: number;
}

/**
 * Programs the five persisted records checked by the real materialized-Runner
 * currentness owner. Individual route specs may replace one record to prove a
 * revocation/currentness failure without mocking that owner.
 */
export function configureMaterializedRunnerCurrentnessFixture(
    overrides: MaterializedRunnerCurrentnessFixtureOverrides = {},
): void {
    const installationPublicKey = overrides.installationPublicKey
        ?? "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    txAccountFindUnique.mockResolvedValue({
        ...TEST_E2EE_ACCOUNT_CURRENTNESS_ROW,
        tokenEpoch: overrides.tokenEpoch ?? 1,
    });
    txEphemeralRunnerActivationFindFirst.mockResolvedValue(
        overrides.activation === undefined
            ? { id: "00000000-0000-4000-8000-000000000001" }
            : overrides.activation,
    );
    txSessionFindFirst.mockResolvedValue(
        overrides.session === undefined ? { id: "runner-session" } : overrides.session,
    );
    txMachineFindFirst.mockResolvedValue(
        overrides.machine === undefined
            ? { installationPublicKey: decodeBase64(installationPublicKey, "base64url") }
            : overrides.machine,
    );
    txAccessKeyFindUnique.mockResolvedValue(
        overrides.accessKey === undefined ? { accountId: "u1" } : overrides.accessKey,
    );
}

/**
 * The access relations every canonical Session projection select carries.
 *
 * `buildSessionAccessProjectionSelect` requires the owning Account's status and
 * the three grant relations, so a DB-boundary row fixture that omits them makes
 * the real access projector throw instead of exercising the guard it owns. The
 * type is taken from the production select so the fixture cannot drift from it.
 */
export function createSessionAccessProjectionRelations(): Pick<
    SessionAccessProjectionRow,
    "account" | "shares" | "teamGrants" | "groupGrants"
> {
    return { account: { status: "active" }, shares: [], teamGrants: [], groupGrants: [] };
}

/**
 * Test row for the viewer's canonical `(Session, Account)` DEK tuple.
 *
 * Listing and detail now validate the nested recipient binding through Lane
 * 06's readiness owner before projecting an E2EE envelope. Keeping that
 * relation in one fixture prevents route tests from silently exercising an
 * obsolete envelope-only row shape.
 */
export function createSessionDataKeyEnvelopeFixture(
    encryptedDataKey: Uint8Array,
    recipientAccountId = "u1",
) {
    return {
        encryptedDataKey,
        recipientAccount: {
            id: recipientAccountId,
            publicKey: TEST_E2EE_ACCOUNT_CURRENTNESS_ROW.publicKey,
            encryptionMode: TEST_E2EE_ACCOUNT_CURRENTNESS_ROW.encryptionMode,
            contentPublicKey: TEST_E2EE_ACCOUNT_CURRENTNESS_ROW.contentPublicKey,
            contentPublicKeySig: TEST_E2EE_ACCOUNT_CURRENTNESS_ROW.contentPublicKeySig,
        },
    };
}

/** Test-only view of the canonical list query's explicit conjunction. */
export function flattenSessionWhereConjuncts(value: unknown): ReadonlyArray<Record<string, unknown>> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const { AND, ...rest } = record;
    const clauses: Record<string, unknown>[] = Object.keys(rest).length > 0 ? [rest] : [];
    const nested = Array.isArray(AND) ? AND : AND && typeof AND === "object" ? [AND] : [];
    for (const clause of nested) clauses.push(...flattenSessionWhereConjuncts(clause));
    return clauses;
}

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, emitEphemeral },
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildNewSessionUpdate,
    buildSessionActivityEphemeral,
    buildSessionMetadataRecipientUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/app/monitoring/metrics/index", () => ({
    catchupFollowupFetchesCounter: { inc: catchupFetchesInc },
    catchupFollowupReturnedCounter: { inc: catchupReturnedInc },
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({
    randomKeyNaked,
}));

vi.mock("@/app/session/sessionWriteService", () => ({
    applySessionTurnMutation,
    applySessionReadCursorOperation,
    clearSessionRuntimeActivityProjectionInTx,
    createSessionMessage,
    patchSession,
    updateSessionMetadataEnvelopeTuple,
}));

export const listQueuedExecutionRunPendingTargetsForSessions = vi.fn(async () => []);
vi.mock("@/app/session/pending/pendingMessageService", () => ({
    enqueuePendingMessage,
    listQueuedExecutionRunPendingTargetsForSessions,
}));

const PRISMA_RUNTIME_MOCK = {
    raw: (value: string) => value,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    DbNull: Symbol.for("Prisma.DbNull"),
    JsonNull: Symbol.for("Prisma.JsonNull"),
    AnyNull: Symbol.for("Prisma.AnyNull"),
};

installDbModuleMock({
    db: Object.assign(sessionDbMocks.db, { $queryRaw: dbQueryRaw }),
    getDbProviderFromEnv: () => "postgres",
    prismaRuntime: PRISMA_RUNTIME_MOCK,
    // Sentinel access mirrors the real provider-matched namespace; bounded JSON
    // null filters (`producerV1`) are built through it.
    getActivePrismaRuntime: () => PRISMA_RUNTIME_MOCK,
    isPrismaErrorCode(error: unknown, code: string) {
        if (!error || typeof error !== "object") {
            return false;
        }
        return (error as { code?: unknown }).code === code;
    },
});

/**
 * `getActivePrismaRuntime` is part of the database boundary: it hands back the
 * provider-matched namespace only once a client is connected. These specs stub
 * the client, so resolve the sentinel namespace from the real module rather
 * than leaving JSON-null predicates (Lane 05 discussion authorship) unbuildable.
 */
vi.doMock("@/storage/prisma", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/storage/prisma")>();
    return { ...original, getActivePrismaRuntime: () => original.prismaRuntime };
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
export const markSessionInactive = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { markSessionInactive },
}));
export const refreshTrackedSessionAccountBadgePushes = vi.fn(async () => {});
export const scheduleAccountActivityBadgeRefresh = vi.fn(() => {});
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshTrackedSessionAccountBadgePushes,
    scheduleAccountActivityBadgeRefresh,
}));
export const didSessionActivityBadgeSignalChange = vi.fn(() => false);
vi.mock("@/app/activity/accountActivityBadge", () => ({
    didSessionActivityBadgeSignalChange,
}));
type SessionDeleteMockResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        error: "not-found" | "conflict" | "client-upgrade-required";
    }>;
export const sessionDelete = vi.fn<(
    ctx: Readonly<{ uid: string }>,
    sessionId: string,
    options: Readonly<{
        supportsCurrentStoredContentProtocol: boolean;
    }>,
) => Promise<SessionDeleteMockResult>>(async () => ({ ok: true as const }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete }));
/**
 * The Agent-transition cutover is mocked at the SERVICE boundary only. The
 * route's publication path — including the real
 * `publishSessionCurrentViewUpdates` and the real recipient projector — stays
 * live, so a spec can prove what actually reaches the wire.
 */
export const applySessionAgentTransitionCutover = vi.fn();
vi.mock("@/app/session/agentTransition/applySessionAgentTransitionCutover", () => ({
    applySessionAgentTransitionCutover,
}));
export const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
export const markAccountChangedAfterCommit = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChangedAfterCommit", () => ({ markAccountChangedAfterCommit }));
vi.mock("@/app/account/profile/accountDisplayProfile", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/account/profile/accountDisplayProfile")>()),
    ACCOUNT_DISPLAY_PROFILE_SELECT: {},
    toShareUserProfile: vi.fn(),
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: any) => await fn(txDb)),
    afterTx: vi.fn(),
}));

export function resetSessionRouteMocks(): void {
    vi.clearAllMocks();
    sessionDbMocks.reset();
    txDbMocks.reset();
    txExecuteRawUnsafe.mockReset();
    txExecuteRawUnsafe.mockResolvedValue(1);
    listQueuedExecutionRunPendingTargetsForSessions.mockReset();
    listQueuedExecutionRunPendingTargetsForSessions.mockResolvedValue([]);
    dbQueryRaw.mockReset();
    dbQueryRaw.mockResolvedValue([]);
    // List/detail projections read these persisted relations even when a
    // fixture has neither pending review runs nor Reports-to edges.
    txDb.automationRun.groupBy.mockResolvedValue([]);
    txDb.automationTrigger.findMany.mockResolvedValue([]);
    txDb.sessionReportsTo.findMany.mockResolvedValue([]);
    txDb.sessionReportsTo.findUnique.mockResolvedValue(null);
    txDb.teamMembership.findMany.mockResolvedValue([]);
    // No persisted Home overrides: exercise the real deployment-inheriting overlay.
    sessionDbMocks.db.homeSettings.findUnique.mockResolvedValue(null);
    sessionDbMocks.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
    sessionDbMocks.db.machine.findFirst.mockResolvedValue(null);
    txDb.homeSettings.findUnique.mockResolvedValue(null);
    txDb.homeGovernancePolicy.findUnique.mockResolvedValue(null);
    txDb.identityProviderInstance.findMany.mockResolvedValue([]);
    randomKeyNaked.mockReturnValue("upd-id");
    sessionDelete.mockReset();
    sessionDelete.mockResolvedValue({ ok: true });
    applySessionTurnMutation.mockReset();
    applySessionReadCursorOperation.mockReset();
    applySessionAgentTransitionCutover.mockReset();
    sessionFindMany.mockResolvedValue([]);
    sessionFindFirst.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
        ...createSessionAccessProjectionRelations(),
        id: "s1",
        accountId: "u1",
        metadata: "mNew",
        metadataVersion: 2,
        metadataLayoutVersion: 0,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 3,
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: null,
    });
    accountFindUnique.mockResolvedValue(
        TEST_E2EE_ACCOUNT_CURRENTNESS_ROW,
    );
    accountFindMany.mockImplementation(async (args) => {
        const ids = args?.where?.id?.in ?? [];
        return ids.map((id: string) => ({
            id,
            ...TEST_E2EE_ACCOUNT_CURRENTNESS_ROW,
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
        }));
    });
    emitEphemeral.mockReset();
    buildSessionActivityEphemeral.mockClear();
    markSessionInactive.mockReset();
    refreshTrackedSessionAccountBadgePushes.mockClear();
    scheduleAccountActivityBadgeRefresh.mockClear();
    didSessionActivityBadgeSignalChange.mockReturnValue(false);
    sessionUpdate.mockImplementation(async () => {
        throw new Error("sessionUpdate not configured for test");
    });
    sessionPinCount.mockResolvedValue(0);
    sessionPinFindMany.mockResolvedValue([]);
    sessionFolderAssignmentFindMany.mockResolvedValue([]);
    sessionOrganizationFolderFindMany.mockResolvedValue([]);
    sessionOrganizationTagFindMany.mockResolvedValue([]);
    sessionTagAssignmentFindMany.mockResolvedValue([]);
    sessionOrganizationOrderEntryFindMany.mockResolvedValue([]);
    sessionOrganizationLabelFindMany.mockResolvedValue([]);
    sessionOrganizationCheckpointFindUnique.mockResolvedValue(null);
    sessionMessageFindMany.mockResolvedValue([]);
    sessionMessageFindFirst.mockResolvedValue(null);
    sessionMessageFindUnique.mockResolvedValue(null);
    sessionPendingMessageCount.mockResolvedValue(0);
    sessionTurnFindMany.mockResolvedValue([]);
    sessionShareFindMany.mockResolvedValue([]);
    sessionDiscussionAggregate.mockResolvedValue({ _max: { lastMessageAt: null } });
    sessionDiscussionFindMany.mockResolvedValue([]);
    sessionDiscussionMessageFindMany.mockResolvedValue([]);
    sessionDiscussionReadStateFindMany.mockResolvedValue([]);
    txSessionFindMany.mockReset();
    txAccessKeyFindUnique.mockResolvedValue(null);
    txEphemeralRunnerActivationFindFirst.mockResolvedValue(null);
    txMachineFindFirst.mockResolvedValue(null);
    txSessionFindUnique.mockResolvedValue({
        ...createSessionAccessProjectionRelations(),
        id: "s1",
        accountId: "u1",
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: null,
    });
    txDbMocks.db.sessionTeamGrant.findMany.mockResolvedValue([]);
    txDbMocks.db.sessionGroupGrant.findMany.mockResolvedValue([]);
    txDbMocks.db.accountSessionFollow.updateMany.mockResolvedValue({ count: 0 });
    txDbMocks.db.sessionFollowEdge.findMany.mockResolvedValue([]);
    txSessionMessageFindMany.mockResolvedValue([]);
    txSessionMessageFindFirst.mockResolvedValue(null);
    txSessionShareFindMany.mockResolvedValue([]);
    txSessionTurnFindFirst.mockResolvedValue(null);
    txSessionTurnFindMany.mockResolvedValue([]);
    txAccountFindUnique.mockReset();
    txSessionDiscussionAggregate.mockResolvedValue({ _max: { lastMessageAt: null } });
    txSessionDiscussionFindMany.mockResolvedValue([]);
    txSessionDiscussionMessageFindMany.mockResolvedValue([]);
    txSessionDiscussionReadStateFindMany.mockResolvedValue([]);
    txSessionCreate.mockImplementation(async () => {
        throw new Error("txSessionCreate not configured for test");
    });
    txSessionUpdate.mockImplementation(async () => {
        throw new Error("txSessionUpdate not configured for test");
    });
    txSessionPinCount.mockResolvedValue(0);
    txSessionPinDeleteMany.mockResolvedValue({ count: 0 });
    txSessionPinFindMany.mockResolvedValue([]);
    txSessionPinFindUnique.mockResolvedValue(null);
    txSessionPinUpsert.mockImplementation(async () => {
        throw new Error("txSessionPinUpsert not configured for test");
    });
    txSessionFolderAssignmentDeleteMany.mockResolvedValue({ count: 0 });
    txSessionFolderAssignmentFindMany.mockResolvedValue([]);
    txSessionFolderAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    txSessionFolderAssignmentUpsert.mockImplementation(async () => {
        throw new Error("txSessionFolderAssignmentUpsert not configured for test");
    });
    txSessionOrganizationFolderCount.mockResolvedValue(0);
    txSessionOrganizationFolderFindMany.mockResolvedValue([]);
    txSessionOrganizationFolderUpdateMany.mockResolvedValue({ count: 0 });
    txSessionOrganizationFolderUpsert.mockImplementation(async () => {
        throw new Error("txSessionOrganizationFolderUpsert not configured for test");
    });
    txSessionOrganizationTagCount.mockResolvedValue(0);
    txSessionOrganizationTagDeleteMany.mockResolvedValue({ count: 0 });
    txSessionOrganizationTagFindMany.mockResolvedValue([]);
    txSessionOrganizationTagUpdateMany.mockResolvedValue({ count: 0 });
    txSessionOrganizationTagUpsert.mockImplementation(async () => {
        throw new Error("txSessionOrganizationTagUpsert not configured for test");
    });
    txSessionTagAssignmentCreateMany.mockResolvedValue({ count: 0 });
    txSessionTagAssignmentDeleteMany.mockResolvedValue({ count: 0 });
    txSessionTagAssignmentFindMany.mockResolvedValue([]);
    txSessionOrganizationOrderEntryDeleteMany.mockResolvedValue({ count: 0 });
    txSessionOrganizationOrderEntryFindMany.mockResolvedValue([]);
    txSessionOrganizationOrderEntryUpsert.mockImplementation(async () => {
        throw new Error("txSessionOrganizationOrderEntryUpsert not configured for test");
    });
    txSessionOrganizationLabelCount.mockResolvedValue(0);
    txSessionOrganizationLabelFindMany.mockResolvedValue([]);
    txSessionOrganizationLabelUpdateMany.mockResolvedValue({ count: 0 });
    txSessionOrganizationLabelUpsert.mockImplementation(async () => {
        throw new Error("txSessionOrganizationLabelUpsert not configured for test");
    });
    txSessionOrganizationCheckpointUpsert.mockResolvedValue({ version: 1 });
    txSessionSystemRecordCreate.mockImplementation(async () => {
        throw new Error("txSessionSystemRecordCreate not configured for test");
    });
    txSessionSystemRecordFindUnique.mockResolvedValue(null);
    txSessionSystemRecordFindMany.mockResolvedValue([]);
    txSessionSystemRecordFindFirst.mockResolvedValue(null);
    txSessionSystemRecordUpdate.mockImplementation(async () => {
        throw new Error("txSessionSystemRecordUpdate not configured for test");
    });
    txSessionSystemRecordUpdateMany.mockResolvedValue({ count: 0 });
    txSessionSystemRecordDeleteMany.mockResolvedValue({ count: 0 });
    markAccountChangedAfterCommit.mockResolvedValue(1);
}

let sessionRoutesModulePromise: Promise<typeof import("./sessionRoutes")> | null = null;

async function importSessionRoutesModule(): Promise<typeof import("./sessionRoutes")> {
    if (!sessionRoutesModulePromise) {
        sessionRoutesModulePromise = import("./sessionRoutes").catch((error) => {
            sessionRoutesModulePromise = null;
            throw error;
        });
    }
    return await sessionRoutesModulePromise;
}

export async function createSessionRouteTestBuilder(
    method: RouteMethod,
    path: string,
    options: { defaultRequest?: RouteRequestOverrides } = {},
) {
    const { sessionRoutes } = await importSessionRoutesModule();
    return createRouteTestBuilder({
        method,
        path,
        defaultRequest: {
            userId: "u1",
            // Production reaches these handlers only after the central
            // authentication decorator has stamped the verified credential
            // authority. Keep the route harness truthful instead of making
            // Session access accept an authority-less request.
            authAuthority: "present_user",
            authTokenKind: "account",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                outcome: "accepted",
                declaration: {
                    v: 1,
                    protocolVersion:
                        CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                },
                upgradeRequired: null,
            },
            ...options.defaultRequest,
        },
        registerRoutes(app) {
            sessionRoutes(app as any);
        },
    });
}
