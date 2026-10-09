import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "@/app/api/testkit/dbMocks";

describe("readAvailableMachineIrohEndpointAuthority", () => {
    const mocks = createDbMocks({ machine: ["findFirst"] });
    const currentMachine = {
        revokedAt: null,
        replacedByMachineId: null,
        operationProtocolCapabilities: {
            irohMachineEndpoint: { protocolVersions: [1], endpointId: "a".repeat(64) },
            providerBrokerIngress: { protocolVersions: [1] },
        },
        operationProtocolCapabilitiesRevision: 4,
    };

    beforeEach(() => {
        mocks.reset();
        // The database is the boundary; the stored projection and guard stay real.
        installDbModuleMock({ db: mocks.db });
    });

    afterEach(() => {
        vi.doUnmock("@/storage/db");
        vi.resetModules();
    });

    it("retains endpoint and required ingress authority while dropping stored extras", async () => {
        mocks.db.machine.findFirst.mockResolvedValue({
            ...currentMachine,
            operationProtocolCapabilities: {
                irohMachineEndpoint: {
                    ...currentMachine.operationProtocolCapabilities.irohMachineEndpoint,
                    future: true,
                },
                providerBrokerIngress: { protocolVersions: [1], future: true },
                futureCapability: { protocolVersions: [1] },
            },
        });
        const { readAvailableMachineIrohEndpointAuthority } = await import("./machineStateGuards");
        await expect(readAvailableMachineIrohEndpointAuthority({
            accountId: "account-1",
            machineId: "machine-1",
            requiredCapability: "providerBrokerIngress",
        })).resolves.toEqual({ endpointId: "a".repeat(64), revision: 4 });
    });

    it.each([
        { operationProtocolCapabilities: { irohMachineEndpoint: currentMachine.operationProtocolCapabilities.irohMachineEndpoint } },
        { operationProtocolCapabilities: { ...currentMachine.operationProtocolCapabilities, providerBrokerIngress: { protocolVersions: [2] } } },
        { operationProtocolCapabilities: { ...currentMachine.operationProtocolCapabilities, sessionFollow: { contextV1: false } } },
        { operationProtocolCapabilitiesRevision: null },
        { revokedAt: new Date(1) },
        { replacedByMachineId: "machine-2" },
    ])("fails closed for unavailable or malformed stored authority %j", async (override) => {
        mocks.db.machine.findFirst.mockResolvedValue({ ...currentMachine, ...override });
        const { readAvailableMachineIrohEndpointAuthority } = await import("./machineStateGuards");
        await expect(readAvailableMachineIrohEndpointAuthority({
            accountId: "account-1",
            machineId: "machine-1",
            requiredCapability: "providerBrokerIngress",
        })).resolves.toBeNull();
    });
});
