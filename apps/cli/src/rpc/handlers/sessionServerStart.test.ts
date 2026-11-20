import {
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    sealAutomationSessionStartRequestEnvelopeV1,
    SessionSpawnNewInputV2Schema,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterialSnapshotV1,
    type SessionServerStartDispatchRequestV1,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { createServer } from 'node:http';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';

import {
    registerSessionServerStartRpcHandler,
} from "./sessionServerStart";
import { createMachineSessionServerStartSpawnLifecycleTransport } from './sessionServerStartLifecycleAdapter';
import { registerMachineSessionServerStartRpcHandler } from './sessionServerStartMachineBinding';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { WorkflowTargetUnavailableDetailsV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';

const plainCurrentness: AccountEncryptionCurrentnessResponse = createAccountEncryptionCurrentnessFixture({
    mode: "plain",
    version: 7,
    updatedAt: 7,
});

const plainSpawnInput = {
    creationKey: "automation-run:run-1",
    executionTarget: { serverId: "server-1", machineId: "machine-1" },
    directory: { kind: "path", path: "/workspace/project" },
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: {
        kind: "agent",
        identity: { pluginId: "happier.agent.codex", localId: "codex" },
    },
    initialInput: { text: "Start the automation task." },
};

const validatedPlainSpawnInput = SessionSpawnNewInputV2Schema.parse(plainSpawnInput);

const lifecycleSpawnRequest = {
    directory: '/workspace/project',
    machineId: 'machine-1',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
} as const;

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
        cause: { kind: "manual", invokedAt: 1 },
        accountCurrentness: {
            mode: "plain",
            version: 7,
            contentKeyFingerprint: null,
        },
        requestEnvelope: {
            t: "plain",
            v: plainSpawnInput,
        },
    },
};

function createRegistration(overrides?: Readonly<{
    accountId?: string | null;
    installationId?: string | null;
    currentness?: readonly AccountEncryptionCurrentnessResponse[];
    material?: AccountScopedCryptoMaterialSnapshotV1 | null;
    resolveCurrentness?: (signal?: AbortSignal) => Promise<AccountEncryptionCurrentnessResponse>;
    afterExecute?: () => void;
}>) {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    const executeSessionStart = vi.fn(async () => {
        const result = {
            type: "success" as const,
            disposition: "created" as const,
            sessionId: "session-1",
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "accepted" as const, localId: "local-1" },
        };
        overrides?.afterExecute?.();
        return result;
    });
    const currentness = overrides?.currentness ?? [plainCurrentness];
    let currentnessIndex = 0;
    registerSessionServerStartRpcHandler(registrar, {
        machineId: "machine-1",
        resolveAccountId: async () => overrides?.accountId === undefined ? "account-1" : overrides.accountId,
        resolveInstallationId: () => overrides?.installationId === undefined ? "installation-1" : overrides.installationId,
        resolveAccountEncryptionCurrentness: overrides?.resolveCurrentness
            ?? (async () => currentness[Math.min(currentnessIndex++, currentness.length - 1)]!),
        resolveAccountEncryptionMaterial: async () => overrides?.material ?? null,
        executeSessionStart,
    });
    const handler = handlers.get(SESSION_SERVER_START_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error("expected Session server-start handler");
    return { handler, executeSessionStart };
}

