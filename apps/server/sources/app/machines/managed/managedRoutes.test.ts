import { describe, expect, it } from "vitest";
import { requireManagedControllerProof } from "./managedRoutes";

describe("managed controller execution authority", () => {
    it("rejects a bearer or a proof signed by another controller", () => {
        expect(() => requireManagedControllerProof({ userId: "account" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
        expect(() => requireManagedControllerProof({ userId: "account", externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "other", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "request" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
    });
    it("preserves signed custody independently of the requesting principal", () => {
        for (const userId of ["custodian", "shared-manager"]) {
            expect(requireManagedControllerProof({ userId, externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "controller", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "verified-request", externalActionExecutionCustodianAccountId: "custodian" }, "controller", ["machines.managed.acquire"])).toEqual({ requestId: "verified-request", custodianAccountId: "custodian" });
        }
        expect(() => requireManagedControllerProof({ userId: "requester", externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "controller", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "verified-request" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
    });
});
