import { vi } from "vitest";

import {
    snapshotStartServerEnv,
    type EnvValues,
} from "./startServerMocks";
import { createEnvReset } from "./env";

export type StartServerFlavor = "full" | "light";

export function createStartServerHarness(resetValues: EnvValues = {}) {
    const envBackup = snapshotStartServerEnv();
    const resetEnv = createEnvReset(envBackup);

    const restore = () => {
        resetEnv();
    };

    const reset = (values: EnvValues = {}) => {
        vi.clearAllMocks();
        resetEnv({ ...resetValues, ...values });
    };

    const prepareImport = (values: EnvValues = {}) => {
        reset(values);
        vi.resetModules();
    };

    const importStartServerModule = async (values: EnvValues = {}) => {
        prepareImport(values);
        return await import("@/startServer");
    };

    const start = async (flavor: StartServerFlavor, values: EnvValues = {}) => {
        const module = await importStartServerModule(values);
        await module.startServer(flavor);
        return module;
    };

    return {
        restore,
        reset,
        prepareImport,
        importStartServerModule,
        start,
    };
}
