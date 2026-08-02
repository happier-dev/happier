import { beforeEach, describe, it, expect, vi } from "vitest";
import { RPC_ERROR_CODES, RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { createEnvReset } from "../testkit/env";

const dbMockFns = vi.hoisted(() => ({
  machineFindFirst: vi.fn(),
  sessionFindUnique: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
  db: {
    machine: {
      findFirst: dbMockFns.machineFindFirst,
    },
    session: {
      findUnique: dbMockFns.sessionFindUnique,
    },
  },
}));

describe("rpcHandler", () => {
  const resetRpcAvailabilityEnv = createEnvReset();
  const setRpcAvailabilityEnv = () => {
    resetRpcAvailabilityEnv({
      HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: "100",
      HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: "10",
    });
  };

  beforeEach(() => {
    dbMockFns.machineFindFirst.mockReset().mockResolvedValue(null);
    dbMockFns.sessionFindUnique.mockReset().mockResolvedValue(null);
  });

  it.each([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    `machine-1:${RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW}`,
  ])("revalidates daemon compatibility before registering provider-starting RPC %s", async (method) => {
    resetRpcAvailabilityEnv({
      HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
        daemon: "0.2.11",
        "session-runner": "0.2.11",
      }),
    });
    dbMockFns.machineFindFirst.mockResolvedValue({
      id: "machine-1",
      revokedAt: null,
      replacedByMachineId: null,
    });
    const { rpcHandler } = await import("./rpcHandler");
    const socket = createFakeSocket({
      data: {
        clientType: "machine-scoped",
        machineId: "machine-1",
        sessionSyncCompatibility: {
          parseResult: {
            status: "valid",
            declaration: {
              v: 1,
              clientKind: "daemon",
              appVersion: "0.2.10",
              sessionSyncProtocolVersion: 2,
            },
          },
        },
      },
    });
    const userRpcListeners = new Map<string, any>();
    rpcHandler("user-1", socket as any, userRpcListeners, new Map(), {
      io: {} as any,
      redisRegistry: { enabled: false },
    });

    await getSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER)({ method });

    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      type: "register",
      error: "client-upgrade-required",
    }));
    expect(userRpcListeners.has(method)).toBe(false);
    resetRpcAvailabilityEnv();
  });

  it("keeps non-provider-starting machine RPC registration available across a required floor", async () => {
    vi.resetModules();
    resetRpcAvailabilityEnv({
      HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
        daemon: "0.2.11",
        "session-runner": "0.2.11",
      }),
    });
    dbMockFns.machineFindFirst.mockResolvedValue({
      id: "machine-1",
      revokedAt: null,
      replacedByMachineId: null,
    });

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const socket = createFakeSocket({
        data: {
          clientType: "machine-scoped",
          machineId: "machine-1",
        },
      });
      const userRpcListeners = new Map<string, any>();
      rpcHandler("user-1", socket as any, userRpcListeners, new Map(), {
        io: {} as any,
        redisRegistry: { enabled: false },
      });

      await getSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER)({ method: "machine-1:capabilities.invoke" });

      expect(userRpcListeners.get("machine-1:capabilities.invoke")).toBe(socket);
      expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, {
        method: "machine-1:capabilities.invoke",
      });
      expect(socket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.anything());
    } finally {
      resetRpcAvailabilityEnv();
    }
  });

  it.each([
    {
      method: `machine-1:${RPC_METHODS.SPAWN_HAPPY_SESSION}`,
      callParams: { directory: "/workspace" },
    },
    {
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW}`,
      callParams: { sessionId: "session-1", operation: "consume_reset_credit" },
    },
  ])("revalidates daemon compatibility immediately before forwarding provider-starting RPC $method", async ({ method, callParams }) => {
    vi.resetModules();
    resetRpcAvailabilityEnv({
      HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
        daemon: "0.2.10",
        "session-runner": "0.2.10",
      }),
    });
    dbMockFns.machineFindFirst.mockResolvedValue({
      id: "machine-1",
      revokedAt: null,
      replacedByMachineId: null,
    });

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const targetEmitWithAck = vi.fn().mockResolvedValue({ type: "success", sessionId: "session-1" });
      const targetTimeout = vi.fn(() => ({ emitWithAck: targetEmitWithAck }));
      const targetSocket = createFakeSocket({
        id: "daemon-socket",
        timeout: targetTimeout as any,
        data: {
          clientType: "machine-scoped",
          machineId: "machine-1",
          sessionSyncCompatibility: {
            parseResult: {
              status: "valid",
              declaration: {
                v: 1,
                clientKind: "daemon",
                appVersion: "0.2.10",
                sessionSyncProtocolVersion: 2,
              },
            },
          },
        },
      });
      const targetListeners = new Map<string, any>();
      const allRpcListeners = new Map<string, any>();
      rpcHandler("user-1", targetSocket as any, targetListeners, allRpcListeners, {
        io: {} as any,
        redisRegistry: { enabled: false },
      });
      await getSocketHandler(targetSocket, SOCKET_RPC_EVENTS.REGISTER)({ method });

      const callerSocket = createFakeSocket({ id: "caller-socket" });
      rpcHandler("user-1", callerSocket as any, new Map(), allRpcListeners, {
        io: {} as any,
        redisRegistry: { enabled: false },
      });
      const call = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);

      const compatibleCallback = vi.fn();
      await call({ method, params: callParams }, compatibleCallback);
      expect(compatibleCallback).toHaveBeenCalledWith({
        ok: true,
        result: { type: "success", sessionId: "session-1" },
      });
      expect(targetEmitWithAck).toHaveBeenCalledTimes(1);

      targetEmitWithAck.mockClear();
      targetTimeout.mockClear();
      resetRpcAvailabilityEnv({
        HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
        HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
        HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
          daemon: "0.2.11",
          "session-runner": "0.2.11",
        }),
      });

      const incompatibleCallback = vi.fn();
      await call({ method, params: callParams }, incompatibleCallback);

      expect(targetTimeout).not.toHaveBeenCalled();
      expect(targetEmitWithAck).not.toHaveBeenCalled();
      expect(incompatibleCallback).toHaveBeenCalledWith({
        ok: false,
        error: "client-upgrade-required",
        requirement: expect.objectContaining({
          v: 1,
          clientKind: "daemon",
          minimumAppVersion: "0.2.11",
          minimumSessionSyncProtocolVersion: 2,
        }),
      });
    } finally {
      resetRpcAvailabilityEnv();
    }
  });

  it("revalidates a remote daemon before Redis forwards privileged spawn RPC", async () => {
    vi.resetModules();
    resetRpcAvailabilityEnv({
      HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
        daemon: "0.2.11",
        "session-runner": "0.2.11",
      }),
    });
    dbMockFns.machineFindFirst.mockResolvedValue({
      id: "machine-1",
      revokedAt: null,
      replacedByMachineId: null,
    });
    const hmget = vi.fn().mockResolvedValue(["daemon-socket"]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));
    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const method = "machine-1:spawn-happy-session";
      const remoteTarget = createFakeSocket({
        id: "daemon-socket",
        data: {
          clientType: "machine-scoped",
          machineId: "machine-1",
          sessionSyncCompatibility: {
            parseResult: {
              status: "valid",
              declaration: {
                v: 1,
                clientKind: "daemon",
                appVersion: "0.2.10",
                sessionSyncProtocolVersion: 2,
              },
            },
          },
        },
      });
      const fetchSockets = vi.fn().mockResolvedValue([remoteTarget]);
      const inRoom = vi.fn(() => ({ fetchSockets }));
      const emitWithAck = vi.fn().mockResolvedValue([{ type: "success", sessionId: "session-1" }]);
      const to = vi.fn(() => ({ emitWithAck }));
      const ioTimeout = vi.fn(() => ({ to }));
      const callerSocket = createFakeSocket({ id: "caller-socket" });
      rpcHandler("user-1", callerSocket as any, new Map(), new Map(), {
        io: { in: inRoom, timeout: ioTimeout } as any,
        redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
      });

      const callback = vi.fn();
      await getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL)(
        { method, params: { directory: "/workspace" } },
        callback,
      );

      expect(inRoom).toHaveBeenCalledWith("daemon-socket");
      expect(fetchSockets).toHaveBeenCalledTimes(1);
      expect(ioTimeout).not.toHaveBeenCalled();
      expect(emitWithAck).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        ok: false,
        error: "client-upgrade-required",
        requirement: expect.objectContaining({
          v: 1,
          clientKind: "daemon",
          minimumAppVersion: "0.2.11",
          minimumSessionSyncProtocolVersion: 2,
        }),
      });
    } finally {
      vi.doUnmock("@/storage/redis/redis");
      resetRpcAvailabilityEnv();
    }
  });

  it("revalidates an in-memory daemon before the Redis fallback forwards privileged spawn RPC", async () => {
    vi.resetModules();
    resetRpcAvailabilityEnv({
      HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: "required",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: "2",
      HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
        daemon: "0.2.11",
        "session-runner": "0.2.11",
      }),
    });
    dbMockFns.machineFindFirst.mockResolvedValue({
      id: "machine-1",
      revokedAt: null,
      replacedByMachineId: null,
    });
    const hmget = vi.fn().mockResolvedValue([null]);
    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget }),
    }));

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const method = "machine-1:spawn-happy-session";
      const emitWithAck = vi.fn().mockResolvedValue({ type: "success", sessionId: "session-1" });
      const targetTimeout = vi.fn(() => ({ emitWithAck }));
      const targetSocket = createFakeSocket({
        id: "daemon-socket",
        timeout: targetTimeout as any,
        data: {
          clientType: "machine-scoped",
          machineId: "machine-1",
          sessionSyncCompatibility: {
            parseResult: {
              status: "valid",
              declaration: {
                v: 1,
                clientKind: "daemon",
                appVersion: "0.2.10",
                sessionSyncProtocolVersion: 2,
              },
            },
          },
        },
      });
      const allRpcListeners = new Map([
        ["user-1", new Map([[method, targetSocket]])],
      ]);
      const callerSocket = createFakeSocket({ id: "caller-socket" });
      rpcHandler("user-1", callerSocket as any, new Map(), allRpcListeners as any, {
        io: {} as any,
        redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
      });

      const callback = vi.fn();
      await getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL)(
        { method, params: { directory: "/workspace" } },
        callback,
      );

      expect(hmget).toHaveBeenCalled();
      expect(targetTimeout).not.toHaveBeenCalled();
      expect(emitWithAck).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        ok: false,
        error: "client-upgrade-required",
        requirement: expect.objectContaining({
          v: 1,
          clientKind: "daemon",
          minimumAppVersion: "0.2.11",
          minimumSessionSyncProtocolVersion: 2,
        }),
      });
    } finally {
      vi.doUnmock("@/storage/redis/redis");
      resetRpcAvailabilityEnv();
    }
  });

  it("waits for the owner listener map during delegated permission RPC grace fallback", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    setRpcAvailabilityEnv();

    dbMockFns.sessionFindUnique.mockResolvedValue({ accountId: "owner-1" });
    vi.doMock("@/app/share/accessControl", () => ({
      canApprovePermissions: vi.fn().mockResolvedValue(true),
    }));

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const method = "sess_1:permission";
      const callerRpcListeners = new Map<string, any>();
      const ownerRpcListeners = new Map<string, any>();
      const allRpcListeners = new Map<string, any>([
        ["user-1", callerRpcListeners],
        ["owner-1", ownerRpcListeners],
      ]);

      const callerEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: "caller" });
      const callerTimeout = vi.fn(() => ({ emitWithAck: callerEmitWithAck }));
      const callerOwnedSocket = createFakeSocket({ connected: true, timeout: callerTimeout as any, id: "caller-owned" });
      callerRpcListeners.set(method, callerOwnedSocket as any);

      const ownerEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: "owner" });
      const ownerTimeout = vi.fn(() => ({ emitWithAck: ownerEmitWithAck }));
      const ownerSocket = createFakeSocket({ connected: true, timeout: ownerTimeout as any, id: "owner-late" });

      const callerSocket = createFakeSocket({ emit: vi.fn(), id: "caller-socket" });
      rpcHandler("user-1", callerSocket as any, callerRpcListeners as any, allRpcListeners as any, {
        io: {} as any,
        redisRegistry: { enabled: false },
      } as any);

      setTimeout(() => {
        ownerRpcListeners.set(method, ownerSocket as any);
      }, 20);

      const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
      const callback = vi.fn();
      const pending = handler({ method, params: { requestId: "perm-1" } }, callback);

      await vi.advanceTimersByTimeAsync(30);
      await pending;

      expect(callerEmitWithAck).not.toHaveBeenCalled();
      expect(ownerTimeout).toHaveBeenCalledWith(30000);
      expect(ownerEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
        method,
        params: { requestId: "perm-1" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          result: { ok: true, value: "owner" },
        }),
      );
    } finally {
      vi.doUnmock("@/app/share/accessControl");
      resetRpcAvailabilityEnv();
      vi.useRealTimers();
    }
  });

  it("waits briefly for late session RPC registration before returning method unavailable", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    setRpcAvailabilityEnv();

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const userRpcListeners = new Map<string, any>();
      const allRpcListeners = new Map<string, any>();

      const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 123 });
      const targetTimeout = vi.fn(() => ({ emitWithAck: targetEmitWithAck }));
      const targetSocket = createFakeSocket({ connected: true, timeout: targetTimeout as any, id: "target-late" });

      const callerSocket = createFakeSocket({ emit: vi.fn() });
      rpcHandler("user-1", callerSocket as any, userRpcListeners as any, allRpcListeners as any, {
        io: {} as any,
        redisRegistry: { enabled: false },
      } as any);

      setTimeout(() => {
        userRpcListeners.set("sess_1:execution.run.stream.start", targetSocket as any);
      }, 20);

      const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
      const callback = vi.fn();
      const pending = handler({ method: "sess_1:execution.run.stream.start", params: { runId: "run-1" } }, callback);

      await vi.advanceTimersByTimeAsync(30);
      await pending;

      expect(targetTimeout).toHaveBeenCalledWith(30000);
      expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
        method: "sess_1:execution.run.stream.start",
        params: { runId: "run-1" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          result: { ok: true, value: 123 },
        }),
      );
    } finally {
      resetRpcAvailabilityEnv();
      vi.useRealTimers();
    }
  });

  it("retries redis lookup briefly for late session RPC registration before returning method unavailable", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    setRpcAvailabilityEnv();

    try {
      const targetSocketId = "target-socket";
      const hmget = vi
        .fn()
        .mockResolvedValueOnce([null])
        .mockResolvedValueOnce([null])
        .mockResolvedValueOnce([targetSocketId]);
      const evalFn = vi.fn();
      const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

      vi.doMock("@/storage/redis/redis", () => ({
        getRedisClient: () => ({ hmget, eval: evalFn, multi }),
      }));

      const { rpcHandler } = await import("./rpcHandler");
      const userRpcListeners = new Map<string, any>();
      const allRpcListeners = new Map<string, any>();

      const emitWithAck = vi.fn().mockResolvedValue([{ ok: true, value: 456 }]);
      const to = vi.fn(() => ({ emitWithAck }));
      const timeout = vi.fn(() => ({ to }));
      const io = { timeout } as any;
      const callerSocket = createFakeSocket({ emit: vi.fn(), timeout: timeout as any });

      rpcHandler("user-1", callerSocket as any, userRpcListeners as any, allRpcListeners as any, {
        io,
        redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
      } as any);

      const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
      const callback = vi.fn();
      const pending = handler({ method: "sess_1:execution.run.stream.start", params: { runId: "run-1" } }, callback);

      await vi.advanceTimersByTimeAsync(30);
      await pending;

      expect(timeout).toHaveBeenCalledWith(30000);
      expect(to).toHaveBeenCalledWith(targetSocketId);
      expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
        method: "sess_1:execution.run.stream.start",
        params: { runId: "run-1" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          result: { ok: true, value: 456 },
        }),
      );
    } finally {
      resetRpcAvailabilityEnv();
      vi.useRealTimers();
    }
  });

  it("does not fall back to the caller listener map for delegated permission RPCs when redis is missing a mapping", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    setRpcAvailabilityEnv();

    const hmget = vi.fn().mockResolvedValue([null]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));
    dbMockFns.sessionFindUnique.mockResolvedValue({ accountId: "owner-1" });
    vi.doMock("@/app/share/accessControl", () => ({
      canApprovePermissions: vi.fn().mockResolvedValue(true),
    }));

    try {
      const { rpcHandler } = await import("./rpcHandler");
      const method = "sess_1:permission";
      const callerRpcListeners = new Map<string, any>();
      const ownerRpcListeners = new Map<string, any>();
      const allRpcListeners = new Map<string, any>([
        ["user-1", callerRpcListeners],
        ["owner-1", ownerRpcListeners],
      ]);

      const callerEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: "caller" });
      const callerTimeout = vi.fn(() => ({ emitWithAck: callerEmitWithAck }));
      const callerOwnedSocket = createFakeSocket({ connected: true, timeout: callerTimeout as any, id: "caller-owned" });
      callerRpcListeners.set(method, callerOwnedSocket as any);

      const ownerEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: "owner" });
      const ownerTimeout = vi.fn(() => ({ emitWithAck: ownerEmitWithAck }));
      const ownerSocket = createFakeSocket({ connected: true, timeout: ownerTimeout as any, id: "owner-late" });
      ownerRpcListeners.set(method, ownerSocket as any);

      const emitWithAck = vi.fn().mockResolvedValue([]);
      const to = vi.fn(() => ({ emitWithAck }));
      const timeout = vi.fn(() => ({ to }));
      const io = { timeout } as any;
      const callerSocket = createFakeSocket({ emit: vi.fn(), timeout: timeout as any, id: "caller-socket" });

      rpcHandler("user-1", callerSocket as any, callerRpcListeners as any, allRpcListeners as any, {
        io,
        redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
      } as any);

      const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
      const callback = vi.fn();
      await handler({ method, params: { requestId: "perm-1" } }, callback);

      expect(callerEmitWithAck).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(ownerTimeout).toHaveBeenCalledWith(30000);
      expect(ownerEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
        method,
        params: { requestId: "perm-1" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          result: { ok: true, value: "owner" },
        }),
      );
    } finally {
      vi.doUnmock("@/storage/redis/redis");
      vi.doUnmock("@/app/share/accessControl");
      resetRpcAvailabilityEnv();
      vi.useRealTimers();
    }
  });

  it("returns an explicit errorCode when the RPC method is not available", async () => {
    vi.resetModules();
    const { rpcHandler } = await import("./rpcHandler");
    const socket = createFakeSocket();
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    rpcHandler("user-1", socket as any, userRpcListeners as any, allRpcListeners as any, {
      io: {} as any,
      redisRegistry: { enabled: false },
    });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL);

    const callback = vi.fn();
    await handler({ method: "missing-method", params: {} }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "RPC method not available",
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
  });

  it("records no explicit-stop intent when a session stop RPC has no reachable runner", async () => {
    vi.resetModules();
    const { rpcHandler } = await import("./rpcHandler");
    const socket = createFakeSocket();
    const markExplicitStopRequested = vi.fn();

    rpcHandler("user-1", socket as any, new Map<string, any>() as any, new Map<string, any>() as any, {
      io: {} as any,
      redisRegistry: { enabled: false },
      sessionPublisherPresence: {
        captureExplicitMachineStop: vi.fn(),
        finalizeExplicitMachineStop: vi.fn(),
        markExplicitStopRequested,
      } as any,
    });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL);
    const callback = vi.fn();
    await handler({ method: `sess_1:${RPC_METHODS.KILL_SESSION}`, params: {} }, callback);

    // The stop never reached a runner, so nothing may later read a disconnect as an
    // intentional termination — that would end a session whose runner is still alive.
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }),
    );
    expect(markExplicitStopRequested).not.toHaveBeenCalled();
  });

  it("uses Redis RPC registry + io.emitWithAck when enabled", async () => {
    vi.resetModules();
    const targetSocketId = "target-socket";
    const hmget = vi.fn().mockResolvedValue([targetSocketId]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    const { rpcHandler } = await import("./rpcHandler");
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const emitWithAck = vi.fn().mockResolvedValue([{ ok: true, value: 123 }]);
    const to = vi.fn(() => ({ emitWithAck }));
    const timeout = vi.fn(() => ({ to }));
    const io = { timeout } as any;
    const socket = createFakeSocket({ emit: vi.fn(), timeout: timeout as any });

    rpcHandler("user-1", socket as any, userRpcListeners as any, allRpcListeners as any, {
      io,
      redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL);

    const callback = vi.fn();
    await handler({ method: "some-method", params: { a: 1 } }, callback);

    expect(timeout).toHaveBeenCalledWith(30000);
    expect(to).toHaveBeenCalledWith(targetSocketId);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
      method: "some-method",
      params: { a: 1 },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: { ok: true, value: 123 },
      }),
    );
  });

  it("falls back to in-memory rpc listener when Redis has no mapping (redis enabled)", async () => {
    vi.resetModules();
    const hmget = vi.fn().mockResolvedValue([null]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    const { rpcHandler } = await import("./rpcHandler");
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 123 });
    const targetTimeout = vi.fn(() => ({ emitWithAck: targetEmitWithAck }));
    const targetSocket = createFakeSocket({ connected: true, timeout: targetTimeout as any, id: "target-local" });
    userRpcListeners.set("some-method", targetSocket as any);

    const callerSocket = createFakeSocket({ emit: vi.fn() });
    rpcHandler("user-1", callerSocket as any, userRpcListeners as any, allRpcListeners as any, {
      io: {} as any,
      redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
    } as any);

    const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
    const callback = vi.fn();
    await handler({ method: "some-method", params: { a: 1 } }, callback);

    expect(hmget).toHaveBeenCalled();
    expect(targetTimeout).toHaveBeenCalledWith(30000);
    expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
      method: "some-method",
      params: { a: 1 },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: { ok: true, value: 123 },
      }),
    );
  });

  it("treats an empty io.emitWithAck response as method not available and cleans up stale Redis mapping", async () => {
    vi.resetModules();
    const targetSocketId = "target-socket";
    const hmget = vi.fn().mockResolvedValue([targetSocketId]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    const { rpcHandler } = await import("./rpcHandler");
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const emitWithAck = vi.fn().mockResolvedValue([]);
    const to = vi.fn(() => ({ emitWithAck }));
    const timeout = vi.fn(() => ({ to }));
    const io = { timeout } as any;
    const socket = createFakeSocket({ emit: vi.fn(), timeout: timeout as any });

    rpcHandler("user-1", socket as any, userRpcListeners as any, allRpcListeners as any, {
      io,
      redisRegistry: { enabled: true, instanceId: "instance-1", ttlSeconds: 120 },
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL);

    const callback = vi.fn();
    await handler({ method: "some-method", params: { a: 1 } }, callback);

    expect(timeout).toHaveBeenCalledWith(30000);
    expect(to).toHaveBeenCalledWith(targetSocketId);
    expect(emitWithAck).toHaveBeenCalled();

    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, "rpc:user-1:some-method", targetSocketId);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "RPC method not available",
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
  });

  it("uses a longer forward timeout for capabilities RPC calls", async () => {
    vi.resetModules();
    const { rpcHandler } = await import("./rpcHandler");
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, result: "{}" });
    const targetTimeout = vi.fn(() => ({ emitWithAck: targetEmitWithAck }));
    const targetSocket = createFakeSocket({ connected: true, timeout: targetTimeout });
    userRpcListeners.set("machine-1:capabilities.invoke", targetSocket as any);

    const callerSocket = createFakeSocket({ emit: vi.fn() });
    rpcHandler("user-1", callerSocket as any, userRpcListeners as any, allRpcListeners as any, {
      io: {} as any,
      redisRegistry: { enabled: false },
    });

    const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
    const callback = vi.fn();
    await handler({ method: "machine-1:capabilities.invoke", params: { id: "cli.gemini", method: "probeModels" } }, callback);

    expect(targetTimeout).toHaveBeenCalledWith(120000);
    expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
      method: "machine-1:capabilities.invoke",
      params: { id: "cli.gemini", method: "probeModels" },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
      }),
    );
  });

  it("honors a caller-requested forward timeout when it exceeds the default", async () => {
    vi.resetModules();
    const { rpcHandler } = await import("./rpcHandler");
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 123 });
    const targetTimeout = vi.fn(() => ({ emitWithAck: targetEmitWithAck }));
    const targetSocket = createFakeSocket({ connected: true, timeout: targetTimeout });
    userRpcListeners.set("machine-1:daemon.sessionHandoff.prepareTarget", targetSocket as any);

    const callerSocket = createFakeSocket({ emit: vi.fn() });
    rpcHandler("user-1", callerSocket as any, userRpcListeners as any, allRpcListeners as any, {
      io: {} as any,
      redisRegistry: { enabled: false },
    });

    const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
    const callback = vi.fn();
    await handler(
      {
        method: "machine-1:daemon.sessionHandoff.prepareTarget",
        params: { handoffId: "handoff-1" },
        timeoutMs: 90000,
      },
      callback,
    );

    expect(targetTimeout).toHaveBeenCalledWith(90000);
    expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
      method: "machine-1:daemon.sessionHandoff.prepareTarget",
      params: { handoffId: "handoff-1" },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: { ok: true, value: 123 },
      }),
    );
  });
});