describe("registerSessionServerStartRpcHandler", () => {
    it.each([
        { outcome: 'permission_denied', includePlacement: false },
        { outcome: 'caller_depth_unavailable', includePlacement: false },
        { outcome: 'private_details', includePlacement: false },
        { outcome: 'spawn_failed', includePlacement: false },
        { outcome: 'credential_read_failed', includePlacement: false },
        { outcome: 'success', includePlacement: false },
        { outcome: 'success', includePlacement: true },
    ] as const)('retains the public Action $outcome at the real Machine server-start binding (placement=$includePlacement)', async ({ outcome, includePlacement }) => {
        const publicResult = { type: 'success' as const, disposition: 'created' as const, sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } };
        const requests: string[] = [];
        const failureCause = { phase: 'session.target_preparation', errorClass: 'Error',
            errorCode: 'credential_scope_denied', httpStatus: null } as const;
        const refusal = outcome === 'caller_depth_unavailable'
            ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: WorkflowTargetUnavailableDetailsV1Schema.parse({ code: 'target_unavailable', reason: outcome }) }
            : outcome === 'private_details'
                ? { ok: false, errorCode: 'target_unavailable', error: 'PRIVATE_UPSTREAM_TEXT',
                    details: { code: 'target_unavailable', reason: 'caller_depth_unavailable', secret: 'PRIVATE_REFUSAL_PAYLOAD' } }
                : outcome === 'spawn_failed'
                    ? { ok: false, errorCode: outcome, error: 'PRIVATE_UPSTREAM_TEXT', failureCause }
                    : { ok: false, errorCode: outcome, error: outcome };
        // Only the external Home Action endpoint is substituted. The reserved
        // registration, credentialed executor, HTTP client and strict result parser run.
        const home = createServer(async (incoming, response) => {
            requests.push(`${incoming.method} ${incoming.url}`);
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const requestId = body && typeof body === 'object' && 'requestId' in body ? body.requestId : undefined;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new', requestId,
                execution: outcome === 'success' ? { ok: true, result: projectSessionSpawnNewActionResultV1(publicResult) }
                    : refusal }));
        });
        await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
        const address = home.address();
        if (!address || typeof address === 'string') throw new Error('Expected fixture Home');
        const url = `http://127.0.0.1:${address.port}`;
        try {
            await withConfiguredDaemonTestHome({ prefix: 'server-start-action-refusal-',
                env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
                const handlers = new Map<string, RpcHandler>();
                const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
                registerMachineSessionServerStartRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                    machineId: 'machine-1', token,
                    readCredentials: async () => {
                        if (outcome === 'credential_read_failed') {
                            throw Object.assign(new Error('PRIVATE_CREDENTIAL_STORE_PATH'), { code: 'EACCES' });
                        }
                        return { token, encryption: null, credentialProvenance: 'api_token' };
                    },
                    resolveAccountId: async () => 'account-1', resolveInstallationId: () => 'installation-1',
                    resolveAccountEncryptionCurrentness: async () => plainCurrentness,
                    spawnLifecycleHandler: async () => { throw new Error('The public Action owns this start'); },
                });
                const handler = handlers.get(SESSION_SERVER_START_DAEMON_RPC_METHOD_V1);
                if (!handler) throw new Error('Expected reserved server-start registration');
                const { organizationPlacement: _placement, ...withoutPlacement } = validatedPlainSpawnInput;
                const startRequest = { ...request, start: { ...request.start,
                    requestEnvelope: { t: 'plain' as const,
                        v: includePlacement ? validatedPlainSpawnInput : withoutPlacement } } };
                const result = await handler(startRequest);
                if (outcome === 'credential_read_failed') {
                    expect(result).toEqual({ type: 'error', code: 'spawn_failed', retryable: true,
                        failureCause: { phase: 'session.target_preparation', errorClass: 'Error',
                            errorCode: 'EACCES', httpStatus: null } });
                    expect(requests).toHaveLength(0);
                    return;
                }
                if (!includePlacement) expect(requests).toHaveLength(1);
                if (outcome === 'spawn_failed') {
                    expect(result).toMatchObject({ type: 'error', code: outcome, failureCause });
                    expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_TEXT');
                } else expect(result).toEqual(outcome === 'success' ? publicResult
                    : outcome === 'caller_depth_unavailable' ? { type: 'error', code: 'spawn_failed', retryable: false,
                        launchError: { kind: 'launch_error', code: outcome, message: outcome } }
                    : { type: 'error', code: outcome === 'private_details' ? 'target_unavailable' : outcome, retryable: false });
                expect(requests).toHaveLength(1);
            });
        } finally {
            await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
        }
    });

    it("opens only the plain V2 envelope after exact target/currentness checks and stamps Automation provenance", async () => {
        const controller = new AbortController();
        const { handler, executeSessionStart } = createRegistration();
        const requestEnvelope = request.start.requestEnvelope;
        if (requestEnvelope.t !== 'plain') throw new Error('expected a plain request envelope fixture');

        await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
            type: "success",
            disposition: "created",
            sessionId: "session-1",
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: "accepted", localId: "local-1" },
        });
        expect(executeSessionStart).toHaveBeenCalledWith(
            requestEnvelope.v,
            {
                signal: controller.signal,
                actionCaller: {
                    kind: "automationRun",
                    automationId: "automation-1",
                    runId: "run-1",
                    cause: { kind: "manual", invokedAt: 1 },
                },
            },
        );
    });

    it('preserves a committed Session result when cancellation wins after the local creation owner returns', async () => {
        const controller = new AbortController();
        const { handler, executeSessionStart } = createRegistration({
            afterExecute: () => controller.abort(new Error('Automation Run cancelled after Session commit')),
        });

        await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'accepted', localId: 'local-1' },
        });
        expect(executeSessionStart).toHaveBeenCalledTimes(1);
    });

    it("opens the byte-21 E2EE envelope only at the exact target after material/currentness admission", async () => {
        const material = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(33) },
        });
        const currentness: AccountEncryptionCurrentnessResponse = createAccountEncryptionCurrentnessFixture({
            mode: 'e2ee',
            version: 7,
            signingKeyFingerprint: null,
            contentKeyFingerprint:
                convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    material.contentPublicKeyFingerprint,
                ),
            updatedAt: 7,
        });
        const plainEnvelope = request.start.requestEnvelope;
        if (plainEnvelope.t !== 'plain') throw new Error('expected plain V2 fixture');
        const encryptedRequest: SessionServerStartDispatchRequestV1 = {
            ...request,
            start: {
                ...request.start,
                accountCurrentness: {
                    mode: 'e2ee',
                    version: currentness.version,
                    contentKeyFingerprint: currentness.contentKeyFingerprint,
                },
                requestEnvelope: sealAutomationSessionStartRequestEnvelopeV1({
                    mode: 'e2ee',
                    input: validatedPlainSpawnInput,
                    material: material.material,
                    randomBytes: (length) => new Uint8Array(length).fill(34),
                }),
            },
        };
        const { handler, executeSessionStart } = createRegistration({
            currentness: [currentness, currentness],
            material,
        });

        await expect(handler(encryptedRequest)).resolves.toEqual(expect.objectContaining({
            type: 'success',
            sessionId: 'session-1',
        }));
        expect(executeSessionStart).toHaveBeenCalledWith(
            plainEnvelope.v,
            expect.objectContaining({
                actionCaller: expect.objectContaining({ kind: 'automationRun' }),
            }),
        );
    });

    it("refuses E2EE Session creation before local dispatch when current Account material is absent", async () => {
        const material = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(35) },
        });
        const currentness: AccountEncryptionCurrentnessResponse = createAccountEncryptionCurrentnessFixture({
            mode: 'e2ee',
            version: 7,
            signingKeyFingerprint: null,
            contentKeyFingerprint:
                convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    material.contentPublicKeyFingerprint,
                ),
            updatedAt: 7,
        });
        const plainEnvelope = request.start.requestEnvelope;
        if (plainEnvelope.t !== 'plain') throw new Error('expected plain V2 fixture');
        const encryptedRequest: SessionServerStartDispatchRequestV1 = {
            ...request,
            start: {
                ...request.start,
                accountCurrentness: {
                    mode: 'e2ee',
                    version: currentness.version,
                    contentKeyFingerprint: currentness.contentKeyFingerprint,
                },
                requestEnvelope: sealAutomationSessionStartRequestEnvelopeV1({
                    mode: 'e2ee',
                    input: validatedPlainSpawnInput,
                    material: material.material,
                    randomBytes: (length) => new Uint8Array(length).fill(36),
                }),
            },
        };
        const { handler, executeSessionStart } = createRegistration({
            currentness: [currentness],
            material: null,
        });

        await expect(handler(encryptedRequest)).resolves.toEqual({
            type: 'error',
            code: 'target_unavailable',
            retryable: true,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong Account", { accountId: "account-2" }],
        ["wrong installation", { installationId: "installation-2" }],
    ])("rejects %s before opening or creating", async (_label, overrides) => {
        const { handler, executeSessionStart } = createRegistration(overrides);

        await expect(handler(request)).resolves.toEqual({
            type: "error",
            code: "target_unavailable",
            retryable: true,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it("allows unrelated Account sequence movement before the local create entrypoint", async () => {
        const { handler, executeSessionStart } = createRegistration({
            currentness: [
                plainCurrentness,
                { ...plainCurrentness, version: 8, updatedAt: 8 },
            ],
        });

        await expect(handler(request)).resolves.toEqual(expect.objectContaining({
            type: "success",
            sessionId: "session-1",
        }));
    });

    it("rejects an opaque V2 request whose target does not match the server-stamped machine", async () => {
        const { handler, executeSessionStart } = createRegistration();
        await expect(handler({
            ...request,
            start: {
                ...request.start,
                requestEnvelope: {
                    t: "plain",
                    v: {
                        ...plainSpawnInput,
                        executionTarget: { serverId: "server-1", machineId: "machine-2" },
                    },
                },
            },
        })).resolves.toEqual({
            type: "error",
            code: "invalid_input",
            retryable: false,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it("rejects an opened V2 request whose creation key is not bound to the stamped Run", async () => {
        const { handler, executeSessionStart } = createRegistration();
        await expect(handler({
            ...request,
            start: {
                ...request.start,
                requestEnvelope: {
                    t: "plain",
                    v: {
                        ...plainSpawnInput,
                        creationKey: "automation-run:another-run",
                    },
                },
            },
        })).resolves.toEqual({
            type: "error",
            code: "invalid_input",
            retryable: false,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it("keeps malformed E2EE carrier bytes closed", async () => {
        const { handler, executeSessionStart } = createRegistration();

        await expect(handler({
            ...request,
            start: {
                ...request.start,
                requestEnvelope: { t: "encrypted", c: "ciphertext" },
            },
        })).resolves.toEqual({
            type: "error",
            code: "invalid_input",
            retryable: false,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it("honors cancellation before it opens or invokes the local creation owner", async () => {
        const controller = new AbortController();
        controller.abort();
        const { handler, executeSessionStart } = createRegistration();

        await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
            type: "error",
            code: "cancelled",
            retryable: true,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });

    it("reports cancellation when the currentness read is interrupted", async () => {
        const controller = new AbortController();
        const { handler, executeSessionStart } = createRegistration({
            resolveCurrentness: async (signal) => {
                controller.abort(new Error("run cancelled during currentness read"));
                signal?.throwIfAborted();
                return plainCurrentness;
            },
        });

        await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
            type: "error",
            code: "cancelled",
            retryable: true,
        });
        expect(executeSessionStart).not.toHaveBeenCalled();
    });
});

describe('createMachineSessionServerStartSpawnLifecycleTransport', () => {
    it('keeps cancellation authoritative before the lifecycle owner can commit', async () => {
        const controller = new AbortController();
        controller.abort(new Error('Automation Run cancelled before Session creation'));
        const directTargetTransport = createMachineSessionServerStartSpawnLifecycleTransport({
            spawnLifecycleHandler: async () => {
                throw new Error('lifecycle owner must not run after pre-commit cancellation');
            },
        });

        await expect(directTargetTransport.spawn(
            lifecycleSpawnRequest,
            { signal: controller.signal },
        )).rejects.toBe(controller.signal.reason);
    });

    it('preserves a committed Session returned by the lifecycle binding when cancellation wins after commit', async () => {
        const controller = new AbortController();
        const spawnLifecycleHandler: SessionLifecycleActionHandler = async () => {
            controller.abort(new Error('Automation Run cancelled after Session commit'));
            return {
                type: 'success' as const,
                sessionId: 'session-committed',
                sessionCreationOutcome: {
                    disposition: 'created' as const,
                    organizationPlacement: { folderId: null, tagIds: [] },
                },
            };
        };
        const directTargetTransport = createMachineSessionServerStartSpawnLifecycleTransport({
            spawnLifecycleHandler,
        });

        await expect(directTargetTransport.spawn(
            lifecycleSpawnRequest,
            { signal: controller.signal },
        )).resolves.toEqual({
            type: 'success',
            sessionId: 'session-committed',
            sessionCreationOutcome: {
                disposition: 'created',
                organizationPlacement: { folderId: null, tagIds: [] },
            },
        });
    });

    it('does not turn an identity-less lifecycle result into a committed Session after cancellation', async () => {
        const controller = new AbortController();
        const spawnLifecycleHandler: SessionLifecycleActionHandler = async () => {
            controller.abort(new Error('Automation Run cancelled before Session commit'));
            return {
                type: 'error' as const,
                errorCode: 'invalid_request',
                errorMessage: 'Session was not committed',
            };
        };
        const directTargetTransport = createMachineSessionServerStartSpawnLifecycleTransport({
            spawnLifecycleHandler,
        });

        await expect(directTargetTransport.spawn(
            lifecycleSpawnRequest,
            { signal: controller.signal },
        )).rejects.toBe(controller.signal.reason);
    });

    it('does not treat a blank Session identity as committed after cancellation', async () => {
        const controller = new AbortController();
        const spawnLifecycleHandler: SessionLifecycleActionHandler = async () => {
            controller.abort(new Error('Automation Run cancelled before Session identity was known'));
            return {
                type: 'success' as const,
                sessionId: '  ',
            };
        };
        const directTargetTransport = createMachineSessionServerStartSpawnLifecycleTransport({
            spawnLifecycleHandler,
        });

        await expect(directTargetTransport.spawn(
            lifecycleSpawnRequest,
            { signal: controller.signal },
        )).rejects.toBe(controller.signal.reason);
    });
});
