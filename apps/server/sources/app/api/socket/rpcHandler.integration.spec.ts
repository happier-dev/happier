import { describe, it, expect, vi } from "vitest";
import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

describe("rpcHandler", () => {
  it("waits for the owner listener map during delegated permission RPC grace fallback", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const previousGrace = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
    const previousPoll = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = "100";
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = "10";

    vi.doMock("@/storage/db", () => ({
      db: {
        session: {
          findUnique: vi.fn().mockResolvedValue({ accountId: "owner-1" }),
        },
      },
    }));
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
      vi.doUnmock("@/storage/db");
      vi.doUnmock("@/app/share/accessControl");
      if (previousGrace === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = previousGrace;
      if (previousPoll === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = previousPoll;
      vi.useRealTimers();
    }
  });

  it("waits briefly for late session RPC registration before returning method unavailable", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const previousGrace = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
    const previousPoll = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = "100";
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = "10";

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
      if (previousGrace === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = previousGrace;
      if (previousPoll === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = previousPoll;
      vi.useRealTimers();
    }
  });

  it("retries redis lookup briefly for late session RPC registration before returning method unavailable", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const previousGrace = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
    const previousPoll = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = "100";
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = "10";

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
      if (previousGrace === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = previousGrace;
      if (previousPoll === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = previousPoll;
      vi.useRealTimers();
    }
  });

  it("does not fall back to the caller listener map for delegated permission RPCs when redis is missing a mapping", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const previousGrace = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
    const previousPoll = process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = "100";
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = "10";

    const hmget = vi.fn().mockResolvedValue([null]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock("@/storage/redis/redis", () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));
    vi.doMock("@/storage/db", () => ({
      db: {
        session: {
          findUnique: vi.fn().mockResolvedValue({ accountId: "owner-1" }),
        },
      },
    }));
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
      vi.doUnmock("@/storage/db");
      vi.doUnmock("@/app/share/accessControl");
      if (previousGrace === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS = previousGrace;
      if (previousPoll === undefined) delete process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS;
      else process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS = previousPoll;
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
