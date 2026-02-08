import { describe, expect, it } from "vitest";

import {
    getFilesBackendFromEnv,
    getSocketAdapterFromEnv,
    isRedisStreamsEnabled,
    resolveDefaultFilesBackend,
    resolveDefaultSocketAdapter,
} from "./backends";

describe("config/backends", () => {
    it("defaults files backend by flavor", () => {
        expect(resolveDefaultFilesBackend("light")).toBe("local");
        expect(resolveDefaultFilesBackend("full")).toBe("s3");
    });

    it("defaults socket adapter to memory", () => {
        expect(resolveDefaultSocketAdapter("light")).toBe("memory");
        expect(resolveDefaultSocketAdapter("full")).toBe("memory");
    });

    it("parses files backend from env", () => {
        expect(getFilesBackendFromEnv({ HAPPIER_FILES_BACKEND: "local" }, "s3")).toBe("local");
        expect(getFilesBackendFromEnv({ HAPPIER_FILES_BACKEND: "S3" }, "local")).toBe("s3");
        expect(getFilesBackendFromEnv({ HAPPIER_FILES_BACKEND: "nope" }, "local")).toBe("local");
    });

    it("parses socket adapter from env", () => {
        expect(getSocketAdapterFromEnv({ HAPPIER_SOCKET_ADAPTER: "memory" }, "redis-streams")).toBe("memory");
        expect(getSocketAdapterFromEnv({ HAPPIER_SOCKET_ADAPTER: "redis" }, "memory")).toBe("redis-streams");
        expect(getSocketAdapterFromEnv({ HAPPIER_SOCKET_ADAPTER: "nope" }, "memory")).toBe("memory");
    });

    it("supports legacy boolean redis adapter flags when adapter is unset", () => {
        expect(getSocketAdapterFromEnv({ HAPPIER_SOCKET_REDIS_ADAPTER: "1" }, "memory")).toBe("redis-streams");
        expect(getSocketAdapterFromEnv({ HAPPY_SOCKET_REDIS_ADAPTER: "true" }, "memory")).toBe("redis-streams");
    });

    it("enables redis streams only when REDIS_URL is present", () => {
        expect(isRedisStreamsEnabled({ REDIS_URL: "" }, "redis-streams")).toBe(false);
        expect(isRedisStreamsEnabled({ REDIS_URL: "redis://localhost:6379" }, "redis-streams")).toBe(true);
        expect(isRedisStreamsEnabled({ REDIS_URL: "redis://localhost:6379" }, "memory")).toBe(false);
    });
});

