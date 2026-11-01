import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const dbMocks = createDbMocks({
    sessionShareAccessLog: ["create"],
    publicShareAccessLog: ["create"],
} as const);

installDbModuleMock({ db: dbMocks.db });

let logSessionShareAccess: typeof import("./accessLogger").logSessionShareAccess;
let logPublicShareAccess: typeof import("./accessLogger").logPublicShareAccess;
let getUserAgent: typeof import("./accessLogger").getUserAgent;

beforeAll(async () => {
    ({ logSessionShareAccess, logPublicShareAccess, getUserAgent } = await import("./accessLogger"));
});

describe("accessLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.reset();
  });

  describe("logSessionShareAccess", () => {
    it("should log access with IP and user agent", async () => {
      await logSessionShareAccess(
        "share-1",
        "user-1",
        "192.168.1.1",
        "Mozilla/5.0",
      );

      expect(dbMocks.db.sessionShareAccessLog.create).toHaveBeenCalledWith({
        data: {
          sessionShareId: "share-1",
          userId: "user-1",
          ipAddress: "192.168.1.1",
          userAgent: "Mozilla/5.0",
        },
      });
    });

    it("should log access without IP and user agent", async () => {
      await logSessionShareAccess("share-1", "user-1");

      expect(dbMocks.db.sessionShareAccessLog.create).toHaveBeenCalledWith({
        data: {
          sessionShareId: "share-1",
          userId: "user-1",
          ipAddress: null,
          userAgent: null,
        },
      });
    });
  });

  describe("logPublicShareAccess", () => {
    it("should log access with all fields", async () => {
      await logPublicShareAccess(
        "public-1",
        "user-1",
        "192.168.1.1",
        "Mozilla/5.0",
      );

      expect(dbMocks.db.publicShareAccessLog.create).toHaveBeenCalledWith({
        data: {
          publicShareId: "public-1",
          userId: "user-1",
          ipAddress: "192.168.1.1",
          userAgent: "Mozilla/5.0",
        },
      });
    });

    it("should log anonymous access", async () => {
      await logPublicShareAccess("public-1", null);

      expect(dbMocks.db.publicShareAccessLog.create).toHaveBeenCalledWith({
        data: {
          publicShareId: "public-1",
          userId: null,
          ipAddress: null,
          userAgent: null,
        },
      });
    });

    it("should log access with consent (IP and UA present)", async () => {
      await logPublicShareAccess("public-1", null, "10.0.0.1", "Chrome/100.0");

      expect(dbMocks.db.publicShareAccessLog.create).toHaveBeenCalledWith({
        data: {
          publicShareId: "public-1",
          userId: null,
          ipAddress: "10.0.0.1",
          userAgent: "Chrome/100.0",
        },
      });
    });
  });

  describe("getUserAgent", () => {
    it("should extract user agent from header", () => {
      const headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      };
      const result = getUserAgent(headers);
      expect(result).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    });

    it("should handle user agent as array", () => {
      const headers = { "user-agent": ["Mozilla/5.0"] };
      const result = getUserAgent(headers);
      expect(result).toBe("Mozilla/5.0");
    });

    it("should return undefined when no user agent header", () => {
      const headers = {};
      const result = getUserAgent(headers);
      expect(result).toBeUndefined();
    });

    it("should return undefined for empty user agent", () => {
      const headers = { "user-agent": "" };
      const result = getUserAgent(headers);
      expect(result).toBeUndefined();
    });
  });
});
