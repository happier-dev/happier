import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mkdir = vi.fn(async () => undefined);
const applyLightDefaultEnv = vi.fn((env: NodeJS.ProcessEnv) => {
    env.HAPPY_SERVER_LIGHT_DATA_DIR ??= "/tmp/happier-light-data";
    env.HAPPY_SERVER_LIGHT_FILES_DIR ??= "/tmp/happier-light-files";
    env.HAPPY_SERVER_LIGHT_DB_DIR ??= "/tmp/happier-light-db";
});
const buildLightDevPlan = vi.fn(() => ({
    migrateDeployArgs: ["-s", "migrate:light:deploy"],
    startLightArgs: ["-s", "start:light"],
}));
const spawn = vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
        child.emit("exit", 0);
    });
    return child as any;
});

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs/promises", () => ({ mkdir }));
vi.mock("@/flavors/light/env", () => ({ applyLightDefaultEnv }));
vi.mock("./dev.lightPlan", () => ({ buildLightDevPlan }));

describe("runLightDev", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates the light data dirs, deploys migrations, and starts the light server", async () => {
        const { runLightDev } = await import("./dev.light");

        await runLightDev({});

        expect(applyLightDefaultEnv).toHaveBeenCalledTimes(1);
        expect(buildLightDevPlan).toHaveBeenCalledTimes(1);
        expect(mkdir).toHaveBeenCalledWith("/tmp/happier-light-data", { recursive: true });
        expect(mkdir).toHaveBeenCalledWith("/tmp/happier-light-files", { recursive: true });
        expect(mkdir).toHaveBeenCalledWith("/tmp/happier-light-db", { recursive: true });
        expect(spawn).toHaveBeenNthCalledWith(
            1,
            "yarn",
            ["-s", "migrate:light:deploy"],
            expect.objectContaining({
                shell: false,
                stdio: "inherit",
            }),
        );
        expect(spawn).toHaveBeenNthCalledWith(
            2,
            "yarn",
            ["-s", "start:light"],
            expect.objectContaining({
                shell: false,
                stdio: "inherit",
            }),
        );
    });
});
