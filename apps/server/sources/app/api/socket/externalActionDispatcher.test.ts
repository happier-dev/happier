import { describe, expect, it, vi } from "vitest";
import { Server } from 'socket.io';
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";

import {
    createExternalActionDaemonDispatchResponse,
    createExternalActionDaemonDispatchResponseV1,
    createExternalActionResultTooLargeExecutionV1,
    prepareExternalActionResponseEnvelopeV1,
    prepareExternalActionResponseV2,
    sealExternalActionRequestV2,
    type ExternalActionRequestEnvelopeV1,
} from "@happier-dev/protocol/actions";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    createExternalActionDaemonDispatcher as createProductionExternalActionDaemonDispatcher,
    type ExternalActionForwardRpcCall,
} from "./externalActionDispatcher";

function createExternalActionDaemonDispatcher(
    params: Parameters<typeof createProductionExternalActionDaemonDispatcher>[0],
) {
    return createProductionExternalActionDaemonDispatcher({
        ...params,
        getServerIdentityId: async () => "server-1",
        mintExecutionAuthorization: async (binding) => ({ v: 1, token: "test-authorization",
            binding: { ...binding, custodianAccountId: binding.accountId, installationId: 'installation-1' } }),
    });
}

const principal = {
    accountId: "account-1",
    principalId: "principal-1",
    credentialId: "credential-1",
    authority: "account_automation" as const,
    grant: API_TOKEN_FULL_GRANT_V1,
};

const protectedMaterial = {
    type: "dataKey" as const,
    machineKey: new Uint8Array(32).fill(9),
};

const protectedRandomBytes = (length: number) => new Uint8Array(length).fill(2);

function response(actionId: string, envelope: ExternalActionRequestEnvelopeV1) {
    return {
        v: 1 as const,
        actionId,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        execution: { ok: true as const, result: { accepted: true } },
    };
}

function relayResponse(actionId: string, envelope: ExternalActionRequestEnvelopeV1) {
    return createExternalActionDaemonDispatchResponseV1(
        prepareExternalActionResponseEnvelopeV1(response(actionId, envelope)),
    );
}

function relayedPreparedResponse(value: unknown) {
    return createExternalActionDaemonDispatchResponseV1(
        prepareExternalActionResponseEnvelopeV1(value),
    );
}

function dispatchedResponse(value: unknown) {
    return {
        kind: "response" as const,
        prepared: prepareExternalActionResponseEnvelopeV1(value),
    };
}

