import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCOPED_ENV_KEYS = [
    "HAPPIER_HOME_DIR",
    "HAPPIER_SERVER_URL",
    "HAPPIER_PUBLIC_SERVER_URL",
    "HAPPIER_WEBAPP_URL",
    "HAPPIER_AUTH_METHOD",
] as const;

type ScopedEnvKey = (typeof SCOPED_ENV_KEYS)[number];

function captureScopedEnv(): Record<ScopedEnvKey, string | undefined> {
    return Object.fromEntries(
        SCOPED_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<ScopedEnvKey, string | undefined>;
}

function restoreScopedEnv(snapshot: Record<ScopedEnvKey, string | undefined>): void {
    for (const key of SCOPED_ENV_KEYS) {
        const value = snapshot[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

describe("happier auth login --method", () => {
    it("sets HAPPIER_AUTH_METHOD before running auth flow", async () => {
        const home = await mkdtemp(join(tmpdir(), "happier-cli-auth-method-"));
        const envBaseline = captureScopedEnv();

        try {
            process.env.HAPPIER_HOME_DIR = home;
            delete process.env.HAPPIER_SERVER_URL;
            delete process.env.HAPPIER_PUBLIC_SERVER_URL;
            delete process.env.HAPPIER_WEBAPP_URL;

            // Avoid triggering Ink auth UI by ensuring we look authenticated already.
            await writeFile(
                join(home, "access.key"),
                JSON.stringify({ token: "t", secret: Buffer.from(new Uint8Array(32).fill(1)).toString("base64") }),
                "utf8",
            );
            await writeFile(
                join(home, "settings.json"),
                JSON.stringify({ schemaVersion: 4, onboardingCompleted: true, machineId: "m1" }),
                "utf8",
            );

            vi.resetModules();
            const { handleAuthCommand } = await import("./auth");

            await handleAuthCommand(["login", "--method", "web"]);

            expect(process.env.HAPPIER_AUTH_METHOD).toBe("web");
        } finally {
            restoreScopedEnv(envBaseline);
            await rm(home, { recursive: true, force: true });
            vi.unstubAllGlobals();
        }
    });

    it("prints a friendly error and exits when --method is invalid", async () => {
        const envBaseline = captureScopedEnv();
        delete process.env.HAPPIER_AUTH_METHOD;

        vi.resetModules();
        const { handleAuthCommand } = await import("./auth");

        class ExitError extends Error {
            readonly code: number;
            constructor(code: number) {
                super(`process.exit(${code})`);
                this.code = code;
            }
        }

        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
            throw new ExitError(typeof code === "number" ? code : 0);
        }) as typeof process.exit);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        let thrown: unknown = null;
        try {
            try {
                await handleAuthCommand(["login", "--method", "nope"]);
                throw new Error("expected handleAuthCommand to exit");
            } catch (err) {
                thrown = err;
            }

            expect(thrown).toBeInstanceOf(ExitError);
            expect((thrown as ExitError).code).toBe(1);
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(errorSpy.mock.calls[0]?.[0]).toMatch(/Invalid --method/i);
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
            restoreScopedEnv(envBaseline);
        }
    });
});
