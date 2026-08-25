import {
    createAccountScopedCryptoMaterialSnapshotV1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    sealAccountScopedBlobCiphertext,
    serializeAutomationRunExecutionRecipeV1,
    type SessionServerStartDispatchRequestV1,
} from "@happier-dev/protocol";
import {
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import {
    createSessionServerStartAutomationIngress,
    createSessionServerStartDaemonDispatcher,
    deriveSessionServerStartDispatchFromIngress,
} from "./sessionServerStartDispatcher";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";

/** Both stamped facts still hold. */
const CURRENT = { target: true, runClaim: true } as const;
/** The exact target Machine or Account currentness moved. */
const TARGET_LOST = { target: false, runClaim: true } as const;
/** The Run was cancelled, reclaimed, retried, or lost its lease. */
const RUN_CLAIM_LOST = { target: true, runClaim: false } as const;

const request: SessionServerStartDispatchRequestV1 = {
    v: 1,
    kind: "session.serverStart.dispatch",
    target: {
        accountId: "account-1",
        machineId: "machine-1",
        machineInstallationId: "installation-1",
    },
    start: {
        automationId: "automation-1",
        runId: "run-1",
        attempt: 3,
        claimedByMachineId: "machine-source",
        origin: "event",
        accountCurrentness: {
            mode: "plain",
            version: 7,
            contentKeyFingerprint: null,
        },
        // The server must preserve this opaque inner payload without parsing it.
        requestEnvelope: { t: "plain", v: { opaqueToServer: true } },
    },
};

const e2eeMaterial = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(31) },
});

const e2eeRequest: SessionServerStartDispatchRequestV1 = {
    ...request,
    start: {
        ...request.start,
        accountCurrentness: {
            mode: 'e2ee',
            version: 8,
            contentKeyFingerprint: 'content-key-8',
        },
        requestEnvelope: {
            t: 'encrypted',
            // Deliberately not a Session V2 payload. The server may inspect
            // only its outer mode/purpose tag before exact target forwarding.
            c: sealAccountScopedBlobCiphertext({
                kind: 'automation_session_start_request',
                material: e2eeMaterial.material,
                payload: { opaqueToServer: true },
                randomBytes: (length) => new Uint8Array(length).fill(32),
            }),
        },
    },
};

const ingressRequest = {
    v: 1,
    kind: "session.serverStart.ingress",
    runId: "run-1",
    attempt: 3,
    requestEnvelope: { t: "plain", v: { opaqueToServer: true } },
} as const;

const ingressCurrentness = {
    mode: "plain" as const,
    version: 7,
    contentKeyFingerprint: null,
};

const e2eeIngressCurrentness = {
    mode: 'e2ee' as const,
    version: 8,
    contentKeyFingerprint: 'content-key-8',
};

const e2eeIngressRequest = {
    v: 1,
    kind: 'session.serverStart.ingress',
    runId: 'run-1',
    attempt: 3,
    requestEnvelope: e2eeRequest.start.requestEnvelope,
} as const;

function ingressRecipe(machineId = "machine-2"): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: "start" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server-1", machineId },
                directory: "/workspace",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") throw new Error("expected strict ingress recipe");
    return serialized.serialized;
}

function e2eeIngressRecipe(machineId = 'machine-2'): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: 'encrypted',
            c: sealAccountScopedBlobCiphertext({
                kind: 'automation_template_payload',
                material: e2eeMaterial.material,
                payload: { v: 1, prompt: 'start encrypted' },
                randomBytes: (length) => new Uint8Array(length).fill(37),
            }),
        },
        triggerEvidence: null,
        target: {
            kind: 'newSession',
            spawn: {
                executionTarget: { serverId: 'server-1', machineId },
                directory: '/workspace',
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
            },
        },
    });
    if (serialized.kind !== 'available') throw new Error('expected strict E2EE ingress recipe');
    return serialized.serialized;
}

