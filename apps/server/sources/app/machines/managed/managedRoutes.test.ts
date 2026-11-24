import { describe, expect, it, vi } from "vitest";
import { symbols, type DestinationStream } from "pino";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { logger } from "@/utils/logging/log";
import { registerManagedMachineRoutes, requireManagedControllerProof } from "./managedRoutes";

describe("managed controller execution authority", () => {
    it("rejects a bearer or a proof signed by another controller", () => {
        expect(() => requireManagedControllerProof({ userId: "account" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
        expect(() => requireManagedControllerProof({ userId: "account", externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "other", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "request", externalActionExecutionCustodianAccountId: "account" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
    });
    it("preserves signed custody independently of the requesting principal", () => {
        for (const userId of ["custodian", "shared-manager"]) {
            expect(requireManagedControllerProof({ userId, externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "controller", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "verified-request", externalActionExecutionCustodianAccountId: "custodian" }, "controller", ["machines.managed.acquire"])).toEqual({ requestId: "verified-request", custodianAccountId: "custodian" });
        }
        expect(() => requireManagedControllerProof({ userId: "requester", externalActionExecutionAuthorized: true, externalActionExecutionMachineId: "controller", externalActionEffectActionId: "machines.managed.acquire", externalActionExecutionRequestId: "verified-request" }, "controller", ["machines.managed.acquire"])).toThrow("permission_denied");
    });
});

describe("managed controller route refusals", () => {
    it.each([
        { proof: undefined, authorizationRefusal: "proof_shape" },
        { proof: { machineId: "other-controller", effect: "machines.managed.credentials.install" }, authorizationRefusal: "resolved_target" },
        { proof: { machineId: "report-controller", effect: "machines.managed.acquire" }, authorizationRefusal: "effect_family" },
    ] as const)("names the refusing proof check on the reply and in one log event: $authorizationRefusal", async ({ proof, authorizationRefusal }) => {
        const app = createAuthenticatedTestApp();
        // The signed-request facts the authorization owner admits upstream; the route's own check stays real.
        if (proof) app.addHook("onRequest", async (request: any) => Object.assign(request, { externalActionExecutionAuthorized: true,
            externalActionExecutionMachineId: proof.machineId, externalActionEffectActionId: proof.effect,
            externalActionExecutionRequestId: "report-request", externalActionExecutionCustodianAccountId: "report-account" }));
        registerManagedMachineRoutes(app);
        const records: Array<Record<string, unknown>> = [];
        // Capture only the external logging sink.
        const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
        const sink = vi.spyOn(stream, "write").mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); return true; });
        try {
            const response = await app.inject({ method: "POST", url: "/v1/machines/managed/controller/report?token=private-query-token",
                headers: { "x-test-user-id": "report-account" }, payload: {
                    homeId: "report-home", managedId: "report-managed", expectedIntentRevision: 0, requestId: "report-request",
                    controller: { machineId: "report-controller", installationId: "report-installation" },
                    credentialDelivery: { phase: "submitted", request: { homeId: "report-home", managedId: "report-managed",
                        sessionId: "report-session", bindingKey: "report-binding", expectedResourceRevision: 0,
                        expectedSourceRevision: "report-source", expectedProviderTicket: "report-ticket" } },
                } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ code: "permission_denied", error: "credential_scope_denied", authorizationRefusal });
            const refusals = records.filter(record => record.module === "external-action-authorization-refusal");
            expect(refusals).toEqual([expect.objectContaining({ phase: authorizationRefusal, method: "POST" })]);
            expect(JSON.stringify(refusals)).not.toContain("private-query-token");
        } finally {
            sink.mockRestore();
            await app.close();
        }
    });
});
