import { describe, expect, it } from "vitest";
import { TeamCredentialSourceBindingV1Schema } from "@happier-dev/protocol/teams";

import {
    projectTeamCredentialProviderModels,
    projectTeamCredentialRequestPolicySupportModels,
    selectPoolBackedTeamCredentialProviderModels,
    selectPoolBackedTeamCredentialRequestPolicySupportModels,
} from "./providerModelProjection";

const application = {
    agentTargetKey: "agent:happier.agent.codex/codex",
    implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
    endpointTemplateId: "responses",
    protocol: "openai-responses",
} as const;
const parsedSource = TeamCredentialSourceBindingV1Schema.parse({
    v: 1 as const,
    kind: "provider_connection" as const,
    connectionId: "pc-1",
    connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(43)}`,
    credentialSlotId: "apiKey",
});
if (parsedSource.kind !== "provider_connection") throw new Error("expected Provider Connection source fixture");
const source = parsedSource;

function response(fingerprint: typeof source.connectionSecurityFingerprint = source.connectionSecurityFingerprint) {
    return {
        status: "success",
        agentTargetKey: application.agentTargetKey,
        groups: [{
            connectionId: source.connectionId,
            providerName: "OpenAI", connectionName: "Work", connectionRole: "named",
            connectionDisplayNameMode: "custom", connectionRevision: 1,
            sourceAuthority: {
                provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                connectionSecurityFingerprint: fingerprint,
            },
            sourceRevision: "source-1", modelLoadAction: "available", modelLoadPreflightPolicy: null,
            authorization: { authorized: true }, manualModelPolicy: "allowed",
            supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
            rows: [{
                ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: source.connectionId, modelId: "gpt-5" },
                descriptor: {
                    id: "gpt-5",
                    name: "GPT-5",
                    capabilities: { reasoningControls: "supported" as const },
                    modelOptions: [{
                        id: "reasoning_effort",
                        name: "Reasoning effort",
                        type: "select" as const,
                        currentValue: "medium",
                        options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }],
                    }],
                }, application,
                requestPolicySupport: {
                    descriptor: {
                        id: "gpt-5",
                        name: "GPT-5",
                        capabilities: { reasoningControls: "supported" as const },
                        modelOptions: [{
                            id: "reasoning_effort",
                            name: "Reasoning effort",
                            type: "select" as const,
                            currentValue: "medium",
                            options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }],
                        }],
                    },
                    application,
                    sourceRevision: "source-1",
                    protocolKind: "openai_responses" as const,
                    model: { canonicalId: "gpt-5", aliases: [] },
                    reasoningEffort: {
                        supported: true as const,
                        allowedValues: ["low", "medium"],
                        defaultValue: "medium",
                    },
                },
                directMaterialization: {
                    endpoint: {
                        endpointTemplateId: "responses", normalizedUrl: "https://api.example.test/v1",
                        protocol: "openai-responses", publicHeaders: {},
                    },
                    credentialTransport: {
                        id: "api-key", protocols: ["openai-responses"], uses: ["runtime"],
                        destination: { kind: "httpHeader", name: "Authorization", format: "bearer" },
                    },
                },
                sources: { manual: false, static: true, probe: false }, confidence: "verified_static",
                compatibility: {
                    result: {
                        status: "verified", selectedProtocol: application.protocol,
                        evidence: { sourceUrls: ["https://docs.example.test/openai"], verifiedAt: "2026-09-10" },
                    },
                    compatibilityFingerprint: "compatibility:v1:current", confirmed: false,
                },
                endpointHealth: "not_checked", catalog: { stale: false }, loadState: "unknown", visibility: "visible",
            }],
        }],
    };
}

describe("projectTeamCredentialProviderModels", () => {
    it("preserves source catalog uncertainty independently of route availability", () => {
        const observed = response();
        Object.assign(observed.groups[0]!.rows[0]!, { confidence: 'account_unverified',
            confirmationSource: { connectionId: source.connectionId, catalogSourceKey: 's'.repeat(43) } });
        const projected = projectTeamCredentialProviderModels({
            response: observed, resourceId: 'resource-1', teamId: 'team-1', resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source,
            allowedModelIds: null, deliveryMode: 'brokered',
        });
        expect(projected).toMatchObject({ status: 'success', models: [{
            confidence: 'account_unverified', sources: { manual: false, static: true, probe: false },
            availability: 'available',
        }] });
        expect(projected.models[0]).not.toHaveProperty('confirmationSource');
        expect(projected.models[0]).not.toHaveProperty('experimentalBindingConfirmations');
    });

    it("keeps a malformed or denied source projection distinct from a current empty catalog", () => {
        const input = {
            resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source,
            allowedModelIds: null, deliveryMode: "brokered",
        } as const;
        expect(projectTeamCredentialProviderModels({ ...input, response: {} })).toMatchObject({
            status: "unavailable", reason: "response_invalid", models: [],
        });
        const denied = response();
        Object.assign(denied.groups[0]!.authorization, {
            authorized: false,
            error: { v: 1, code: "provider_not_enabled_on_machine", retryable: false, action: "enable_on_machine" },
        });
        expect(projectTeamCredentialProviderModels({ ...input, response: denied })).toMatchObject({
            status: "unavailable", reason: "not_granted", models: [],
        });
        expect(projectTeamCredentialProviderModels({ ...input, response: { ...response(), groups: [] } })).toMatchObject({
            status: "success", models: [],
        });
    });

    it("admits only the exact source, application, compatibility, and allowed model", () => {
        const input = {
            response: response(), resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source,
            allowedModelIds: ["gpt-5"], deliveryMode: "brokered",
        } as const;
        expect(projectTeamCredentialProviderModels(input).models).toHaveLength(1);
        const experimental = response();
        Object.assign(experimental.groups[0]!.rows[0]!.compatibility, { result: {
            status: 'experimental', selectedProtocol: application.protocol, reasons: ['compatibility_evidence_missing'],
            confirmationScope: { kind: 'model', modelId: 'gpt-5' },
        }, confirmed: false });
        expect(projectTeamCredentialProviderModels({ ...input, response: experimental }).models).toEqual([
            expect.objectContaining({ compatibility: expect.objectContaining({ result: expect.objectContaining({ status: 'experimental' }), confirmed: false }) }),
        ]);
        const changedSource = TeamCredentialSourceBindingV1Schema.parse({
            ...source,
            connectionSecurityFingerprint: `connection-security:v1:${"b".repeat(43)}`,
        });
        if (changedSource.kind !== "provider_connection") throw new Error("expected Provider Connection source fixture");
        expect(projectTeamCredentialProviderModels({ ...input, response: response(changedSource.connectionSecurityFingerprint) }).models).toEqual([]);
        expect(projectTeamCredentialProviderModels({ ...input, application: { ...application, endpointTemplateId: "other" } })).toMatchObject({
            status: "unavailable", reason: "incompatible", models: [],
        });
        expect(projectTeamCredentialProviderModels({ ...input, allowedModelIds: ["other"] }).models).toEqual([]);
    });

    it("requires one exact current recipient-material witness without projecting runtime material", () => {
        const base = {
            response: response(), resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source, allowedModelIds: null, deliveryMode: "direct",
        } as const;
        const exact = projectTeamCredentialProviderModels({
            ...base,
            directMaterialReferences: [{ sourceMemberKey: "member-1", sourceVersion: "version-1" }],
        });
        expect(exact.models[0]?.direct).toEqual({
            sourceMemberKey: "member-1", sourceVersion: "version-1",
        });
        expect(projectTeamCredentialProviderModels({
            ...base,
            directMaterialReferences: [
                { sourceMemberKey: "member-1", sourceVersion: "version-1" },
                { sourceMemberKey: "member-2", sourceVersion: "version-2" },
            ],
        }).models[0]?.direct).toBeNull();
    });

    it("projects independent stable brokered and direct choices for the same model", () => {
        const base = {
            response: response(), resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source, allowedModelIds: null, deliveryMode: "brokered",
        } as const;
        const brokered = projectTeamCredentialProviderModels({ ...base, deliveryMode: "brokered" }).models[0]!;
        const preparingDirect = projectTeamCredentialProviderModels({ ...base, deliveryMode: "direct" }).models[0]!;
        const currentDirect = projectTeamCredentialProviderModels({
            ...base,
            deliveryMode: "direct",
            directMaterialReferences: [{ sourceMemberKey: "member-1", sourceVersion: "version-1" }],
        }).models[0]!;

        expect(brokered.selection).toMatchObject({ deliveryMode: "brokered" });
        expect(brokered.availability).toBe("available");
        expect(preparingDirect.selection).toMatchObject({ deliveryMode: "direct" });
        expect(preparingDirect.availability).toBe("source_owner_required");
        expect(currentDirect.selection).toMatchObject({ deliveryMode: "direct" });
        expect(currentDirect.availability).toBe("available");
        expect(brokered.selection).not.toEqual(currentDirect.selection);
    });
});

describe("projectTeamCredentialRequestPolicySupportModels", () => {
    it("keeps distinct policy revisions while excluding unavailable Pool members", () => {
        const row = response().groups[0]!.rows[0]!;
        const model = projectTeamCredentialRequestPolicySupportModels({
            status: "success", models: [{ ...row.requestPolicySupport, descriptor: row.descriptor }],
        })[0]!;
        const newer = { ...model, sourceRevision: "source-2" };
        expect(selectPoolBackedTeamCredentialRequestPolicySupportModels({
            members: [
                { machineId: "machine-a", priorityTier: 0, enabled: true },
                { machineId: "machine-b", priorityTier: 1, enabled: true },
            ],
            availableMachineIds: new Set(["machine-b"]),
            candidates: [
                { machineId: "machine-a", model: { ...model, sourceRevision: "unavailable-source" } },
                { machineId: "machine-b", model },
                { machineId: "machine-b", model: newer },
            ],
            requestKey: "policy-resource-1",
        })).toEqual([model, newer]);
    });

    it("projects only exact enforceable protocol and reasoning facts from current model rows", () => {
        const row = response().groups[0]!.rows[0]!;
        expect(projectTeamCredentialRequestPolicySupportModels({
            status: "success",
            models: [{ ...row.requestPolicySupport, descriptor: row.descriptor }],
        })).toEqual([expect.objectContaining({
            descriptor: expect.objectContaining({ id: "gpt-5" }),
            application,
            sourceRevision: "source-1",
            allowedProtocolKinds: ["openai_responses"],
            reasoningEffort: { allowedValues: ["low", "medium"], defaultValue: "medium" },
        })]);
    });

    it("fails closed for malformed daemon discovery and descriptor identity mismatch", () => {
        const row = response().groups[0]!.rows[0]!;
        expect(projectTeamCredentialRequestPolicySupportModels({
            status: "success",
            models: [{
                ...row.requestPolicySupport,
                descriptor: { ...row.descriptor, id: "different-model" },
            }],
        })).toEqual([]);
        expect(projectTeamCredentialRequestPolicySupportModels({
            status: "success",
            models: [{ ...row.requestPolicySupport, descriptor: row.descriptor, credential: "secret" }],
        })).toEqual([]);
        expect(projectTeamCredentialRequestPolicySupportModels({
            status: "unavailable",
            reason: "model_unavailable",
        })).toEqual([]);
    });
});

describe("selectPoolBackedTeamCredentialProviderModels", () => {
    it("retains a model only through the canonical Pool choice among source-eligible Machines", () => {
        const model = projectTeamCredentialProviderModels({
            response: response(), resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source, allowedModelIds: null, deliveryMode: "brokered",
        }).models[0]!;
        const selected = selectPoolBackedTeamCredentialProviderModels({
            members: [
                { machineId: "machine-a", priorityTier: 0, enabled: true },
                { machineId: "machine-b", priorityTier: 1, enabled: true },
            ],
            availableMachineIds: new Set(["machine-a", "machine-b"]),
            candidates: [
                { machineId: "machine-b", model },
            ],
            requestKey: "catalog-resource-1",
        });

        expect(selected).toEqual([model]);
        expect(JSON.stringify(selected)).not.toContain("machine-b");
        expect(selectPoolBackedTeamCredentialProviderModels({
            members: [{ machineId: "machine-a", priorityTier: 0, enabled: true }],
            availableMachineIds: new Set(["machine-a"]),
            candidates: [],
            requestKey: "catalog-resource-1",
        })).toEqual([]);
    });

    it("projects one canonical model row when Pool members observe different source revisions", () => {
        const model = projectTeamCredentialProviderModels({
            response: response(), resourceId: "resource-1", teamId: "team-1", resourceRevision: 7,
            agentTargetKey: application.agentTargetKey, application, source, allowedModelIds: null, deliveryMode: "brokered",
        }).models[0]!;
        const selected = selectPoolBackedTeamCredentialProviderModels({
            members: [
                { machineId: "machine-a", priorityTier: 0, enabled: true },
                { machineId: "machine-b", priorityTier: 1, enabled: true },
            ],
            availableMachineIds: new Set(["machine-a", "machine-b"]),
            candidates: [
                { machineId: "machine-a", model: { ...model, sourceRevision: "revision-a" } },
                { machineId: "machine-b", model: { ...model, sourceRevision: "revision-b" } },
            ],
            requestKey: "catalog-resource-1",
        });

        expect(selected).toHaveLength(1);
        expect(selected[0]?.sourceRevision).toBe("revision-a");
        expect(JSON.stringify(selected)).not.toContain("machine-");
    });
});