function validIngressDerivation(overrides?: Readonly<{
    run?: Partial<Parameters<typeof deriveSessionServerStartDispatchFromIngress>[0]["run"] & {}>;
    targetMachine?: Partial<NonNullable<Parameters<typeof deriveSessionServerStartDispatchFromIngress>[0]["targetMachine"]>>;
    request?: unknown;
    accountCurrentness?: Parameters<typeof deriveSessionServerStartDispatchFromIngress>[0]['accountCurrentness'];
    sourceMachineId?: string;
}>): Parameters<typeof deriveSessionServerStartDispatchFromIngress>[0] {
    const run = {
        automationId: "automation-1",
        state: "running",
        claimedByMachineId: "machine-1",
        attempt: 3,
        leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
        originKind: "pluginEvent",
        executionInputEnvelope: ingressRecipe(),
        ...(overrides?.run ?? {}),
    };
    const targetMachine = {
        id: "machine-2",
        accountId: "account-1",
        installationId: "installation-2",
        revokedAt: null,
        replacedByMachineId: null,
        operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
        ...(overrides?.targetMachine ?? {}),
    };
    return {
        accountId: "account-1",
        sourceMachineId: overrides?.sourceMachineId ?? "machine-1",
        request: overrides?.request ?? ingressRequest,
        now: new Date("2026-01-01T00:00:00.000Z"),
        accountCurrentness: overrides?.accountCurrentness ?? ingressCurrentness,
        run,
        targetMachine,
    };
}

