import { vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import type { RouteRequestOverrides } from "../../testkit/requestFixtures";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

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
    participantCursors: [],
    badgeAttentionChanged: false,
}));
export const checkSessionAccess = vi.fn(async () => ({ level: "owner" }));
export const requireAccessLevel = vi.fn((access: any, required: any) => {
    const levels = ["view", "edit", "admin", "owner"];
    const userLevel = levels.indexOf(access?.level);
    const requiredLevel = levels.indexOf(required);
    return userLevel >= requiredLevel;
});
export const getSessionParticipantUserIds = vi.fn<(...args: any[]) => Promise<string[]>>(async () => []);

export const catchupFetchesInc = vi.fn();
export const catchupReturnedInc = vi.fn();

const sessionDbMocks = createDbMocks({
    account: ["findUnique"],
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
    sessionTurn: ["findMany"],
} as const);

const txDbMocks = createDbMocks({
    account: ["findUnique"],
    session: ["create", "findFirst", "findMany", "findUnique", "update"],
    sessionMessage: ["findMany", "findFirst"],
    sessionPin: ["count", "deleteMany", "findMany", "findUnique", "upsert"],
    sessionFolderAssignment: ["deleteMany", "findMany", "updateMany", "upsert"],
    sessionOrganizationFolder: ["count", "findMany", "updateMany", "upsert"],
    sessionOrganizationTag: ["count", "deleteMany", "findMany", "updateMany", "upsert"],
    sessionTagAssignment: ["createMany", "deleteMany", "findMany"],
    sessionOrganizationOrderEntry: ["deleteMany", "findMany", "upsert"],
    sessionOrganizationLabel: ["count", "findMany", "updateMany", "upsert"],
    sessionOrganizationCheckpoint: ["upsert"],
    sessionSystemRecord: ["create", "findUnique", "findMany", "findFirst", "update"],
} as const);

export const sessionFindMany = sessionDbMocks.db.session.findMany;
export const sessionFindFirst = sessionDbMocks.db.session.findFirst;
export const sessionFindUnique = sessionDbMocks.db.session.findUnique;
export const accountFindUnique = sessionDbMocks.db.account.findUnique;
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

export const txSessionFindFirst = txDbMocks.db.session.findFirst;
export const txSessionFindMany = txDbMocks.db.session.findMany;
export const txSessionFindUnique = txDbMocks.db.session.findUnique;
export const txSessionCreate = txDbMocks.db.session.create;
export const txSessionUpdate = txDbMocks.db.session.update;
export const txSessionMessageFindMany = txDbMocks.db.sessionMessage.findMany;
export const txSessionMessageFindFirst = txDbMocks.db.sessionMessage.findFirst;
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
export const txSessionOrganizationCheckpointUpsert = txDbMocks.db.sessionOrganizationCheckpoint.upsert;
export const txSessionSystemRecordCreate = txDbMocks.db.sessionSystemRecord.create;
export const txSessionSystemRecordFindUnique = txDbMocks.db.sessionSystemRecord.findUnique;
export const txSessionSystemRecordFindMany = txDbMocks.db.sessionSystemRecord.findMany;
export const txSessionSystemRecordFindFirst = txDbMocks.db.sessionSystemRecord.findFirst;
export const txSessionSystemRecordUpdate = txDbMocks.db.sessionSystemRecord.update;
export const txAccountFindUnique = txDbMocks.db.account.findUnique;

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

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));

installDbModuleMock({
    db: sessionDbMocks.db,
    isPrismaErrorCode(error: unknown, code: string) {
        if (!error || typeof error !== "object") {
            return false;
        }
        return (error as { code?: unknown }).code === code;
    },
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
export const markSessionInactive = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { markSessionInactive },
}));
export const refreshSessionParticipantBadgePushes = vi.fn(async () => {});
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes,
}));
export const didSessionActivityBadgeContributionChange = vi.fn(() => false);
vi.mock("@/app/activity/accountActivityBadge", () => ({
    didSessionActivityBadgeContributionChange,
}));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
export const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
export const markAccountChangedAfterCommit = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChangedAfterCommit", () => ({ markAccountChangedAfterCommit }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: any) => await fn(txDbMocks.db)),
    afterTx: vi.fn(),
}));

export function resetSessionRouteMocks(): void {
    vi.clearAllMocks();
    sessionDbMocks.reset();
    txDbMocks.reset();
    randomKeyNaked.mockReturnValue("upd-id");
    applySessionTurnMutation.mockReset();
    applySessionReadCursorOperation.mockReset();
    checkSessionAccess.mockResolvedValue({ level: "owner" });
    getSessionParticipantUserIds.mockResolvedValue([]);
    sessionFindMany.mockResolvedValue([]);
    sessionFindFirst.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: null,
    });
    accountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
    emitEphemeral.mockReset();
    buildSessionActivityEphemeral.mockClear();
    markSessionInactive.mockReset();
    refreshSessionParticipantBadgePushes.mockClear();
    didSessionActivityBadgeContributionChange.mockReturnValue(false);
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
    txSessionFindFirst.mockResolvedValue(null);
    txSessionFindMany.mockResolvedValue([]);
    txSessionFindUnique.mockResolvedValue({
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        publishedThroughServerSeq: null,
    });
    txSessionMessageFindMany.mockResolvedValue([]);
    txSessionMessageFindFirst.mockResolvedValue(null);
    txAccountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
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
        defaultRequest: { userId: "u1", ...options.defaultRequest },
        registerRoutes(app) {
            sessionRoutes(app as any);
        },
    });
}
