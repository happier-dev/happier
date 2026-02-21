import { vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

export const emitUpdate = vi.fn();
export const buildNewMessageUpdate = vi.fn((_message: any, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-message" },
}));
export const buildNewSessionUpdate = vi.fn((_session: any, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-session" },
}));
export const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, metadata: any, agentState: any) => ({
        id: updateId,
        seq,
        body: { t: "update-session", metadata, agentState },
    }),
);

export const randomKeyNaked = vi.fn(() => "upd-id");
export const createSessionMessage = vi.fn();
export const patchSession = vi.fn();
export const checkSessionAccess = vi.fn(async () => ({ level: "owner" }));
export const requireAccessLevel = vi.fn((access: any, required: any) => {
    const levels = ["view", "edit", "admin", "owner"];
    const userLevel = levels.indexOf(access?.level);
    const requiredLevel = levels.indexOf(required);
    return userLevel >= requiredLevel;
});
export const getSessionParticipantUserIds = vi.fn<(...args: any[]) => Promise<string[]>>(async () => []);

export const sessionFindMany = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);
export const sessionFindFirst = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const sessionFindUnique = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const sessionUpdate = vi.fn<(...args: any[]) => Promise<any>>(async () => {
    throw new Error("sessionUpdate not configured for test");
});
export const sessionMessageFindMany = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);
export const sessionMessageFindFirst = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const sessionMessageFindUnique = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const sessionShareFindMany = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);

export const txSessionFindFirst = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const txSessionFindUnique = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const txSessionCreate = vi.fn<(...args: any[]) => Promise<any>>(async () => {
    throw new Error("txSessionCreate not configured for test");
});
export const txSessionUpdate = vi.fn<(...args: any[]) => Promise<any>>(async () => {
    throw new Error("txSessionUpdate not configured for test");
});
export const txAccountFindUnique = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);

export const catchupFetchesInc = vi.fn();
export const catchupReturnedInc = vi.fn();

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildNewSessionUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    catchupFollowupFetchesCounter: { inc: catchupFetchesInc },
    catchupFollowupReturnedCounter: { inc: catchupReturnedInc },
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({
    randomKeyNaked,
}));

vi.mock("@/app/session/sessionWriteService", () => ({
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

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findMany: sessionFindMany,
            findFirst: sessionFindFirst,
            findUnique: sessionFindUnique,
            update: sessionUpdate,
        },
        sessionShare: { findMany: sessionShareFindMany },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            findFirst: sessionMessageFindFirst,
            findUnique: sessionMessageFindUnique,
        },
    },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
export const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: any) =>
        await fn({
            account: {
                findUnique: txAccountFindUnique,
            },
            session: {
                create: txSessionCreate,
                findFirst: txSessionFindFirst,
                findUnique: txSessionFindUnique,
                update: txSessionUpdate,
            },
        }),
    ),
    afterTx: vi.fn(),
}));

export function resetSessionRouteMocks(): void {
    vi.clearAllMocks();
    randomKeyNaked.mockReturnValue("upd-id");
    checkSessionAccess.mockResolvedValue({ level: "owner" });
    getSessionParticipantUserIds.mockResolvedValue([]);
    sessionFindMany.mockResolvedValue([]);
    sessionFindFirst.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue(null);
    sessionUpdate.mockImplementation(async () => {
        throw new Error("sessionUpdate not configured for test");
    });
    sessionMessageFindMany.mockResolvedValue([]);
    sessionMessageFindFirst.mockResolvedValue(null);
    sessionMessageFindUnique.mockResolvedValue(null);
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
}

export async function registerSessionRoutesAndGetHandler(method: RouteMethod, path: string) {
    const { sessionRoutes } = await import("./sessionRoutes");
    const app = createFakeRouteApp();
    sessionRoutes(app as any);
    return {
        app,
        handler: getRouteHandler(app, method, path),
    };
}

export function createSessionRouteReply() {
    return createReplyStub();
}
