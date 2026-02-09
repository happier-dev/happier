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

export const sessionFindMany = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);
export const sessionFindFirst = vi.fn<(...args: any[]) => Promise<any | null>>(async () => null);
export const sessionMessageFindMany = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);

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
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findMany: sessionFindMany,
            findFirst: sessionFindFirst,
        },
        sessionShare: { findMany: vi.fn(async () => []) },
        sessionMessage: {
            findMany: sessionMessageFindMany,
        },
    },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: vi.fn(async () => true) }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/share/types", () => ({ PROFILE_SELECT: {}, toShareUserProfile: vi.fn() }));
vi.mock("@/storage/inTx", () => ({ inTx: vi.fn(async (fn: any) => await fn({})), afterTx: vi.fn() }));

export function resetSessionRouteMocks(): void {
    vi.clearAllMocks();
    randomKeyNaked.mockReturnValue("upd-id");
    checkSessionAccess.mockResolvedValue({ level: "owner" });
    sessionFindMany.mockResolvedValue([]);
    sessionFindFirst.mockResolvedValue(null);
    sessionMessageFindMany.mockResolvedValue([]);
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
