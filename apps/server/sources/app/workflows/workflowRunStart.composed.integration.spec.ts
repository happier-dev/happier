import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { createWorkflowAccountRunActionOwner } from "@happier-dev/protocol/actions/executor/workflowRunActions";
import { createWorkflowActionExecutor } from "@happier-dev/protocol/actions/executor/workflowAccountActions";
import { createWorkflowDefinitionActions } from "@happier-dev/protocol/actions/executor/workflowDefinitions";
import { readCompleteActionSpecV1 } from "@happier-dev/protocol/actions/actionCatalog";
import { createActionExecutor } from "@happier-dev/protocol/actions/actionExecutor";
import { StrictJsonValueSchema } from "@happier-dev/protocol/json/strictJsonValue";
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactHeaderV1Schema } from "@happier-dev/protocol/workflows/workflowDefinitionV1";
import { WorkflowActionOutputSchemasV1 } from "@happier-dev/protocol/workflows/actionsV1";
import { validateWorkflowDefinition } from "@happier-dev/protocol/workflows/workflowValidationV1";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from "@happier-dev/protocol/storage/artifactStoredContent";
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from "@happier-dev/protocol/plugins/installations/manifests";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from "@/testkit/pluginInstallationPublisherTestkit";
import { deriveAutomationAccountCurrentnessWitness } from "@/app/automations/automationAccountCurrentness";
import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { registerExternalActionRoutes } from "@/app/api/routes/actions/registerExternalActionRoutes";
import { verifyCurrentExternalActionPrincipal } from "@/app/auth/externalActionExecutionAuthorization";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from "@happier-dev/protocol/actions/externalActionApi";
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from "@happier-dev/protocol/auth/apiTokenGrant";
import { projectRequesterAccountActionAuthorization } from "../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection";
import { installAxiosFastifyAdapter } from "../../../../cli/src/testkit/http/axiosAdapter";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows/workflowStoredContentV1";
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AvailableAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decryptWithDataKey, encryptWithDataKey } from '../../../../cli/src/api/encryption';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe("composed saved Workflow start admission", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-start-", initAuth: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([{ mode: 'plain', miswired: false }, { mode: 'plain', miswired: true }, { mode: 'e2ee', miswired: false }] as const)("starts through materialization, signed Action storage and exact Get ($mode, publisher mis-bound: $miswired)", async ({ mode, miswired }) => {
        const contentKeys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(contentKeys.publicKey), encryptionMode: mode } });
        const witness = deriveAutomationAccountCurrentnessWitness(account);
        if (!witness) throw new Error("account_currentness_unavailable");
        const encryption: AvailableAutomationAccountEncryptionV1 = witness.mode === 'e2ee' && witness.contentKeyFingerprint
            ? { kind: 'available', witness: { ...witness, mode: 'e2ee', contentKeyFingerprint: witness.contentKeyFingerprint },
                material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                    material: { type: 'dataKey', machineKey: contentKeys.secretKey }, dataKeyPublicKey: contentKeys.publicKey }) }
            : { kind: 'available', witness: { ...witness, mode: 'plain', contentKeyFingerprint: null } };
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        const machineDataKey = tweetnacl.randomBytes(32);
        const machineMetadata = { host: "workflow-test", platform: "linux", happyCliVersion: "0.3.0",
            homeDir: '/home/test', happyHomeDir: '/home/test/.happier' };
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        await db.machine.update({ where: { id: machineId }, data: { active: true, lastActiveAt: new Date(),
            dataEncryptionKey: mode === 'plain' ? new Uint8Array(privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER))
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineDataKey,
                    recipientPublicKey: contentKeys.publicKey, randomBytes: tweetnacl.randomBytes })),
            metadata: mode === 'plain' ? encodePlainMachineStoredContent(machineMetadata)
                : privacyKit.encodeBase64(encryptWithDataKey(machineMetadata, machineDataKey)),
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerWorkflowRunStorageRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerExternalActionRoutes(app);
        const agentTarget = { kind: "agent" as const, identity: { pluginId: "external.workflow-test", localId: "agent" } };
        const engine = { agentTarget };
        const document = { text: "Return the requested value.", references: [], attachments: [] };
        const childId = randomUUID();
        const sourceId = randomUUID();
        const runId = randomUUID();
        const normalize = (value: unknown) => {
            const result = validateWorkflowDefinition(value);
            if (!result.valid || !result.normalizedDefinition) throw new Error(JSON.stringify(result.issues));
            return result.normalizedDefinition;
        };
        const child = normalize({ version: 1, defaults: { engine }, blocks: [{ kind: "step", id: "child-reply", document, result: { kind: "text" } }],
            finalOutput: { kind: "result", producer: { blockId: "child-reply", scope: { kind: "current" } }, path: [] } });
        // R63's authored kinds, binding topology, role and mixed target classes.
        const definition = normalize({ version: 1, inputs: [], defaults: { engine, permissionMode: "default" },
            roles: [{ roleId: "verifier", name: "Verifier", engine: { agentTargetKey: "agent:external.workflow-test/agent", modelId: "small" }, runsAs: { kind: "session" }, instructions: "Verify the supplied item." }],
            blocks: [
                { kind: "step", id: "named-ready", document, result: { kind: "json", schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false } } },
                { kind: "if", id: "if-ready", when: { kind: "exists", value: { kind: "result", producer: { blockId: "named-ready", scope: { kind: "current" } }, path: ["ready"] } },
                    then: [{ kind: "step", id: "if-reply", document, result: { kind: "text" } }], otherwise: [] },
                { kind: "loop", id: "parallel-items", repetition: { kind: "items", items: { kind: "literal", value: ["alpha", "beta"] }, execution: "parallel", failurePolicy: "fail_stop" },
                    body: [{ kind: "step", id: "item-reply", document, input: [{ kind: "item", field: "value" }], execution: { engine: { role: "verifier" } }, result: { kind: "text" } }] },
                { kind: "action", id: "list-triggers", actionId: "workflow.trigger.list", input: { workflow: { kind: "literal", value: childId } } },
                { kind: "workflow", id: "nested-child", workflowRef: childId, input: {} },
                { kind: "step", id: "background-reply", document, execution: { agentTarget, executionTarget: { kind: "detached_run" }, conversation: { kind: "fresh" } }, result: { kind: "text" } },
            ], finalOutput: { kind: "result", producer: { blockId: "background-reply", scope: { kind: "current" } }, path: [] } });
        for (const [id, value] of [[childId, child], [sourceId, definition]] as const) {
            const header = WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: "workflow-definition.v1", definitionId: id,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: "Composed admission" } });
            const body = JSON.stringify(WorkflowDefinitionArtifactBodyV1Schema.parse({ kind: "workflow-definition.v1", definition: value }));
            const artifactKey = tweetnacl.randomBytes(32);
            await db.artifact.create({ data: { id, accountId: account.id, headerVersion: 1, bodyVersion: 1,
                header: mode === 'plain' ? new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent(header)))
                    : new Uint8Array(encryptWithDataKey(header, artifactKey)),
                body: mode === 'plain' ? new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent(body)))
                    : new Uint8Array(encryptWithDataKey({ body }, artifactKey)),
                dataEncryptionKey: mode === 'plain' ? new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER))
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: artifactKey,
                        recipientPublicKey: contentKeys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        }
        const unused = async (): Promise<never> => { throw new Error("unexpected_artifact_mutation"); };
        const definitions = createWorkflowDefinitionActions({ assertDefinitionWriteAllowed: unused, encodeListCursor: () => "unused", artifactStore: {
            // SQLite is the real persistence boundary; the canonical codec and
            // definition owner open exactly the producer's stored envelopes.
            read: async id => {
                const row = await db.artifact.findUnique({ where: { id } });
                if (!row || row.accountId !== account.id) return null;
                const artifactKey = mode === 'e2ee' ? openEncryptedDataKeyEnvelopeV1({ envelope: row.dataEncryptionKey,
                    recipientSecretKeyOrSeed: contentKeys.secretKey }) : null;
                if (mode === 'e2ee' && !artifactKey) throw new Error('Expected the owning Account artifact envelope');
                const header = WorkflowDefinitionArtifactHeaderV1Schema.parse(artifactKey ? decryptWithDataKey(row.header, artifactKey)
                    : decodePlainArtifactStoredContent(privacyKit.encodeBase64(row.header)));
                const body = artifactKey ? ArtifactBodyEnvelopeV1Schema.parse(decryptWithDataKey(row.body, artifactKey)).body
                    : decodePlainArtifactStoredContent(privacyKit.encodeBase64(row.body));
                if (typeof body !== "string") throw new Error("invalid_artifact_body");
                return { artifactId: id, ownerAccountId: account.id, access: "owner", header, body,
                    revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
            }, list: unused, create: unused, update: unused, delete: unused,
        } });
        // Discovery runs the real executor; unused external host/native ports fail loudly.
        const discovery = createActionExecutor({ executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
            detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
            sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
            pathsListRecent: unused, projectsList: unused, machinesList: unused, serversList: unused,
            reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
            agentsConfigOptionsList: unused, agentsSessionModesList: unused, spawnProfilesList: unused,
            spawnConnectedServicesList: unused, spawnMcpServersPreview: unused,
            sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
            sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused,
            sessionTargetTrackedSet: unused, sessionList: unused, sessionActivityGet: unused,
            sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: () => { throw new Error("unexpected_native_execution"); },
            teleportVoiceAgentToSessionRoot: unused,
            daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        });
        const storageResponses: Array<{ operation: unknown; status: number }> = [];
        let storageAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
        const externalTarget = { kind: 'machine' as const, machineId, project: { machineId, directory: '/repo' } };
        const runs = createWorkflowAccountRunActionOwner({ definitions,
            resolveAccountId: async () => account.id,
            resolveEncryption: async () => encryption,
            normalizeAbsolutePath: path => path.startsWith("/") ? path : null,
            randomBytes: length => {
                if (mode === 'plain') throw new Error("plain_account_has_no_keys");
                return tweetnacl.randomBytes(length);
            },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId, directory: "/repo", checkoutRootPath: "/repo" } } }),
            resolveMaterializationContext: async () => ({ effects: {
                resolveTargetAvailability: async () => true, // Native Agent execution is outside admission.
                readWorkflowDefinition: async ref => ref.kind === "artifact"
                    ? { ...await definitions.get({ definitionId: ref.artifactId }), sourceKey: ref.artifactId } : null,
                readActionContract: async actionId => {
                    const contract = await readCompleteActionSpecV1({ actionId, read: async input => {
                        const response = await discovery.execute("action.spec.get", input, { surface: "cli", authority: "present_user" });
                        if (!response.ok) throw new Error(response.errorCode);
                        return response.result;
                    } });
                    if (!contract.outputSchema) return null;
                    return { inputSchema: StrictJsonValueSchema.parse(contract.inputSchema), outputSchema: StrictJsonValueSchema.parse(contract.outputSchema) };
                },
            } }),
            storage: { execute: async (operation, options) => {
                if (!storageAuthorization) throw new Error('Expected the actual signed Action transport');
                const publisherMachineId = options?.publisherMachineId ?? storageAuthorization.binding.machineId;
                const payload = { ...operation, publisherMachineId: miswired && operation.operation === "admit" ? randomUUID() : publisherMachineId };
                const response = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", payload,
                    headers: {
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: storageAuthorization.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'workflow.run.start',
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(externalTarget),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                            authorizationToken: storageAuthorization.token, effectActionId: 'workflow.run.start', target: externalTarget,
                            installationId, requestId: storageAuthorization.binding.requestId, method: 'POST', path: '/v3/automations/runs/workflow-storage',
                            body: payload, privateKey: keyPair.secretKey }),
                        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair, machineId, installationId, path: "/v3/automations/runs/workflow-storage", body: payload, nonce: randomUUID(),
                    }) } });
                storageResponses.push({ operation: operation.operation, status: response.statusCode });
                if (response.statusCode !== 200) {
                    const refusal = response.json<{ error?: string } | null>();
                    throw Object.assign(new Error("storage_refused"), { code: refusal?.error ?? "run_access_denied", response: { status: response.statusCode } });
                }
                return response.json();
            } },
        });
        const execute = createWorkflowActionExecutor({ definitions, runs, isWorkflowFeatureEnabled: () => true });
        const input = { runId, source: { kind: "saved" as const, definitionId: sourceId, revision: { headerVersion: 1, bodyVersion: 1 } } };
        const requestId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: {
            serverIdentityId: serverId, accountId: account.id, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
            actionId: 'workflow.run.start', requestId, target: externalTarget }, input,
            material: { type: 'dataKey', machineKey: contentKeys.secretKey }, randomBytes: tweetnacl.randomBytes })
            : { v: 1, requestId, target: externalTarget, input };
        const issued = await app.inject({ method: "POST", url: "/v1/actions/workflow.run.start/execution-authorization",
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId,
                envelope } });
        expect(issued.statusCode, issued.payload).toBe(200);
        const proof = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        storageAuthorization = proof;
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: "https://workflow-start.test" });
        const authorization = await projectRequesterAccountActionAuthorization({ authorization: proof, serverIdentityId: serverId,
            bootstrap: { credentials: { token, encryption: mode === 'e2ee'
                ? { type: 'dataKey', machineKey: contentKeys.secretKey, publicKey: contentKeys.publicKey } : null }, serverHttpBaseUrl: "https://workflow-start.test",
                attribution: { serverId, accountId: account.id, machineId, installationId },
                isCurrent: async () => Boolean(await auth.verifyExternalActionExecutionAuthorization(proof.token)
                    && await verifyCurrentExternalActionPrincipal(proof.binding)),
            } });
        expect(authorization?.requesterAccountProjection).toBeDefined();
        const context = { surface: "ui" as const, authority: "present_user" as const, actionCaller: { kind: "host" as const }, callerPermissionMode: "default" as const,
            serverIdentityId: serverId, runtimeAccountId: account.id, externalActionExecutionAuthorization: authorization ?? undefined,
            externalActionTarget: { kind: "machine" as const, machineId, project: { machineId, directory: "/repo" } } };
        try {
            const forgedInput = { ...input, runId: randomUUID(), authenticatedStarterV1: {
                requestRef: requestId, requester: { serverId, accountId: randomUUID() },
            } };
            expect(await execute({ actionId: "workflow.run.start", input: forgedInput, context }))
                .toMatchObject({ ok: false, errorCode: "invalid_input" });
            expect(await db.automationRun.findUnique({ where: { id: forgedInput.runId } })).toBeNull();
            const started = await execute({ actionId: "workflow.run.start", input, context });
            const read = await execute({ actionId: "workflow.run.get", input: { runId }, context });
            if (miswired) {
                expect(storageResponses).toContainEqual({ operation: "admit", status: 401 });
                expect(started).toMatchObject({ ok: false, errorCode: "invalid_token" });
                expect(read).toMatchObject({ ok: false, errorCode: "run_not_found" });
                expect(await db.automationRun.findUnique({ where: { id: runId } })).toBeNull();
            } else {
                expect(started, JSON.stringify({ storageResponses, runExists: Boolean(await db.automationRun.findUnique({ where: { id: runId }, select: { id: true } })) })).toMatchObject({ admission: "created", run: { id: runId, state: "queued", sourceArtifactId: sourceId } });
                if (mode === 'e2ee') {
                    const detail = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(read);
                    expect(detail).toMatchObject({ run: { id: runId, state: 'queued' }, acceptedContext: {
                        frozenChildren: { [childId]: { blocks: [{ id: 'child-reply' }] } },
                    } });
                    expect(detail.definition.blocks.map(block => ({ id: block.id, kind: block.kind })))
                        .toEqual(definition.blocks.map(block => ({ id: block.id, kind: block.kind })));
                    const encrypted = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
                    expect(parseWorkflowStoredContentEnvelopeV1(encrypted.workflowAcceptedSnapshotEnvelope!)).toMatchObject({ t: 'encrypted' });
                    return;
                }
                expect(WorkflowActionOutputSchemasV1["workflow.run.get"].parse(read)).toMatchObject({ run: { id: runId, state: "queued" }, acceptedContext: {
                    frozenChildren: { [childId]: { blocks: [{ id: "child-reply" }] } },
                    materializedLeaves: expect.arrayContaining([{ sourceKey: "$root", blockId: "item-reply", kind: "step", selection: expect.any(Object), executionTarget: { kind: "session" }, authoredWorkspace: { kind: "inherit" }, role: expect.objectContaining({ roleId: "verifier" }) }]),
                } });
                const detail = WorkflowActionOutputSchemasV1["workflow.run.get"].parse(read);
                const row = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
                expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: "plain",
                    envelope: parseWorkflowStoredContentEnvelopeV1(row.workflowAcceptedSnapshotEnvelope!),
                    binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId } }))
                    .toMatchObject({ kind: "available", content: { origin: { authenticatedStarterV1: {
                        requestRef: requestId, requester: { serverId, accountId: account.id },
                    } } } });
                expect(detail.definition.blocks.map(block => ({ id: block.id, kind: block.kind })))
                    .toEqual(definition.blocks.map(block => ({ id: block.id, kind: block.kind })));
                expect(detail.acceptedContext.materializedLeaves.map(leaf => ({ sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: leaf.kind, target: leaf.executionTarget.kind })))
                    .toEqual([
                        { sourceKey: "$root", blockId: "named-ready", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "if-reply", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "item-reply", kind: "step", target: "session" },
                        { sourceKey: "$root", blockId: "list-triggers", kind: "action", target: "session" },
                        { sourceKey: "$root", blockId: "nested-child", kind: "workflow", target: "session" },
                        { sourceKey: "$root", blockId: "background-reply", kind: "step", target: "detached_run" },
                        { sourceKey: childId, blockId: "child-reply", kind: "step", target: "session" },
                    ]);

                // New Run admission consumes the current bearer grant at Home;
                // it is distinct from worker execution of an admitted Run.
                const pat = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Workflow admission"),
                    grant: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
                        actions: { families: [], ids: ["workflow.run.start"] },
                        targets: { sessions: [], machines: [machineId] } }) });
                const patInput = { ...input, runId: randomUUID() };
                const admitWithPat = (nextInput: typeof patInput) => app.inject({ method: "POST",
                    url: "/v1/actions/workflow.run.start/execution-authorization",
                    headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId,
                        envelope: { v: 1, requestId: randomUUID(), target: context.externalActionTarget, input: nextInput } } });
                const patIssued = await admitWithPat(patInput);
                expect(patIssued.statusCode, patIssued.payload).toBe(200);
                const patProof = ExternalActionExecutionAuthorizationV1Schema.parse(patIssued.json());
                if ("authentication" in patProof.binding) throw new Error("Expected PAT admission");
                const patContext = { ...context, surface: "api" as const, authority: "account_automation" as const,
                    externalActionExecutionAuthorization: patProof,
                    externalActionCredential: { accountId: patProof.binding.accountId, principalId: patProof.binding.principalId,
                        credentialId: patProof.binding.credentialId, grant: patProof.binding.grant } };
                const admitsBefore = storageResponses.filter(response => response.operation === "admit").length;
                storageAuthorization = patProof;
                expect(await execute({ actionId: "workflow.run.start", input: patInput, context: patContext }))
                    .toMatchObject({ admission: "created", run: { id: patInput.runId, state: "queued" } });
                expect(storageResponses.filter(response => response.operation === "admit")).toHaveLength(admitsBefore + 1);
                const admitted = await db.automationRun.findUniqueOrThrow({ where: { id: patInput.runId } });
                expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: "plain",
                    envelope: parseWorkflowStoredContentEnvelopeV1(admitted.workflowAcceptedSnapshotEnvelope!),
                    binding: { v: 1, purpose: "accepted_snapshot", accountId: account.id, runId: patInput.runId } }))
                    .toMatchObject({ kind: "available", content: { authorization: { principal: {
                        kind: "api", accountId: account.id, principalId: account.id, credentialId: pat.tokenId,
                    } } } });

                expect(await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId })).toMatchObject({ revoked: true });
                const nextInput = { ...input, runId: randomUUID() };
                const storageBeforeRefusal = [...storageResponses];
                const denied = await admitWithPat(nextInput);
                expect(denied.statusCode).toBe(401);
                expect(denied.json()).toMatchObject({ error: "invalid_token" });
                expect(storageResponses).toEqual(storageBeforeRefusal);
                expect(await db.automationRun.findUnique({ where: { id: nextInput.runId } })).toBeNull();
                expect(await db.automationRunAssignment.count({ where: { runId: nextInput.runId } })).toBe(0);
                expect(await db.workflowRunInvocation.count({ where: { runId: nextInput.runId } })).toBe(0);
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: patInput.runId } })).toEqual(admitted);
            }
        } finally { restoreHttp(); await app.close(); }
    });
});