describe("createSessionServerStartDaemonDispatcher", () => {
    it("forwards one opaque plain request only to the exact current machine daemon", async () => {
        const forwardRpc = vi.fn(async (_params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => ({
            ok: true as const,
            result: {
                type: "success" as const,
                disposition: "created" as const,
                sessionId: "session-1",
                executionTarget: { serverId: "server-1", machineId: "machine-1" },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: "notRequested" as const },
            },
        }));
        const resolveCurrentTarget = vi.fn(async () => CURRENT);
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "success",
            disposition: "created",
            sessionId: "session-1",
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "notRequested" },
        });
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            targetUserId: "account-1",
            method: `machine-1:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`,
            callParams: request,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN,
            },
        }));
        expect(forwardRpc.mock.calls[0]?.[0].targetGuard).toBeDefined();
        expect(forwardRpc.mock.calls[0]?.[0].targetGuard).not.toBeUndefined();
    });

    it("forwards the byte-21 E2EE outer request without Session V2 parsing or server key material", async () => {
        const forwardRpc = vi.fn(async () => ({
            ok: true as const,
            result: {
                type: 'success' as const,
                disposition: 'created' as const,
                sessionId: 'session-e2ee',
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' as const },
            },
        }));
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(e2eeRequest)).resolves.toEqual(expect.objectContaining({
            type: 'success',
            sessionId: 'session-e2ee',
        }));
        expect(forwardRpc).toHaveBeenCalledWith(expect.objectContaining({
            callParams: e2eeRequest,
        }));
    });

    it("fails closed before dispatch when the server can no longer prove the frozen target/currentness", async () => {
        const forwardRpc = vi.fn();
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => TARGET_LOST,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it("never submits when the derived Run claim stops being current before the target operation", async () => {
        const target: RpcAckResponseEmitter = {
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            await expect(targetGuard.filterTargets([target])).resolves.toEqual([]);
            await expect(targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        // The Run claim is still current for the entry check and moves before
        // the exact target is selected.
        const resolveCurrentTarget = vi.fn()
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValue(RUN_CLAIM_LOST);
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).not.toHaveBeenCalled();
    });

    it("keeps a committed Session identity when the Run claim moves only after the daemon response", async () => {
        const target: RpcAckResponseEmitter = {
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const committed = {
            type: "success" as const,
            disposition: "created" as const,
            sessionId: "session-committed",
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "notRequested" as const },
        };
        const operation = vi.fn(async () => committed);
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            const guarded = await targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            });
            if (guarded.status !== "current") throw new Error("expected a current guarded operation");
            return { ok: true as const, result: guarded.value };
        });
        // Entry, filter, and both pre-submit checks see a current Run claim;
        // the post-response check sees it gone.
        const resolveCurrentTarget = vi.fn()
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValue(RUN_CLAIM_LOST);
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget,
        });

        await expect(dispatcher(request)).resolves.toEqual(committed);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("revalidates currentness at the selected Socket target before it can emit", async () => {
        const target: RpcAckResponseEmitter = {
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            await expect(targetGuard.filterTargets([target])).resolves.toEqual([target]);
            await expect(targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        const resolveCurrentTarget = vi.fn()
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(TARGET_LOST);
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "an absent installation attestation",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
        },
        {
            name: "a substitute installation attestation",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-substitute",
            },
        },
    ])("refuses a same-machine Socket with $name", async ({ data }) => {
        const target: RpcAckResponseEmitter = {
            id: "substitute-socket",
            data,
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            await expect(targetGuard.filterTargets([target])).resolves.toEqual([]);
            await expect(targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).not.toHaveBeenCalled();
    });

    it("revalidates the exact attested installation after the daemon response", async () => {
        const selectedTarget: RpcAckResponseEmitter = {
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const replacementTarget: RpcAckResponseEmitter = {
            ...selectedTarget,
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-replaced",
            },
        };
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            await expect(targetGuard.runOperation({
                target: selectedTarget,
                operation,
                readLatestTarget: vi.fn()
                    .mockResolvedValueOnce(selectedTarget)
                    .mockResolvedValueOnce(replacementTarget),
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("revalidates target currentness after the daemon response", async () => {
        const target: RpcAckResponseEmitter = {
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            timeout: () => ({ emitWithAck: async () => ({}) }),
        };
        const operation = vi.fn(async () => ({ emitted: true }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            targetGuard?: RpcForwardTargetGuard;
        }>) => {
            const targetGuard = params.targetGuard;
            if (!targetGuard) throw new Error("expected exact target guard");
            await expect(targetGuard.runOperation({
                target,
                operation,
                readLatestTarget: async () => target,
            })).resolves.toEqual({ status: "unavailable" });
            return { ok: false as const, error: "target unavailable" };
        });
        const resolveCurrentTarget = vi.fn()
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(CURRENT)
            .mockResolvedValueOnce(TARGET_LOST);
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget,
        });

        await expect(dispatcher(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed outer dispatch bytes without treating them as a target failure", async () => {
        const forwardRpc = vi.fn();
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher({ ...request, start: { ...request.start, requestEnvelope: { t: "encrypted", c: "x" } } }))
            .resolves.toEqual({
                type: "error",
                code: "invalid_input",
                retryable: false,
            });
        expect(forwardRpc).not.toHaveBeenCalled();
    });

    it("preserves a returned canonical success when cancellation arrives after the daemon response", async () => {
        const controller = new AbortController();
        const emit = vi.fn();
        const to = vi.fn(() => ({ emit }));
        const forwardRpc = vi.fn(async (params: Readonly<{
            cancellation?: Readonly<{
                onTargetSelected: (target: Readonly<{ id: string }>) => void;
            }>;
        }>) => {
            params.cancellation?.onTargetSelected({ id: "socket-1" });
            controller.abort(new Error("Automation run cancelled"));
            return {
                ok: true as const,
                result: {
                    type: "success" as const,
                    disposition: "created" as const,
                    sessionId: "session-1",
                    executionTarget: { serverId: "server-1", machineId: "machine-1" },
                    organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: "notRequested" as const },
                },
            };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: { to } as unknown as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(request, { signal: controller.signal })).resolves.toEqual({
            type: "success",
            disposition: "created",
            sessionId: "session-1",
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "notRequested" },
        });
        expect(to).toHaveBeenCalledWith("socket-1");
        expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: expect.any(String),
        });
    });

    it("returns canonical pending unknown after a post-emission abort or lost acknowledgement", async () => {
        const controller = new AbortController();
        const forwardRpc = vi.fn(async (params: Readonly<{
            onSubmittedUnknown?: () => void;
        }>) => {
            controller.abort(new Error("caller stopped waiting after dispatch"));
            params.onSubmittedUnknown?.();
            return {
                ok: false as const,
                error: "operation has timed out",
            };
        });
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(request, { signal: controller.signal })).resolves.toEqual({
            type: "pending",
            retryWithSameCreationKey: true,
            outcome: "unknown",
        });
    });

    it("keeps a pre-selection cancellation cancelled", async () => {
        const controller = new AbortController();
        controller.abort(new Error("caller cancelled before target selection"));
        const forwardRpc = vi.fn();
        const dispatcher = createSessionServerStartDaemonDispatcher({
            io: {} as Server,
            forwardRpc: forwardRpc as never,
            resolveCurrentTarget: async () => CURRENT,
        });

        await expect(dispatcher(request, { signal: controller.signal })).resolves.toEqual({
            type: "error",
            code: "cancelled",
            retryable: true,
        });
        expect(forwardRpc).not.toHaveBeenCalled();
    });
});

