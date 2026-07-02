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

export const randomKeyNaked = vi.fn(() => "upd-id");
export const createSessionMessage = vi.fn();
export const patchSession = vi.fn();
export const applySessionTurnMutation = vi.fn();
export const applySessionReadCursorOperation = vi.fn();
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
    session: ["findMany", "findFirst", "findUnique", "update"],
    sessionFolderAssignment: ["findMany"],
    sessionShare: ["findMany"],
    sessionMessage: ["findMany", "findFirst", "findUnique"],
    sessionPendingMessage: ["count"],
    sessionTurn: ["findMany"],
} as const);

const txDbMocks = createDbMocks({
    account: ["findUnique"],
    session: ["create", "findFirst", "findUnique", "update"],
    sessionFolderAssignment: ["deleteMany", "findMany", "updateMany", "upsert"],
    sessionSystemRecord: ["create", "findUnique", "findMany", "findFirst", "update"],
} as const);

export const sessionFindMany = sessionDbMocks.db.session.findMany;
export const sessionFindFirst = sessionDbMocks.db.session.findFirst;
export const sessionFindUnique = sessionDbMocks.db.session.findUnique;
export const accountFindUnique = sessionDbMocks.db.account.findUnique;
export const sessionUpdate = sessionDbMocks.db.session.update;
export const sessionFolderAssignmentFindMany = sessionDbMocks.db.sessionFolderAssignment.findMany;
export const sessionMessageFindMany = sessionDbMocks.db.sessionMessage.findMany;
export const sessionMessageFindFirst = sessionDbMocks.db.sessionMessage.findFirst;
export const sessionMessageFindUnique = sessionDbMocks.db.sessionMessage.findUnique;
export const sessionPendingMessageCount = sessionDbMocks.db.sessionPendingMessage.count;
export const sessionTurnFindMany = sessionDbMocks.db.sessionTurn.findMany;
export const sessionShareFindMany = sessionDbMocks.db.sessionShare.findMany;

export const txSessionFindFirst = txDbMocks.db.session.findFirst;
export const txSessionFindUnique = txDbMocks.db.session.findUnique;
export const txSessionCreate = txDbMocks.db.session.create;
export const txSessionUpdate = txDbMocks.db.session.update;
export const txSessionFolderAssignmentDeleteMany = txDbMocks.db.sessionFolderAssignment.deleteMany;
export const txSessionFolderAssignmentFindMany = txDbMocks.db.sessionFolderAssignment.findMany;
export const txSessionFolderAssignmentUpdateMany = txDbMocks.db.sessionFolderAssignment.updateMany;
export const txSessionFolderAssignmentUpsert = txDbMocks.db.sessionFolderAssignment.upsert;
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
    createSessionMessage,
    patchSession,
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
    sessionFindUnique.mockResolvedValue(null);
    accountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
    emitEphemeral.mockReset();
    buildSessionActivityEphemeral.mockClear();
    markSessionInactive.mockReset();
    refreshSessionParticipantBadgePushes.mockClear();
    didSessionActivityBadgeContributionChange.mockReturnValue(false);
    sessionUpdate.mockImplementation(async () => {
        throw new Error("sessionUpdate not configured for test");
    });
    sessionFolderAssignmentFindMany.mockResolvedValue([]);
    sessionMessageFindMany.mockResolvedValue([]);
    sessionMessageFindFirst.mockResolvedValue(null);
    sessionMessageFindUnique.mockResolvedValue(null);
    sessionPendingMessageCount.mockResolvedValue(0);
    sessionTurnFindMany.mockResolvedValue([]);
    sessionShareFindMany.mockResolvedValue([]);
    txSessionFindFirst.mockResolvedValue(null);
    txSessionFindUnique.mockResolvedValue(null);
    txAccountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
    txSessionCreate.mockImplementation(async () => {
        throw new Error("txSessionCreate not configured for test");
    });
    txSessionUpdate.mockImplementation(async () => {
        throw new Error("txSessionUpdate not configured for test");
    });
    txSessionFolderAssignmentDeleteMany.mockResolvedValue({ count: 0 });
    txSessionFolderAssignmentFindMany.mockResolvedValue([]);
    txSessionFolderAssignmentUpdateMany.mockResolvedValue({ count: 0 });
    txSessionFolderAssignmentUpsert.mockImplementation(async () => {
        throw new Error("txSessionFolderAssignmentUpsert not configured for test");
    });
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
