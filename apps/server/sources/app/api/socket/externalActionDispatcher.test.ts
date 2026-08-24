import { describe, expect, it, vi } from "vitest";

import {
    createExternalActionResultTooLargeExecutionV1,
    type ExternalActionRequestEnvelopeV1,
} from "@happier-dev/protocol/actions";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    createExternalActionDaemonDispatcher,
    type ExternalActionForwardRpcCall,
} from "./externalActionDispatcher";

const principal = {
    accountId: "account-1",
    principalId: "principal-1",
    credentialId: "credential-1",
    authority: "account_automation" as const,
};

function response(actionId: string, envelope: ExternalActionRequestEnvelopeV1) {
    return {
        v: 1 as const,
        actionId,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        execution: { ok: true as const, result: { accepted: true } },
  };
}

function relayResponse(actionId: string, envelope: ExternalActionRequestEnvelopeV1) {
    return {
        kind: "response" as const,
        response: response(actionId, envelope),
    };
}

describe("createExternalActionDaemonDispatcher", () => {
    it("forwards the opaque envelope with server-stamped provenance and exact machine placement", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            requestId: "request-1",
            target: { kind: "machine", machineId: "machine-1" },
            input: {
                directory: "/workspace",
                callerSuppliedAuthority: "present_user",
            },
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: relayResponse("session.spawn_new", envelope),
        }));
        const resolveMachine = vi.fn(async () => "available" as const);
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.spawn_new",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "response",
            response: response("session.spawn_new", envelope),
        });

        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            targetUserId: "account-1",
            method: `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
            callParams: {
                actionId: "session.spawn_new",
                envelope,
                principal,
                placement: {
                    machineId: "machine-1",
                    target: { kind: "machine", machineId: "machine-1" },
                },
            },
        }));
        expect(resolveMachine).toHaveBeenCalledWith({
            accountId: "account-1",
            machineId: "machine-1",
        });
    });

    it("preserves a daemon admission failure outside the admitted Action response", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "machine", machineId: "machine-1" },
            input: {},
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "invalid_request" as const,
                errorCode: "invalid_action" as const,
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "daemon.newly-introduced-action",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "invalid_request",
            errorCode: "invalid_action",
        });
    });

    it("uses the canonical external Action result projection for daemon failures", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "machine", machineId: "machine-1" },
            input: {
                action: { pluginId: "acme.notes", localId: "save-note" },
                input: { title: "Quarterly notes" },
            },
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "response" as const,
                response: {
                    v: 1,
                    actionId: "action.invoke",
                    execution: {
                        ok: false,
                        errorCode: "target_declined",
                        error: "Target rejected this request",
                        details: { reason: "policy" },
                        retryable: true,
                        data: { internalTargetState: "declined" },
                        actionHandlerInvocation: "notStarted",
                    },
                },
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "action.invoke",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "response",
            response: {
                v: 1,
                actionId: "action.invoke",
                execution: {
                    ok: false,
                    errorCode: "target_declined",
                    error: "Target rejected this request",
                    details: { reason: "policy" },
                },
            },
        });
    });

    it("keeps the relay carrier usable after a typed oversized execution response", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "machine", machineId: "machine-1" },
            input: {},
        };
        const forwardRpc = vi.fn<ExternalActionForwardRpcCall>()
            .mockResolvedValueOnce({
                ok: true as const,
                result: {
                    kind: "response" as const,
                    response: {
                        v: 1,
                        actionId: "session.spawn_new",
                        execution: createExternalActionResultTooLargeExecutionV1(),
                    },
                },
            })
            .mockResolvedValueOnce({
                ok: true as const,
                result: relayResponse("session.spawn_new", envelope),
            });
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc,
            resolveMachine: async () => "available",
        });
        const request = {
            actionId: "session.spawn_new",
            envelope,
            principal,
        } as const;

        await expect(dispatch(request)).resolves.toMatchObject({
            kind: "response",
            response: {
                execution: {
                    ok: false,
                    errorCode: "result_too_large",
                    details: { executionCompleted: true },
                },
            },
        });
        await expect(dispatch(request)).resolves.toEqual({
            kind: "response",
            response: response("session.spawn_new", envelope),
        });
        expect(forwardRpc).toHaveBeenCalledTimes(2);
    });

    it("fails closed without forwarding a foreign machine target", async () => {
        const forwardRpc = vi.fn();
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "not_owned",
        });

        await expect(dispatch({
            actionId: "session.spawn_new",
            envelope: {
                v: 1,
                target: { kind: "machine", machineId: "foreign-machine" },
                input: {},
            },
            principal,
        })).resolves.toEqual({ kind: "placement_error", code: "target_not_local" });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it("filters an unproved claimed machine daemon before an external Action envelope can be submitted", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "machine", machineId: "machine-1" },
            input: { opaque: "must-not-reach-an-unproved-socket" },
        };
        const unprovedTarget = {
            id: "claimed-machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
        };
        const forwardRpc: ExternalActionForwardRpcCall = async (params) => {
            const candidates = await params.targetGuard?.filterTargets([unprovedTarget] as never) ?? [];
            return candidates.length === 0
                ? { ok: false, error: "RPC method unavailable" }
                : { ok: true, result: relayResponse("session.message.send", envelope) };
        };
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({ kind: "placement_error", code: "target_unavailable" });
    });

    it("uses the canonical Session-owner resolver to relay action.invoke without opening nested plugin input", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "session", sessionId: "session-1" },
            input: {
                action: { pluginId: "acme.external", localId: "inspect" },
                input: { sessionId: "nested-plugin-payload" },
            },
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: relayResponse("action.invoke", envelope),
        }));
        const resolveSessionMachine = vi.fn(async () => "machine-2");
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
            resolveSessionMachine,
        });

        const result = await dispatch({
            actionId: "action.invoke",
            envelope,
            principal,
        });
        expect(result).toEqual({
            kind: "response",
            response: response("action.invoke", envelope),
        });

        expect(resolveSessionMachine).toHaveBeenCalledWith({
            accountId: "account-1",
            sessionId: "session-1",
        });
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `machine-2:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
            callParams: expect.objectContaining({
                envelope,
                placement: {
                    machineId: "machine-2",
                    target: { kind: "machine", machineId: "machine-2" },
                },
            }),
        }));
    });

    it("derives a Session target from the current Session publisher projection rather than a machine default", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "session", sessionId: "session-1" },
            input: {},
        };
        const currentProjection = {
            v: 1,
            accountId: "account-1",
            machineId: "machine-2",
            sessionId: "session-1",
            committedFenceMs: 42,
        };
        const io = {
            in: vi.fn((room: string) => ({
                fetchSockets: async () => {
                    expect(room).toBe("user:account-1");
                    return [{ data: { sessionPublisherAuthority: currentProjection } }];
                },
            })),
        };
        const isCurrentPublisherProjection = vi.fn(async () => true);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: relayResponse("session.message.send", envelope),
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: io as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
            sessionPublisherPresence: { isCurrentPublisherProjection } as never,
        });

        const result = await dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        });
        expect(result).toEqual({
            kind: "response",
            response: response("session.message.send", envelope),
        });

        expect(isCurrentPublisherProjection).toHaveBeenCalledWith({
            expectedAccountId: "account-1",
            expectedSessionId: "session-1",
            projection: currentProjection,
        });
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `machine-2:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
        }));
    });

    it("retains an acknowledged Action response when target currentness changes after submission", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "machine", machineId: "machine-1" },
            input: {},
        };
        let targetCurrent = true;
        const target = {
            id: "machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
        };
        const forwardRpc: ExternalActionForwardRpcCall = async (params) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("Expected exact-target guard");
            const guarded = await targetGuard.runOperation({
                target,
                readLatestTarget: async () => target,
                operation: async () => {
                    targetCurrent = false;
                    return {
                        kind: "response" as const,
                        response: response("session.spawn_new", envelope),
                    };
                },
            });
            return guarded.status === "current"
                ? { ok: true, result: guarded.value }
                : { ok: false, error: "target unavailable" };
        };
        const resolveMachine = vi.fn(async () => (
            targetCurrent ? "available" as const : "unavailable" as const
        ));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.spawn_new",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "response",
            response: response("session.spawn_new", envelope),
        });
        expect(resolveMachine).toHaveBeenCalled();
    });

    it("forwards request cancellation only after the exact target socket is selected", async () => {
        const controller = new AbortController();
        const emit = vi.fn();
        const io = {
            to: vi.fn(() => ({ emit })),
        };
        const forwardRpc = vi.fn(async (params: Readonly<{
            cancellation?: Readonly<{
                targetRequestId: string;
                signal: AbortSignal;
                onTargetSelected: (target: Readonly<{ id: string }>) => void;
            }>;
        }>) => {
            if (!params.cancellation) throw new Error("expected cancellation");
            params.cancellation.onTargetSelected({ id: "machine-socket" });
            controller.abort();
            return { ok: false as const, error: "cancelled" };
        });
        const dispatch = createExternalActionDaemonDispatcher({
            io: io as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope: {
                v: 1,
                target: { kind: "machine", machineId: "machine-1" },
                input: {},
            },
            principal,
        }, { signal: controller.signal })).resolves.toEqual({
            kind: "placement_error",
            code: "target_unavailable",
        });

        expect(io.to).toHaveBeenCalledWith("machine-socket");
        expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: expect.any(String),
        });
    });

    it("returns target_required when the server has no exact target", async () => {
        const forwardRpc = vi.fn();
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "session.spawn_new",
            envelope: { v: 1, input: {} },
            principal,
        })).resolves.toEqual({ kind: "placement_error", code: "target_required" });
        expect(forwardRpc).not.toHaveBeenCalled();
    });
});
