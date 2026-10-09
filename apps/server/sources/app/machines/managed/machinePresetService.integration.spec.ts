import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { machinesRoutes } from "@/app/api/routes/machines/machinesRoutes";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx } from "@/storage/inTx";
import { resolveMachinePresetForAcquireInTx } from "./machinePresetService";
import { createReleaseLessDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";
import { admitManagedAcquire } from "./managedAcquire";
import { CRABBOX_PLUGIN } from '../../../../../../packages/plugins/machine-crabbox/src/manifest';
import { mutateQualifiedConnectedServiceCredential, deleteQualifiedConnectedServiceCredential, listQualifiedConnectedAccounts } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { defineProtocolObject, defineProtocolString } from "@happier-dev/protocol/plugins/actions/protocol-composable-schema";
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from "@happier-dev/protocol/plugins/contributions/machineProvisioners";

const recipe = { provider: { pluginId: "happier.machine.lima", localId: "lima" }, schemaVersion: 1, name: "Recipe guest", choices: { image: "linux" } };

async function seedCurrentProvisioner(accountId: string, homeId: string, credentialPurpose?: string | readonly string[]) {
    const credentialPurposes = typeof credentialPurpose === 'string' ? [credentialPurpose] : credentialPurpose ?? [];
    const controller = { machineId: `${accountId}-controller`, installationId: `${accountId}-installation` };
    await db.machine.create({ data: { id: controller.machineId, accountId, metadata: "{}", installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
    const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
    const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
    const roles = defineMachineProvisionerSchemas({ launch, resource: native });
    const actions = [
        { id: "check", inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        { id: "acquire", inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
        { id: "bootstrap", inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        { id: "inspect", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
        { id: "destroy", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        { id: "power", inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
    ];
    const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: recipe.provider.pluginId, version: "1.0.0", displayName: "Preset integration fixture",
        engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
        ...(credentialPurposes.length ? { hostAccess: { required: credentialPurposes.map(id => ({ id, capability: "connectedAccounts", reason: "Acquire native resource",
            scope: { serviceRefs: ["native-account"], operations: ["use"] } })), optional: [] } } : {}), contributes: {
            machineProvisioners: [{ id: recipe.provider.localId, title: "Guest", icon: "machine", resourceKind: "vm", schemaVersion: 1,
                launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema,
                platforms: ["linux"], prerequisites: [], billing: { location: "local", stoppedBilling: "not-billed" }, retention: { supportedIntents: ["start", "stop", "delete"] },
                actions: { check: "check", acquire: "acquire", bootstrap: "bootstrap", inspect: "inspect", power: "power", destroy: "destroy" } }],
            actions: actions.map(action => ({ ...action, title: action.id, execution: { target: "daemon" },
                surfaces: ["plugin"], scopes: ["global"], dangerLevel: "safe", ...(action.id === "acquire" && credentialPurposes.length ? { hostAccess: credentialPurposes } : {}) })),
        } });
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId,
        pluginId: manifest.id, version: manifest.version, sourceClass: "bundledFirstParty", portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: "trusted", observedAt: new Date() } });
    return controller;
}

async function requestPreset(accountId: string, operation: string, payload: object) {
    const app = createAuthenticatedTestApp();
    machinesRoutes(app);
    await app.ready();
    try {
        return await app.inject({ method: "POST", url: `/v1/machines/presets/${operation}`, headers: { "x-test-user-id": accountId }, payload });
    } finally { await app.close(); }
}

describe("Machine preset relational owner", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-presets-", initAuth: false, initEncrypt: true });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    it('saves and admits direct Crabbox without a coordinator but refuses an unbound coordinator recipe', async () => {
        const accountId = 'preset-crabbox-direct-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = { machineId: `${accountId}-controller`, installationId: `${accountId}-installation` };
        await db.machine.create({ data: { id: controller.machineId, accountId, metadata: '{}', installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
        const manifest = PluginManifestV2Schema.parse(CRABBOX_PLUGIN.manifest);
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId,
            pluginId: manifest.id, version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const localRecipe = { provider: { pluginId: manifest.id, localId: 'crabbox' }, schemaVersion: 1, name: 'Local container',
            choices: { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } };
        const input = { id: 'preset-crabbox-direct', homeId, owner: { kind: 'account', accountId }, name: 'Local container', recipe: localRecipe, controller };
        expect((await requestPreset(accountId, 'create', input)).json()).toMatchObject({ kind: 'saved', preset: { recipe: localRecipe } });
        const acquired = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: 'crabbox-direct-reviewed',
            input: { requestId: 'crabbox-direct-create', continuationPresent: false, input: { selection: { kind: 'one-off', homeId, controller,
                launch: localRecipe, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } } });
        expect(acquired).toMatchObject({ machine: { launch: localRecipe } });
        const coordinatorRecipe = { ...localRecipe, choices: { backendId: 'aws', transport: 'coordinator', namespace: 'remote', target: 'linux',
            nativeImageId: 'ami-selected', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } };
        expect((await requestPreset(accountId, 'create', { ...input, id: 'preset-crabbox-coordinator', recipe: coordinatorRecipe })).json())
            .toEqual({ kind: 'refused', code: 'credential_unavailable' });
    });

    it("lists accessible future recipes through the authenticated Machine route owner", async () => {
        await db.account.create({ data: { id: "preset-http-owner", publicKey: null, encryptionMode: "plain" } });
        const homeId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST", url: "/v1/machines/presets/list",
                headers: { "x-test-user-id": "preset-http-owner" }, payload: { homeId },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ kind: "listed", presets: [] });
        } finally {
            await app.close();
        }
    });

    it("saves only declared choices without allocation and projects future stored choice fields away", async () => {
        const accountId = "preset-create-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const input = { id: "preset-create", homeId, owner: { kind: "account", accountId }, name: "Recipe", recipe, controller };
        const before = await db.managedMachine.count();
        const invalid = await requestPreset(accountId, "create", { ...input, recipe: { ...recipe, choices: { image: "linux", injected: true } } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ kind: "refused", code: "invalid_request" });
        expect(await db.managedMachinePreset.findUnique({ where: { id: input.id } })).toBeNull();
        const created = await requestPreset(accountId, "create", input);
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ kind: "saved", preset: { id: input.id, revision: 0, recipe } });
        expect((await requestPreset(accountId, "create", input)).json()).toEqual(created.json());
        expect(await db.managedMachine.count()).toBe(before);
        await db.managedMachinePreset.update({ where: { id: input.id }, data: { launch: { ...recipe, choices: { image: "linux", futureChoice: true } } } });
        expect((await requestPreset(accountId, "get", { homeId, id: input.id })).json().preset.recipe.choices).toEqual({ image: "linux" });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: recipe.provider.pluginId } }, data: { enabled: false } });
        expect((await requestPreset(accountId, "create", { ...input, id: "preset-stale-provider" })).json()).toEqual({ kind: "refused", code: "provider_unavailable" });
    });

    it("requires the acquire role's actual credential purpose and denies removed profiles without material disclosure", async () => {
        const accountId = "preset-credential-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId, "acquire-authentication");
        const input = { id: "preset-credential", homeId, owner: { kind: "account", accountId }, name: "Credential recipe", recipe, controller };
        expect((await requestPreset(accountId, "create", input)).json()).toEqual({ kind: "refused", code: "credential_unavailable" });
        const ref = { service: { pluginId: recipe.provider.pluginId, localId: "native-account" }, accountId: "native-profile" };
        const written = await mutateQualifiedConnectedServiceCredential({ accountId, ref, expectedCredentialRevision: null,
            authenticationModeId: "api-key", content: { t: "plain", v: { token: "must-not-disclose" } }, metadata: { displayName: "Native profile" } });
        expect(written.status).toBe("written");
        expect(await listQualifiedConnectedAccounts({ accountId, service: ref.service })).toMatchObject([{ ref, status: "connected", revisionSemantics: "revisioned" }]);
        const selected = { ...recipe, credentials: [{ purpose: { consumer: recipe.provider, purpose: "acquire-authentication" }, account: ref }] };
        const saved = await requestPreset(accountId, "create", { ...input, recipe: selected });
        expect(saved.json(), saved.body).toMatchObject({ kind: "saved", preset: { recipe: selected } });
        expect(saved.statusCode).toBe(200);
        expect(saved.body).not.toContain("must-not-disclose");
        const reviewed = { selection: { kind: "preset" as const, homeId, id: input.id, revision: 0 }, controller, retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false };
        if (written.status !== "written") throw new Error("Credential fixture was not written");
        expect(await deleteQualifiedConnectedServiceCredential({ accountId, ref, expectedCredentialRevision: written.credentialRevision })).toMatchObject({ status: "deleted" });
        expect((await requestPreset(accountId, "create", { ...input, id: "preset-removed-profile", recipe: selected })).json()).toEqual({ kind: "refused", code: "credential_unavailable" });
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-removed-profile", input: { input: reviewed, requestId: "removed-profile", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "credential_unavailable" });
        expect(await db.managedMachine.count({ where: { presetId: input.id } })).toBe(0);
    });

    it('saves and acquires each distinct purpose once and refuses a removed secondary Account', async () => {
        const accountId = 'preset-plural-credential-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const purposes = ['cloud', 'cua'];
        const controller = await seedCurrentProvisioner(accountId, homeId, purposes);
        const credentials = purposes.map(purpose => ({ purpose: { consumer: recipe.provider, purpose },
            account: { service: { pluginId: recipe.provider.pluginId, localId: 'native-account' }, accountId: `native-${purpose}` } }));
        const written = await Promise.all(credentials.map(credential => mutateQualifiedConnectedServiceCredential({ accountId, ref: credential.account,
            expectedCredentialRevision: null, authenticationModeId: 'api-key', content: { t: 'plain', v: { token: `private-${credential.account.accountId}` } },
            metadata: { displayName: credential.account.accountId } })));
        const selected = { ...recipe, credentials };
        const definition = { id: 'preset-plural-credential', homeId, owner: { kind: 'account', accountId }, name: 'Plural recipe', recipe: selected, controller };
        expect((await requestPreset(accountId, 'create', { ...definition, recipe: { ...selected, credentials: credentials.slice(0, 1) } })).json())
            .toEqual({ kind: 'refused', code: 'credential_unavailable' });
        const saved = await requestPreset(accountId, 'create', definition);
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: { recipe: selected } });
        expect(saved.body).not.toContain('private-native');
        const reviewed = { selection: { kind: 'preset' as const, homeId, id: definition.id, revision: 0 }, controller,
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const admitted = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: 'plural-reviewed', input: { input: reviewed, requestId: 'plural-acquire', continuationPresent: false } });
        expect(admitted.machine.launch.credentials).toEqual(credentials);
        const secondary = written[1];
        if (secondary?.status !== 'written') throw new Error('Secondary credential fixture was not written');
        await deleteQualifiedConnectedServiceCredential({ accountId, ref: credentials[1]!.account, expectedCredentialRevision: secondary.credentialRevision });
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: 'plural-removed', input: { input: reviewed, requestId: 'plural-after-removal', continuationPresent: false } }))
            .rejects.toMatchObject({ code: 'credential_unavailable' });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } })).launch).toEqual(selected);
    });
    it("admits one resource under concurrent preset cap and replays it after archive without admitting another", async () => {
        const accountId = "preset-admission-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const created = await requestPreset(accountId, "create", { id: "preset-admission", homeId, owner: { kind: "account", accountId }, name: "Limited", recipe, controller, simultaneousLimit: { maximum: 1 } });
        expect(created.statusCode).toBe(200);
        const reviewed = { selection: { kind: "preset" as const, homeId, id: "preset-admission", revision: 0 }, controller,
            retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch: recipe, controller, optionStatus: "current" as const, prerequisites: [{ requirement: { kind: "systemTool" as const, id: "native-cli" }, status: "available" as const }],
                billing: { location: "local" as const, stoppedBilling: "not-billed" as const }, retentionCapabilities: { supportedIntents: ["start" as const, "stop" as const, "delete" as const] },
                retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false, prices: [{ amount: "0", currency: "USD", unit: "hour", source: "native", observedAt: 17 }],
                preset: { id: "preset-admission", revision: 0, name: "Limited" } } };
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-preset-mismatch", input: { input: { ...reviewed,
            reviewedFacts: { ...reviewed.reviewedFacts, launch: { ...recipe, choices: { image: "unreviewed" } } } }, requestId: "preset-mismatched-facts", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "invalid_request" });
        expect(await db.managedMachine.count({ where: { presetId: "preset-admission" } })).toBe(0);
        const requests = ["preset-admit-one", "preset-admit-two"];
        // The signed Action transport is the genuine external authority boundary; its verified digest is an input to this owner.
        const results = await Promise.allSettled(requests.map(requestId => admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: `verified-${requestId}`, input: { input: reviewed, requestId, continuationPresent: false } })));
        const admitted = results.flatMap((result, index) => result.status === "fulfilled" ? [{ ...result.value, requestId: requests[index] }] : []);
        expect(admitted).toHaveLength(1);
        expect(results.filter(result => result.status === "rejected").map(result => result.reason)).toEqual([expect.objectContaining({ code: "preset_limit_reached" })]);
        expect(await db.managedMachine.count({ where: { presetId: "preset-admission" } })).toBe(1);
        const captured = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted[0].machine.id } });
        expect(captured.reviewedFacts).toEqual(reviewed.reviewedFacts);
        expect((await requestPreset(accountId, "archive", { homeId, id: "preset-admission", expectedRevision: 0 })).statusCode).toBe(200);
        const replayed = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: `verified-${admitted[0].requestId}`, input: { input: reviewed, requestId: admitted[0].requestId, continuationPresent: false } });
        expect(replayed.replayed).toBe(true);
        expect(replayed.machine.id).toBe(admitted[0].machine.id);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: captured.id } })).reviewedFacts).toEqual(captured.reviewedFacts);
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-after-archive", input: { input: { ...reviewed, selection: { ...reviewed.selection, revision: 1 }, reviewedFacts: { ...reviewed.reviewedFacts, preset: { ...reviewed.reviewedFacts.preset, revision: 1 } } }, requestId: "preset-after-archive", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "preset_archived" });
    });

    it("reads stored extras, clears future overrides, conflicts on stale edits, and archives without changing paid resources", async () => {
        const accountId = "preset-mutation-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.managedMachinePreset.create({ data: {
            id: "preset-mutation", homeId, custodianAccountId: accountId, name: "Before",
            launch: { ...recipe, futureEnvelope: "ignore" }, controllerMachineId: "controller", controllerInstallationId: "installation",
            retentionOverride: { kind: "until-delete" }, wakeOnAcceptedMessage: true, simultaneousMaximum: 1,
        } });
        const resource = await db.managedMachine.create({ data: {
            id: "preset-paid", homeId, custodianAccountId: accountId, presetId: "preset-mutation", presetRevision: 0,
            controllerMachineId: "controller", controllerInstallationId: "installation", admittedActionRequestId: "prior-admission",
            admittedInput: { retained: true }, launch: recipe, allocation: "bound", resource: { nativeId: "immutable-paid-id" },
            retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
        } });
        const read = await requestPreset(accountId, "get", { homeId, id: "preset-mutation" });
        expect(read.statusCode).toBe(200);
        expect(read.json().preset.recipe).toEqual(recipe);
        const updated = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 0,
            patch: { name: "After", retention: null, wakeOnAcceptedMessage: null, simultaneousLimit: null } });
        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toMatchObject({ kind: "saved", preset: { revision: 1, name: "After" } });
        expect(updated.json().preset).not.toHaveProperty("retention");
        expect(updated.json().preset).not.toHaveProperty("wakeOnAcceptedMessage");
        expect(updated.json().preset).not.toHaveProperty("simultaneousLimit");
        const unchanged = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 1, patch: { name: "After" } });
        expect(unchanged.json()).toEqual(updated.json());
        const stale = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 0, patch: { name: "Stale" } });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ kind: "conflict", currentRevision: 1 });
        const archived = await requestPreset(accountId, "archive", { homeId, id: "preset-mutation", expectedRevision: 1 });
        expect(archived.json()).toMatchObject({ kind: "saved", preset: { revision: 2, archivedAt: expect.any(Number) } });
        expect((await requestPreset(accountId, "list", { homeId })).json().presets).toEqual([]);
        expect((await requestPreset(accountId, "list", { homeId, includeArchived: true })).json().presets).toHaveLength(1);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: "preset-mutation", revision: 2 })))
            .resolves.toEqual({ kind: "refused", code: "preset_archived" });
        const restored = await requestPreset(accountId, "restore", { homeId, id: "preset-mutation", expectedRevision: 2 });
        expect(restored.json()).toMatchObject({ kind: "saved", preset: { revision: 3 } });
        expect(restored.json().preset).not.toHaveProperty("archivedAt");
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
    });

    it("uses current Team membership, never Home administration, for preset read and management", async () => {
        const homeId = await getOrCreateServerIdentityId();
        await db.account.createMany({ data: ["preset-team-admin", "preset-team-member", "preset-home-admin"].map(id => ({ id, publicKey: null, encryptionMode: "plain" })) });
        await db.account.update({ where: { id: "preset-home-admin" }, data: { homeRole: "admin" } });
        const team = await db.team.create({ data: { name: "Preset Team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: "preset-team-admin", role: "admin" },
            { teamId: team.id, accountId: "preset-team-member", role: "member" },
        ] });
        const controller = await seedCurrentProvisioner("preset-team-admin", homeId);
        await db.managedMachinePreset.create({ data: { id: "preset-team", homeId, teamId: team.id, name: "Team recipe", launch: recipe,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId } });
        const target = { homeId, id: "preset-team" };
        expect((await requestPreset("preset-team-member", "get", target)).statusCode).toBe(200);
        expect((await requestPreset("preset-home-admin", "get", target)).statusCode).toBe(404);
        expect((await requestPreset("preset-team-member", "archive", { ...target, expectedRevision: 0 })).statusCode).toBe(404);
        expect((await requestPreset("preset-team-admin", "update", { ...target, expectedRevision: 0, patch: { name: "Managed" } })).statusCode).toBe(200);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", ...target, revision: 1 })))
            .rejects.toMatchObject({ code: "permission_denied" });
        await db.machineAccountGrant.create({ data: { machineId: controller.machineId, accountId: "preset-team-member", accessLevel: "admin", createdByAccountId: "preset-team-admin" } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", ...target, revision: 1 })))
            .resolves.toMatchObject({ kind: "ready", custodianAccountId: "preset-team-admin" });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: "preset-team-member" } }, data: { status: "suspended" } });
        expect((await requestPreset("preset-team-member", "get", target)).statusCode).toBe(404);
        expect((await requestPreset("preset-team-member", "list", { homeId, owner: { kind: "team", teamId: team.id } })).json().presets).toEqual([]);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", homeId, id: target.id, revision: 1 })))
            .resolves.toEqual({ kind: "refused", code: "preset_not_found" });
    });

    it("counts uncertain and retained stopped resources until confirmed absence, independent of archive", async () => {
        const accountId = "preset-cap-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.managedMachinePreset.create({ data: { id: "preset-cap", homeId, custodianAccountId: accountId, name: "Limited",
            launch: recipe, controllerMachineId: "controller", controllerInstallationId: "installation", simultaneousMaximum: 1 } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: accountId, presetId: "preset-cap", presetRevision: 0,
            controllerMachineId: "controller", controllerInstallationId: "installation", admittedActionRequestId: "capacity-admission",
            admittedInput: {}, launch: recipe, allocation: "may-exist", retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false } });
        const use = () => inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: "preset-cap", revision: 0 }));
        await expect(use()).resolves.toEqual({ kind: "refused", code: "preset_limit_reached" });
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: "bound", archivedAt: new Date(), observation: { availability: "present", power: "stopped", observedAt: Date.now() } } });
        await expect(use()).resolves.toEqual({ kind: "refused", code: "preset_limit_reached" });
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: "confirmed-absent" } });
        // No controller was seeded: reaching current-controller validation proves capacity was released, without mocking acquisition.
        await expect(use()).rejects.toMatchObject({ code: "permission_denied" });
    });
});