describe("Session server-start Automation ingress", () => {
    it("rederives Run claimant, attempt, target installation, and capability before producing a server stamp", () => {
        const stamped = deriveSessionServerStartDispatchFromIngress(validIngressDerivation());
        expect(stamped).toEqual(expect.objectContaining({
            target: {
                accountId: "account-1",
                machineId: "machine-2",
                machineInstallationId: "installation-2",
            },
            start: expect.objectContaining({
                automationId: "automation-1",
                runId: "run-1",
                // The stamped claim carries the exact correspondence the
                // pre-submit guard revalidates against the canonical Run.
                attempt: 3,
                claimedByMachineId: "machine-1",
                origin: "event",
                accountCurrentness: ingressCurrentness,
                requestEnvelope: ingressRequest.requestEnvelope,
            }),
        }));
        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            run: { claimedByMachineId: "machine-9" },
        }))).toBeNull();
        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            run: { attempt: 4 },
        }))).toBeNull();
        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            targetMachine: { id: "machine-9" },
        }))).toBeNull();
        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            targetMachine: { installationId: null },
        }))).toBeNull();
        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            targetMachine: { operationProtocolCapabilities: {} },
        }))).toBeNull();
    });

    it('routes E2EE outer bytes without opening V2 and rejects mismatched mode or purpose', () => {
        const encrypted = deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            request: e2eeIngressRequest,
            accountCurrentness: e2eeIngressCurrentness,
            run: { executionInputEnvelope: e2eeIngressRecipe() },
        }));
        expect(encrypted).toEqual(expect.objectContaining({
            start: expect.objectContaining({
                accountCurrentness: e2eeIngressCurrentness,
                requestEnvelope: e2eeIngressRequest.requestEnvelope,
            }),
        }));

        expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
            request: ingressRequest,
            accountCurrentness: e2eeIngressCurrentness,
            run: { executionInputEnvelope: e2eeIngressRecipe() },
        }))).toBeNull();
        for (const kind of ['automation_trigger_evidence', 'automation_trigger_definition'] as const) {
            expect(deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
                accountCurrentness: e2eeIngressCurrentness,
                run: { executionInputEnvelope: e2eeIngressRecipe() },
                request: {
                    ...e2eeIngressRequest,
                    requestEnvelope: {
                        t: 'encrypted',
                        c: sealAccountScopedBlobCiphertext({
                            kind,
                            material: e2eeMaterial.material,
                            payload: { opaqueToServer: true },
                            randomBytes: (length) => new Uint8Array(length).fill(38),
                        }),
                    },
                },
            }))).toBeNull();
        }
    });

    it("uses direct stamped dispatch only after server derivation for the source machine and otherwise reuses the closed Socket bridge", async () => {
        const forward = vi.fn(async () => ({
            type: "error" as const,
            code: "target_unavailable" as const,
            retryable: true,
        }));
        const retainProducedSession = vi.fn(async () => ({ retained: true }));
        const resolveDispatch = vi.fn(async () => {
            const dispatch = deriveSessionServerStartDispatchFromIngress(validIngressDerivation());
            if (dispatch === null) return { kind: 'unavailable' as const };
            return { kind: 'available' as const, dispatch };
        });
        const ingress = createSessionServerStartAutomationIngress({
            forward,
            resolveDispatch,
            retainProducedSession,
        });

        await expect(ingress({
            accountId: "account-1",
            sourceMachineId: "machine-1",
            request: ingressRequest,
        })).resolves.toEqual({
            v: 1,
            kind: "result",
            result: { type: "error", code: "target_unavailable", retryable: true },
        });
        expect(forward).toHaveBeenCalledOnce();
        expect(retainProducedSession).not.toHaveBeenCalled();

        const localResolve = vi.fn(async () => {
            const dispatch = deriveSessionServerStartDispatchFromIngress(validIngressDerivation({
                run: { executionInputEnvelope: ingressRecipe("machine-1") },
                targetMachine: { id: "machine-1", installationId: "installation-1" },
            }));
            if (dispatch === null) return { kind: 'unavailable' as const };
            return { kind: 'available' as const, dispatch };
        });
        const localIngress = createSessionServerStartAutomationIngress({
            forward,
            resolveDispatch: localResolve,
            retainProducedSession,
        });
        await expect(localIngress({
            accountId: "account-1",
            sourceMachineId: "machine-1",
            request: ingressRequest,
        })).resolves.toEqual(expect.objectContaining({
            v: 1,
            kind: "local",
            dispatch: expect.objectContaining({ target: expect.objectContaining({ machineId: "machine-1" }) }),
        }));
        expect(forward).toHaveBeenCalledOnce();
        expect(retainProducedSession).not.toHaveBeenCalled();
    });

    it("awaits Run-produced Session retention before acknowledging a cross-machine success", async () => {
        let resolveRetention!: () => void;
        const retainProducedSession = vi.fn(async () => await new Promise<unknown>((resolve) => {
            resolveRetention = () => resolve({ retained: true });
        }));
        const forward = vi.fn(async () => ({
            type: "success" as const,
            disposition: "created" as const,
            sessionId: "session-retained-before-ack",
            executionTarget: { serverId: "server-1", machineId: "machine-2" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "notRequested" as const },
        }));
        const ingress = createSessionServerStartAutomationIngress({
            forward,
            resolveDispatch: async () => {
                const dispatch = deriveSessionServerStartDispatchFromIngress(validIngressDerivation());
                if (dispatch === null) return { kind: "unavailable" as const };
                return { kind: "available" as const, dispatch };
            },
            retainProducedSession,
        });

        const response = ingress({
            accountId: "account-1",
            sourceMachineId: "machine-1",
            request: ingressRequest,
        });
        await vi.waitFor(() => expect(retainProducedSession).toHaveBeenCalledOnce());
        expect(retainProducedSession).toHaveBeenCalledWith({
            accountId: "account-1",
            machineId: "machine-1",
            runId: "run-1",
            attempt: 3,
            result: expect.objectContaining({
                type: "success",
                sessionId: "session-retained-before-ack",
            }),
        });
        let acknowledged = false;
        void response.then(() => {
            acknowledged = true;
        });
        await Promise.resolve();
        expect(acknowledged).toBe(false);

        resolveRetention();
        await expect(response).resolves.toEqual({
            v: 1,
            kind: "result",
            result: expect.objectContaining({
                type: "success",
                sessionId: "session-retained-before-ack",
            }),
        });
    });

    it("downgrades a cross-machine success when canonical Run retention cannot be established", async () => {
        const retainProducedSession = vi.fn(async () => null);
        const ingress = createSessionServerStartAutomationIngress({
            forward: async () => ({
                type: "success" as const,
                disposition: "created" as const,
                sessionId: "session-not-retained",
                executionTarget: { serverId: "server-1", machineId: "machine-2" },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: "notRequested" as const },
            }),
            resolveDispatch: async () => {
                const dispatch = deriveSessionServerStartDispatchFromIngress(validIngressDerivation());
                if (dispatch === null) return { kind: "unavailable" as const };
                return { kind: "available" as const, dispatch };
            },
            retainProducedSession,
        });

        await expect(ingress({
            accountId: "account-1",
            sourceMachineId: "machine-1",
            request: ingressRequest,
        })).resolves.toEqual({
            v: 1,
            kind: "result",
            result: { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" },
        });
        expect(retainProducedSession).toHaveBeenCalledOnce();
    });

    it("returns one observable cross-machine pending outcome without attempting Session retention", async () => {
        const retainProducedSession = vi.fn(async () => ({ retained: true }));
        const forward = vi.fn(async () => ({
            type: "pending" as const,
            retryWithSameCreationKey: true as const,
            outcome: "unknown" as const,
        }));
        const ingress = createSessionServerStartAutomationIngress({
            forward,
            resolveDispatch: async () => {
                const dispatch = deriveSessionServerStartDispatchFromIngress(validIngressDerivation());
                if (dispatch === null) return { kind: "unavailable" as const };
                return { kind: "available" as const, dispatch };
            },
            retainProducedSession,
        });

        await expect(ingress({
            accountId: "account-1",
            sourceMachineId: "machine-1",
            request: ingressRequest,
        })).resolves.toEqual({
            v: 1,
            kind: "result",
            result: { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" },
        });
        expect(retainProducedSession).not.toHaveBeenCalled();
    });

    it('returns incompatible_target before any target effect when the current exact target lacks sessionSpawn', async () => {
        const forward = vi.fn();
        const ingress = createSessionServerStartAutomationIngress({
            forward,
            resolveDispatch: async () => ({ kind: 'incompatibleTarget' }),
        });

        await expect(ingress({
            accountId: 'account-1',
            sourceMachineId: 'machine-1',
            request: ingressRequest,
        })).resolves.toEqual({
            v: 1,
            kind: 'result',
            result: { type: 'error', code: 'incompatible_target', retryable: false },
        });
        expect(forward).not.toHaveBeenCalled();
    });
});