describe("createExternalActionDaemonDispatcher", () => {
    it("returns operation-scoped update required before sending an authorized invocation to an old daemon", async () => {
        const forwardRpc = vi.fn();
        const resolveMachine = vi.fn(async (input: Readonly<{
            accountId: string;
            machineId: string;
            requiredExternalActionExecutionAuthorization?: true;
        }>) => input.requiredExternalActionExecutionAuthorization === true
            ? "external_action_update_required" as const
            : "available" as const);
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "action.spec.get",
            principal,
            envelope: {
                v: 1,
                requestId: "request-old-daemon",
                target: { kind: "machine", machineId: "machine-1" },
                input: { actionId: "action.spec.get" },
            },
        })).resolves.toEqual({
            kind: "placement_error",
            code: "encrypted_action_unsupported",
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'action.spec.get',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it('rejects a raw response to a protected request as transport ambiguity', async () => {
        const dispatch = createExternalActionDaemonDispatcher({
            io: new Server(),
            resolveMachine: async () => 'available',
            forwardRpc: async () => ({ ok: true, result: relayResponse('action.spec.get', { v: 1, requestId: 'request-1', input: {} }) }),
        });
        await expect(dispatch({ actionId: 'action.spec.get', principal,
            envelope: { v: 2, requestId: 'request-1', target: { kind: 'machine', machineId: 'machine-1' },
                payload: { t: 'encrypted', c: 'AAAA' } },
        })).resolves.toEqual({ kind: 'submitted_unknown' });
    });
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
        })).resolves.toEqual(dispatchedResponse(response("session.spawn_new", envelope)));

        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            targetUserId: "account-1",
            method: `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
            callParams: expect.objectContaining({
                actionId: "session.spawn_new",
                envelope,
                principal,
                executionAuthorization: {
                    v: 1,
                    token: "test-authorization",
                    binding: expect.objectContaining({
                        serverIdentityId: "server-1",
                        machineId: "machine-1",
                        actionId: "session.spawn_new",
                        requestId: "request-1",
                    }),
                },
                placement: {
                    machineId: "machine-1",
                    target: { kind: "machine", machineId: "machine-1" },
                },
            }),
        }));
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.spawn_new',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
        });
    });

    it("rejects targeted Session input before relay when the exact Machine lacks targeted admission", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            requestId: "request-targeted",
            target: { kind: "machine", machineId: "machine-1" },
            input: {
                sessionId: "session-1",
                message: "Continue the attached Run",
                recipient: { kind: "execution_run", runId: "run-1" },
            },
        };
        const forwardRpc = vi.fn();
        const resolveMachine = vi.fn(async (input: Readonly<{
            accountId: string;
            machineId: string;
            requiredSessionInputAdmissionProtocolVersion?: 2;
        }>) => input.requiredSessionInputAdmissionProtocolVersion === 2
            ? "session_input_update_required" as const
            : "available" as const);
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "placement_error",
            code: "session_input_target_update_required",
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.message.send',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
            requiredSessionInputAdmissionProtocolVersion: 2,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it("requires Session input admission v2 before relaying an opaque V2 Session send", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "request-encrypted-session-send",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque-ciphertext" },
        };
        const forwardRpc = vi.fn();
        const resolveMachine = vi.fn(async (input: Readonly<{
            accountId: string;
            machineId: string;
            requiredSessionInputAdmissionProtocolVersion?: 2;
        }>) => input.requiredSessionInputAdmissionProtocolVersion === 2
            ? "session_input_update_required" as const
            : "available" as const);
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "placement_error",
            code: "session_input_target_update_required",
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.message.send',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
            requiredSessionInputAdmissionProtocolVersion: 2,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it("relays an opaque V2 Session send when both daemon capabilities are current", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "request-current-encrypted-session-send",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque-ciphertext" },
        };
        const resolveMachine = vi.fn(async () => "available" as const);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "invalid_request" as const,
                errorCode: "invalid_action" as const,
                requestId: envelope.requestId,
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "invalid_request",
            errorCode: "invalid_action",
            requestId: envelope.requestId,
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.message.send',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
            requiredSessionInputAdmissionProtocolVersion: 2,
        });
        expect(forwardRpc).toHaveBeenCalledTimes(1);
    });

    it("retains plaintext V1 main-send compatibility without requiring targeted admission", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            requestId: "request-v1-main-send",
            target: { kind: "machine", machineId: "machine-1" },
            input: { sessionId: "session-1", message: "Continue" },
        };
        const resolveMachine = vi.fn(async () => "available" as const);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: relayResponse("session.message.send", envelope),
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual(dispatchedResponse(response("session.message.send", envelope)));
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.message.send',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
        });
        expect(forwardRpc).toHaveBeenCalledTimes(1);
    });

    it("does not require Session input admission v2 for another opaque V2 Action", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "request-encrypted-spec-get",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque-ciphertext" },
        };
        const resolveMachine = vi.fn(async () => "available" as const);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "invalid_request" as const,
                errorCode: "invalid_action" as const,
                requestId: envelope.requestId,
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "action.spec.get",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "invalid_request",
            errorCode: "invalid_action",
            requestId: envelope.requestId,
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'action.spec.get',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
        });
        expect(forwardRpc).toHaveBeenCalledTimes(1);
    });

    it("relays an opaque V2 Session send when the exact Machine publishes both required capabilities", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "request-encrypted-session-send-current",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque-ciphertext" },
        };
        const resolveMachine = vi.fn(async () => "available" as const);
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "invalid_request" as const,
                errorCode: "invalid_action" as const,
                requestId: envelope.requestId,
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine,
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({
            kind: "invalid_request",
            errorCode: "invalid_action",
            requestId: envelope.requestId,
        });
        expect(resolveMachine).toHaveBeenCalledWith({
            actionId: 'session.message.send',
            accountId: "account-1",
            machineId: "machine-1",
            requiredExternalActionExecutionAuthorization: true,
            requiredSessionInputAdmissionProtocolVersion: 2,
        });
        expect(forwardRpc).toHaveBeenCalledTimes(1);
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

    it("rejects a protected daemon admission failure correlated to another request", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "protected-request",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque" },
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: "invalid_request" as const,
                errorCode: "target_not_local" as const,
                requestId: "different-request",
            },
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        })).resolves.toEqual({ kind: "submitted_unknown" });
    });

    it("preserves the daemon's canonical prepared Action failure through the relay", async () => {
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
            result: relayedPreparedResponse({
                v: 1,
                actionId: "action.invoke",
                execution: {
                    ok: false,
                    errorCode: "target_declined",
                    error: "Target rejected this request",
                    details: { reason: "policy" },
                },
            }),
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
        })).resolves.toEqual(dispatchedResponse({
            v: 1,
            actionId: "action.invoke",
            execution: {
                ok: false,
                errorCode: "target_declined",
                error: "Target rejected this request",
                details: { reason: "policy" },
            },
        }));
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
                result: relayedPreparedResponse({
                    v: 1,
                    actionId: "session.spawn_new",
                    execution: createExternalActionResultTooLargeExecutionV1(),
                }),
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
            prepared: {
                response: {
                    execution: {
                        ok: false,
                        errorCode: "result_too_large",
                        details: { executionCompleted: true },
                    },
                },
            },
        });
        await expect(dispatch(request)).resolves.toEqual(
            dispatchedResponse(response("session.spawn_new", envelope)),
        );
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
        expect(result).toEqual(dispatchedResponse(response("action.invoke", envelope)));

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
                    expect(room).toBe("session:session-1:account-1");
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
        expect(result).toEqual(dispatchedResponse(response("session.message.send", envelope)));

        expect(isCurrentPublisherProjection).toHaveBeenCalledWith({
            expectedAccountId: "account-1",
            expectedSessionId: "session-1",
            projection: currentProjection,
        });
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `machine-2:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
        }));
    });

    it("resolves a Session target hosted by a publisher that is not in the Account-wide room", async () => {
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            target: { kind: "session", sessionId: "session-1" },
            input: {},
        };
        // A restricted Runner joins the per-account Session room but is
        // deliberately excluded from `user:<accountId>`.
        const runnerProjection = {
            v: 1,
            accountId: "account-1",
            machineId: "runner-machine",
            sessionId: "session-1",
            committedFenceMs: 7,
        };
        const rooms: string[] = [];
        const io = {
            in: vi.fn((room: string) => ({
                fetchSockets: async () => {
                    rooms.push(room);
                    return room === "session:session-1:account-1"
                        ? [{ data: { sessionPublisherAuthority: runnerProjection } }]
                        : [];
                },
            })),
        };
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: relayResponse("session.message.send", envelope),
        }));
        const dispatch = createExternalActionDaemonDispatcher({
            io: io as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
            sessionPublisherPresence: { isCurrentPublisherProjection: async () => true } as never,
        });

        const result = await dispatch({
            actionId: "session.message.send",
            envelope,
            principal,
        });
        expect(result).toEqual(dispatchedResponse(response("session.message.send", envelope)));
        expect(rooms).toEqual(["session:session-1:account-1"]);
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `runner-machine:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
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
                userId: "account-1",
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
                    return relayResponse("session.spawn_new", envelope);
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
        })).resolves.toEqual(dispatchedResponse(response("session.spawn_new", envelope)));
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

    it("preserves the daemon's authenticated V2 cancellation outcome after submission", async () => {
        const controller = new AbortController();
        const binding = {
            serverIdentityId: "srv_server-1",
            accountId: "account-1",
            credentialId: "00000000-0000-4000-8000-000000000001",
            actionId: "action.spec.get",
            requestId: "protected-cancellation",
            target: { kind: "machine" as const, machineId: "machine-1" },
        };
        const envelope = sealExternalActionRequestV2({
            binding,
            input: { actionId: "session.message.send" },
            material: protectedMaterial,
            randomBytes: protectedRandomBytes,
        });
        const prepared = prepareExternalActionResponseV2({
            binding,
            request: envelope,
            executedMachineId: "machine-1",
            execution: {
                ok: false,
                errorCode: "cancelled",
                error: "cancelled",
                details: { outcomeUnknown: false },
            },
            material: protectedMaterial,
            randomBytes: protectedRandomBytes,
        });
        const emit = vi.fn();
        const io = { to: vi.fn(() => ({ emit })) };
        const forwardRpc = vi.fn(async (params: Readonly<{
            cancellation?: Readonly<{
                onTargetSelected: (target: Readonly<{ id: string }>) => void;
            }>;
        }>) => {
            if (!params.cancellation) throw new Error("expected cancellation");
            params.cancellation.onTargetSelected({ id: "machine-socket" });
            controller.abort();
            return {
                ok: true as const,
                result: createExternalActionDaemonDispatchResponse(prepared),
            };
        });
        const dispatch = createExternalActionDaemonDispatcher({
            io: io as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "action.spec.get",
            envelope,
            principal,
        }, { signal: controller.signal })).resolves.toEqual({
            kind: "response",
            prepared,
        });
        expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: expect.any(String),
        });
    });

    it("preserves post-submission response loss as transport ambiguity", async () => {
        const envelope = {
            v: 2 as const,
            requestId: "protected-submitted-unknown",
            target: { kind: "machine" as const, machineId: "machine-1" },
            payload: { t: "encrypted" as const, c: "opaque" },
        };
        const forwardRpc = vi.fn(async (params: Readonly<{
            onSubmittedUnknown?: () => void;
        }>) => {
            params.onSubmittedUnknown?.();
            return { ok: false as const, error: "acknowledgement lost" };
        });
        const dispatch = createExternalActionDaemonDispatcher({
            io: {} as never,
            forwardRpc: forwardRpc as never,
            resolveMachine: async () => "available",
        });

        await expect(dispatch({
            actionId: "action.spec.get",
            envelope,
            principal,
        })).resolves.toEqual({ kind: "submitted_unknown" });
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            onSubmittedUnknown: expect.any(Function),
        }));
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
