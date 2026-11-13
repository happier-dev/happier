import Fastify from "fastify";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "@happier-dev/protocol/crypto/base64";

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { createArtifact } from "@/app/artifacts/artifactWriteService";
import { createProjectSourceInTx } from "@/app/projects/sources/projectSourceService";
import { addTeamGroupMemberForActorInTx, createTeamGroupForActorInTx } from "@/app/teams/groups/groupService";
import { canDeployDeploymentEnvironment } from "@/app/deployments/deploymentAdmission";
import { loadDeploymentEnvironmentInTx } from "@/app/deployments/deploymentEnvironmentService";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    API_TOKEN_FULL_GRANT_V1,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    decodeBase64,
    DeploymentDeployInputV1Schema,
    encodePlainArtifactStoredContent,
    parseAccountApiTokenBearerV1,
} from "@happier-dev/protocol";

const apiTokenAuth = auth;
const fullGrantProjection = { grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, embedConfig: null };

const UNKNOWN_API_TOKEN = `hap_v1_550e8400-e29b-41d4-a716-446655440000_${"A".repeat(43)}`;

describe("auth (API tokens)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-tokens-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        harness.resetEnv();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function withAuthenticatedApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
        const app = Fastify({ logger: false });
        enableAuthentication(app as any);
        app.get("/private", {
            // This fixture represents an explicit PAT-capable boundary. The
            // decorator's ordinary default remains deny-by-default.
            config: { allowApiToken: true },
            preHandler: (app as any).authenticate,
        }, async (request: any) => ({
            authority: request.authAuthority,
            tokenKind: request.authTokenKind,
            apiTokenPrincipal: request.apiTokenPrincipal,
        }));
        await app.ready();
        try {
            await run(app);
        } finally {
            await app.close();
        }
    }

    it("collapses malformed and unknown bearer credentials into the same opaque invalid_token response", async () => {
        await withAuthenticatedApp(async (app) => {
            const responses = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: "Bearer hap_v1_malformed" },
                }),
                app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: `Bearer ${UNKNOWN_API_TOKEN}` },
                }),
            ]);

            for (const response of responses) {
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }
        });
    });

    it("mints a one-time plaintext token, verifies its account-automation provenance, lists summaries, and revokes by deletion", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-lifecycle" },
            select: { id: true },
        });

        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "CI deploy",
        });
        const parsed = parseAccountApiTokenBearerV1(minted.token);
        expect(parsed).not.toBeNull();
        const secret = parsed?.secret ?? "";

        expect(minted.token).toMatch(/^hap_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
        expect(minted.displayPrefix).toBe(`hap_v1_${minted.tokenId.slice(0, 8)}`);
        expect(minted.hasEncryptionAccess).toBe(false);
        await expect(auth.verifyToken(minted.token)).resolves.toEqual({
            userId: account.id,
            authority: "account_automation",
            authTokenKind: "api_token",
            legacy: false,
            apiTokenPrincipal: {
                accountId: account.id,
                principalId: account.id,
                credentialId: minted.tokenId,
                authority: "account_automation",
                expiresAt: null,
                ...fullGrantProjection,
            },
        });

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                authority: "account_automation",
                tokenKind: "api_token",
                apiTokenPrincipal: {
                    accountId: account.id,
                    principalId: account.id,
                    credentialId: minted.tokenId,
                    authority: "account_automation",
                    expiresAt: null,
                    ...fullGrantProjection,
                },
            });
        });

        const stored = await db.accountApiToken.findUnique({
            where: { id: minted.tokenId },
            select: { secretDigest: true, displayPrefix: true },
        });
        expect(stored).not.toBeNull();
        expect(stored?.secretDigest).not.toContain(secret);
        expect(stored?.secretDigest).not.toBe(secret);
        expect(stored?.displayPrefix).toBe(minted.displayPrefix);

        await expect(apiTokenAuth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({
                tokenId: minted.tokenId,
                label: "CI deploy",
                displayPrefix: minted.displayPrefix,
                lastUsedAt: expect.any(Date),
                expiresAt: null,
                hasEncryptionAccess: false,
            }),
        ]);
        const listed = await apiTokenAuth.listApiTokens(account.id);
        expect(JSON.stringify(listed)).not.toContain(minted.token);
        expect(JSON.stringify(listed)).not.toContain(stored?.secretDigest ?? "");

        await expect(apiTokenAuth.revokeApiToken({
            accountId: account.id,
            tokenId: minted.tokenId,
        })).resolves.toEqual({ revoked: true, revokedTokenIds: [minted.tokenId] });
        await expect(auth.verifyToken(minted.token)).resolves.toBeNull();

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        });
    });

    it.each(['plain', 'e2ee'] as const)("stores Automatic in the narrow grant and withdraws it on Ask, grant change and revoke (%s)", async (encryptionMode) => {
        const account = await db.account.create({ data: { publicKey: `token-deployment-consent-${encryptionMode}`, encryptionMode } });
        const tokenId = crypto.randomUUID();
        const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: false,
            actions: { families: [], ids: ["deployments.deploy", "action.operations.get"] },
            targets: { sessions: [], machines: [], environments: ["staging"] }, create: null };
        const serverId = await (await import("@/app/serverIdentity/serverIdentity")).getOrCreateServerIdentityId();
        const deployment = { serverId, environmentId: "staging", deployApproval: "automatic" as const };
        await expect(apiTokenAuth.createApiToken(Object.assign({ accountId: account.id, tokenId,
            label: "Staging CI", grant },
            { deployment: { ...deployment, serverId: "unapproved-home" } })))
            .rejects.toMatchObject({ code: "credential_scope_denied" });
        const minted = await apiTokenAuth.createApiToken(Object.assign({ accountId: account.id, tokenId,
            label: "Staging CI", grant }, { deployment }));
        expect(minted.grant).toMatchObject({ deployApproval: 'automatic' });
        expect(await db.accountApiToken.findUnique({ where: { id: tokenId } })).toMatchObject({ accessGrant: { deployApproval: 'automatic' } });
        const principal = (await apiTokenAuth.verifyToken(minted.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Expected token principal');
        await expect(apiTokenAuth.createChildApiToken({ principal, tokenId: crypto.randomUUID(), label: 'Child',
            expiresAt: new Date(Date.now() + 60_000), grant: minted.grant })).resolves.toMatchObject({
                parentTokenId: minted.tokenId, grant: minted.grant,
            });
        await apiTokenAuth.updateApiToken(Object.assign({ accountId: account.id, tokenId },
            { deployment: { ...deployment, deployApproval: "ask" as const } }));
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.grant).not.toHaveProperty('deployApproval');
        // A stale principal cannot recreate Automatic after the parent withdrew it.
        await expect(apiTokenAuth.createChildApiToken({ principal, tokenId: crypto.randomUUID(), label: 'Stale child',
            expiresAt: new Date(Date.now() + 60_000), grant: minted.grant })).rejects.toMatchObject({ code: 'api_token_child_invalid' });
        // An Automatic update without a grant retains the current narrow grant.
        await apiTokenAuth.updateApiToken(Object.assign({ accountId: account.id, tokenId }, { deployment }));
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.grant).toMatchObject({ deployApproval: 'automatic' });
        await expect(apiTokenAuth.updateApiToken({ accountId: account.id, tokenId,
            grant: { ...API_TOKEN_FULL_GRANT_V1 }, deployment })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await apiTokenAuth.updateApiToken({ accountId: account.id, tokenId, grant: { ...grant,
            targets: { sessions: [], machines: [], environments: ["other"] } } });
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.grant).not.toHaveProperty('deployApproval');
        await apiTokenAuth.revokeApiToken({ accountId: account.id, tokenId });
        await expect(apiTokenAuth.verifyToken(minted.token)).resolves.toBeNull();
    });

    it("uses one captured creation time when validating and persisting a near-boundary expiry", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-single-expiry-clock" },
            select: { id: true },
        });
        const creationTime = new Date("2026-08-22T12:00:00.000Z");
        const expiresAt = new Date("2026-08-22T12:00:00.001Z");
        vi.setSystemTime(new Date("2026-08-22T12:00:05.000Z"));

        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Boundary expiry",
            expiresAt,
        }, creationTime);

        expect(minted.createdAt).toEqual(creationTime);
        expect(minted.expiresAt).toEqual(expiresAt);
    });

    it("binds Environment-only operation reads to the current token scope and requested original host", async () => {
        const serverId = `srv_${"f".repeat(32)}`;
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "", AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            HAPPIER_SERVER_IDENTITY_ID: serverId });
        const account = await db.account.create({ data: {
            publicKey: "deployment-token-operation-observation", encryptionMode: "plain",
        } });
        const machineId = "original-deployment-host";
        await db.machine.createMany({ data: [machineId, 'new-controller'].map(id => ({
            id, accountId: account.id, metadata: "{}", installationId: `${id}-installation`,
        })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'CI observation', audience: [],
            owner: { kind: 'account', accountId: account.id },
        }));
        if (!source.ok) throw new Error(source.error);
        const content = await createArtifact({ actorUserId: account.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'CI observation' })),
            body: decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!content.ok) throw new Error(content.error);
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: account.id, protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
            contentArtifactId: content.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: 'new-controller' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ["deployments.deploy", "action.operations.get"] },
            targets: { sessions: [], machines: [], environments: ['another-granted-environment', environment.id] },
            approve: false, create: null,
        };
        const minted = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(),
            label: "Exact Environment deployment", grant });
        const principal = await auth.verifyPat(minted.token);
        if (!principal.ok) throw new Error("The real token issuer must produce an admitted principal");
        const request = { accountId: account.id, principalId: principal.principalId,
            credentialId: principal.credentialId, grant: principal.grant, serverIdentityId: serverId,
            machineId, actionId: "action.operations.get" as const, requestId: "observe-original-operation",
            requestEnvelopeDigest: "a".repeat(43), target: { kind: "machine" as const, machineId },
        };
        const context = { input: { serverId, machineId, operationId: "pre-receipt-operation", environmentId: environment.id } };

        // The explicit Environment is grant-checked; the retained operation
        // owner checks origin. Neither a singleton grant nor the new controller
        // supplies the original operation's host or Environment.
        try {
            const root = await auth.mintExternalActionExecutionAuthorization(request, context);
            expect(root.binding).toMatchObject({ credentialId: minted.tokenId, environmentId: environment.id, machineId,
                target: { kind: "machine", machineId }, grant: { approve: false, targets: { machines: [] } } });
            expect(root.binding).not.toHaveProperty("workflowActionOrigin");
            expect(root.binding).not.toHaveProperty('deploymentCandidatePublication');
            const { environmentId: _environmentId, ...unscoped } = context.input;
            await expect(auth.mintExternalActionExecutionAuthorization(request, { input: unscoped }))
                .rejects.toMatchObject({ code: 'credential_scope_denied' });
            await expect(auth.mintExternalActionExecutionAuthorization({ ...request, environmentId: 'another-granted-environment' }, context))
                .rejects.toMatchObject({ code: 'credential_scope_denied' });

            await auth.revokeApiToken({ accountId: account.id, tokenId: minted.tokenId });
            await expect(auth.mintExternalActionExecutionAuthorization(request, context))
                .rejects.toMatchObject({ code: "invalid_token" });
        } finally {
            await db.deploymentEnvironment.delete({ where: { id: environment.id } });
            await db.projectSource.delete({ where: { id: source.source.id } });
            await db.artifact.delete({ where: { id: content.artifact.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
        }
    });

    it.each(["members", "chosen"] as const)("admits restricted-Team deployment roots only with the current API token's own qualified evidence (%s)", async (deployerMode) => {
        const serverId = `srv_${"e".repeat(32)}`;
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "", AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_SERVER_IDENTITY_ID: serverId });
        const [creator, actor] = await Promise.all(["creator", "actor"].map(label => db.account.create({
            // Key Challenge is a keyed-Account method; a plain Account cannot supply this evidence.
            data: { publicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey),
                encryptionMode: label === "actor" ? "e2ee" : "plain" },
        })));
        const team = await db.team.create({ data: { name: "Restricted deployment" } });
        try {
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: creator.id, role: "owner" },
                { teamId: team.id, accountId: actor.id, role: "member" },
            ] });
            let selectedGroupId: string | undefined;
            if (deployerMode === "chosen") {
                const group = await inTx(tx => createTeamGroupForActorInTx(tx, { teamId: team.id,
                    actorAccountId: creator.id, name: "CI deployers", requestKey: crypto.randomUUID() }));
                if (!group.ok) throw new Error(group.error);
                const added = await inTx(tx => addTeamGroupMemberForActorInTx(tx, { teamId: team.id,
                    actorAccountId: creator.id, groupId: group.value.id, accountId: actor.id,
                    historyAccess: "from_membership" }));
                if (!added.ok) throw new Error(added.error);
                selectedGroupId = group.value.id;
            }
            const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
                serverId, requestKey: crypto.randomUUID(), name: "Restricted CI", audience: [],
                owner: { kind: "team", teamId: team.id },
            }));
            if (!source.ok) throw new Error(source.error);
            const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
                metadata: "{}", installationId: crypto.randomUUID() } });
            await db.machineGrant.create({ data: { principalKind: 'team', machineId: machine.id, teamId: team.id,
                accessLevel: "view", createdByAccountId: creator.id } });
            const content = async (kind: string) => {
                const created = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
                    header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: "Restricted CI" })),
                    body: decodeBase64(encodePlainArtifactStoredContent({})),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!created.ok) throw new Error(created.error);
                await db.artifactTeamGrant.create({ data: { artifactId: created.artifact.id, teamId: team.id,
                    accessLevel: "admin", createdByAccountId: creator.id } });
                return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
            };
            const reference = await content("deployment-environment.v1");
            const environment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: source.source.id, createdByAccountId: creator.id, protection: "nonProduction",
                purpose: "standard", deployerMode, controllerMachineId: machine.id, ...reference,
            } });
            if (selectedGroupId) await db.deploymentEnvironmentDeployer.create({ data: { environmentId: environment.id,
                principalKind: "teamGroup", principalId: selectedGroupId, createdByAccountId: creator.id } });
            const target = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: creator.id, role: "runtime", sourceKind: "host", hostTargetId: "own-server",
                targetKind: "ownServer", state: "deployed", ...await content("deployment-target-link.v1") } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: target.id } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } } });
            const authenticationEvidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];
            const minted = await auth.createApiToken({ accountId: actor.id, tokenId: crypto.randomUUID(),
                label: "Restricted CI", authenticationEvidence, grant: { ...API_TOKEN_FULL_GRANT_V1,
                    actions: { families: [], ids: ["deployments.deploy"] },
                    targets: { sessions: [], machines: [], environments: [environment.id] }, approve: false, create: null,
                } });
            const verified = await auth.verifyToken(minted.token);
            const principal = verified?.apiTokenPrincipal;
            if (!principal) throw new Error("Expected the real token owner's principal");
            expect(principal).toMatchObject({ accountId: actor.id, authenticationEvidence });
            expect(principal.accountId).not.toBe(creator.id);
            const admitted = await loadDeploymentEnvironmentInTx(db, actor.id, serverId, environment.id, {
                authenticationAuthority: "account_automation", authenticationEvidence: principal.authenticationEvidence,
            });
            if (!admitted.ok) throw new Error("Current own evidence must satisfy the canonical Source owner");
            expect(canDeployDeploymentEnvironment(admitted.admission, admitted.row)).toBe(true);
            expect(await loadDeploymentEnvironmentInTx(db, actor.id, serverId, environment.id)).toMatchObject({ ok: false });
            const input = DeploymentDeployInputV1Schema.parse({ serverId, environmentId: environment.id,
                expectedRevision: environment.revision, targetLinkId: target.id, expectedTargetLinkRevision: target.revision,
                requestKey: crypto.randomUUID(), ...reference });
            const request = { accountId: actor.id, principalId: principal.principalId,
                credentialId: principal.credentialId, grant: principal.grant, serverIdentityId: serverId,
                machineId: machine.id, actionId: "deployments.deploy" as const, requestId: crypto.randomUUID(),
                requestEnvelopeDigest: "b".repeat(43), target: { kind: "machine" as const, machineId: machine.id } };
            const unqualified = await auth.createApiToken({ accountId: actor.id, tokenId: crypto.randomUUID(),
                label: "CI without own evidence", grant: minted.grant });
            await expect(auth.mintExternalActionExecutionAuthorization({ ...request,
                credentialId: unqualified.tokenId }, { input })).rejects.toMatchObject({ code: "credential_scope_denied" });
            await expect(auth.mintExternalActionExecutionAuthorization(request, { input })).resolves.toMatchObject({
                binding: { accountId: actor.id, credentialId: minted.tokenId, environmentId: environment.id },
            });
            // The creator still has a key; only this token's current Account evidence may admit the next root.
            await db.account.update({ where: { id: actor.id }, data: { publicKey: null } });
            await expect(auth.mintExternalActionExecutionAuthorization(request, { input }))
                .rejects.toMatchObject({ code: "credential_scope_denied" });
        } finally {
            await db.deploymentEnvironment.updateMany({ where: { createdByAccountId: creator.id },
                data: { runtimeTargetLinkId: null } });
            await db.deploymentEnvironmentDeployer.deleteMany({ where: { environment: { createdByAccountId: creator.id } } });
            await db.deploymentTargetLink.deleteMany({ where: { createdByAccountId: creator.id } });
            await db.deploymentEnvironment.deleteMany({ where: { createdByAccountId: creator.id } });
            await db.projectSource.deleteMany({ where: { createdByAccountId: creator.id } });
            await db.artifact.deleteMany({ where: { accountId: creator.id } });
            await db.machine.deleteMany({ where: { accountId: creator.id } });
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it("exposes a PAT-only verification seam with stable credential provenance", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-pat-only-seam" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Daemon cache",
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
        });
        const signedAccountToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

        await expect(apiTokenAuth.verifyPat(minted.token)).resolves.toEqual({
            ok: true,
            accountId: account.id,
            principalId: account.id,
            credentialId: minted.tokenId,
            expiresAt: new Date("2026-08-22T13:00:00.000Z"),
            authority: "account_automation",
            ...fullGrantProjection,
        });
        await expect(apiTokenAuth.verifyPat(signedAccountToken)).resolves.toEqual({
            ok: false,
            reason: "invalid_token",
        });
    });

    it("writes canonical full grants and refuses missing or malformed stored grants", async () => {
        const account = await db.account.create({ data: { publicKey: 'canonical-grant-reader' } });
        const token = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: 'Canonical' });
        expect(await db.accountApiToken.findUniqueOrThrow({ where: { id: token.tokenId }, select: { accessGrant: true } }))
            .toEqual({ accessGrant: API_TOKEN_FULL_GRANT_V1 });
        expect(await auth.verifyPat(token.token)).toMatchObject({ ok: true, ...fullGrantProjection });
        await db.accountApiToken.update({ where: { id: token.tokenId }, data: { accessGrant: getActivePrismaRuntime().DbNull } });
        expect(await auth.verifyPat(token.token)).toEqual({ ok: false, reason: 'invalid_token' });
        await expect(auth.listApiTokens(account.id)).rejects.toMatchObject({ code: 'invalid_token' });
        await db.accountApiToken.update({ where: { id: token.tokenId }, data: { accessGrant: { v: 99 } } });
        expect(await auth.verifyPat(token.token)).toEqual({ ok: false, reason: 'invalid_token' });
        await expect(auth.listApiTokens(account.id)).rejects.toMatchObject({ code: 'invalid_token' });
    });

    it("reads stored presentation config by known fields while permission grants fail closed and writes remain strict", async () => {
        const account = await db.account.create({ data: { publicKey: 'stored-grant-projection' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['s1'], machines: [] } };
        const embedConfig = {
            v: 1 as const,
            ui: { attachments: true },
            newChat: { enabled: false },
            organization: { folderId: null, tagIds: [] },
            style: { v: 1 as const, typography: { fontFamily: 'Inter' }, parts: { composer: { radius: 'md' as const } } },
        };
        const minted = await auth.createApiToken({
            accountId: account.id, tokenId: crypto.randomUUID(), label: 'Stored projection', grant, embedConfig,
        });
        const storedGrant = { ...grant, ignored: true, targets: { ...grant.targets, ignored: true } };
        const storedConfig = {
            ...embedConfig, ignored: true,
            ui: { ...embedConfig.ui, ignored: true },
            newChat: { ...embedConfig.newChat, ignored: true },
            organization: { ...embedConfig.organization, ignored: true },
            style: {
                ...embedConfig.style, ignored: true,
                typography: { ...embedConfig.style.typography, ignored: true },
                parts: { composer: { ...embedConfig.style.parts.composer, ignored: true }, ignored: true },
            },
        };
        await db.accountApiToken.update({
            where: { id: minted.tokenId }, data: { accessGrant: grant, embedConfig: storedConfig },
        });
        expect(await auth.verifyPat(minted.token)).toMatchObject({ ok: true, grant, embedConfig });
        expect(await auth.listApiTokens(account.id)).toEqual([expect.objectContaining({ grant, embedConfig })]);
        await expect(auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, grant: storedGrant })).rejects.toThrow();
        await expect(auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, embedConfig: storedConfig })).rejects.toThrow();
        await auth.updateApiToken({ accountId: account.id, tokenId: minted.tokenId, grant, embedConfig });
        expect(await db.accountApiToken.findUnique({
            where: { id: minted.tokenId }, select: { accessGrant: true, embedConfig: true },
        })).toEqual({ accessGrant: grant, embedConfig });
        for (const unsupportedGrant of [{ ...grant, ignored: true },
            { ...grant, targets: { ...grant.targets, ignored: true } }]) {
            await db.accountApiToken.update({ where: { id: minted.tokenId }, data: { accessGrant: unsupportedGrant } });
            expect(await auth.verifyPat(minted.token)).toEqual({ ok: false, reason: 'invalid_token' });
            await expect(auth.listApiTokens(account.id)).rejects.toMatchObject({ code: 'invalid_token' });
        }
        await db.accountApiToken.update({ where: { id: minted.tokenId }, data: { accessGrant: { ...grant, approve: 'true' } } });
        expect(await auth.verifyPat(minted.token)).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it("copies only explicit server-verified evidence into the PAT row and fails malformed snapshots closed", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-evidence" },
            select: { id: true },
        });
        const evidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];
        const minted = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Qualified automation",
            authenticationEvidence: evidence,
        });

        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
            authenticationEvidence: evidence,
        });
        await expect(auth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ hasUnattendedTeamAccess: true }),
        ]);

        await db.accountApiToken.update({
            where: { id: minted.tokenId },
            data: { authenticationEvidence: { v: 1, ignored: true, evidence: [{ ...evidence[0], ignored: true }] } },
        });
        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({ authenticationEvidence: evidence });
        await expect(auth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ hasUnattendedTeamAccess: true }),
        ]);

        await db.accountApiToken.update({
            where: { id: minted.tokenId },
            data: { authenticationEvidence: { v: 99, evidence } },
        });
        await expect(auth.verifyToken(minted.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
        });
        expect((await auth.verifyToken(minted.token))?.authenticationEvidence).toBeUndefined();

        await expect(auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Over-bound automation",
            authenticationEvidence: Array.from({ length: 33 }, (_, index) => ({
                kind: "home_method" as const,
                methodId: `method-${index}`,
            })),
        })).rejects.toMatchObject({ code: "credential_authentication_evidence_limit" });
        expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("invalidates signed sessions at sign-out-everywhere while preserving PATs", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-sign-out-everywhere" },
            select: { id: true },
        });
        const preEpochToken = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Pre-epoch automation",
        });
        const preEpochSigned = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        await expect(auth.verifyToken(preEpochToken.token)).resolves.not.toBeNull();

        await apiTokenAuth.signOutEverywhere(account.id);

        await expect(auth.verifyToken(preEpochToken.token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "api_token",
            authority: "account_automation",
        });
        await expect(apiTokenAuth.verifyPat(preEpochToken.token)).resolves.toMatchObject({
            ok: true,
            accountId: account.id,
            credentialId: preEpochToken.tokenId,
            authority: "account_automation",
        });
        await expect(apiTokenAuth.listApiTokens(account.id)).resolves.toEqual([
            expect.objectContaining({ tokenId: preEpochToken.tokenId, label: "Pre-epoch automation" }),
        ]);

        // Credentials minted after the epoch change remain valid.
        const postEpochToken = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Post-epoch automation",
        });
        await expect(auth.verifyToken(postEpochToken.token)).resolves.not.toBeNull();
        const postEpochSigned = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        await expect(auth.verifyToken(postEpochSigned)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account",
            legacy: false,
        });
        // The pre-epoch signed token was already invalidated by the epoch check.
        await expect(auth.verifyToken(preEpochSigned)).resolves.toBeNull();
    });

    it("rejects expired and deleted-account tokens while retaining opaque external failure", async () => {
        const expiringAccount = await db.account.create({
            data: { publicKey: "api-token-expiry" },
            select: { id: true },
        });
        const expiringToken = await apiTokenAuth.createApiToken({
            accountId: expiringAccount.id,
            tokenId: crypto.randomUUID(),
            label: "Short-lived tool",
            expiresAt: new Date("2026-08-22T12:01:00.000Z"),
        });
        vi.setSystemTime(new Date("2026-08-22T12:01:00.001Z"));
        await expect(auth.verifyToken(expiringToken.token)).resolves.toBeNull();

        const deletedAccount = await db.account.create({
            data: { publicKey: "api-token-deleted-account" },
            select: { id: true },
        });
        const deletedAccountToken = await apiTokenAuth.createApiToken({
            accountId: deletedAccount.id,
            tokenId: crypto.randomUUID(),
            label: "Deleted account tool",
        });
        await db.account.delete({ where: { id: deletedAccount.id } });
        await expect(auth.verifyToken(deletedAccountToken.token)).resolves.toBeNull();

        await withAuthenticatedApp(async (app) => {
            for (const token of [expiringToken.token, deletedAccountToken.token]) {
                const response = await app.inject({
                    method: "GET",
                    url: "/private",
                    headers: { authorization: `Bearer ${token}` },
                });
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }
        });
    });

    it("does not advance lastUsedAt again before the owner-local five-minute write throttle elapses", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-last-used" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Build agent",
        });

        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        const first = (await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt;
        expect(first).toEqual(new Date("2026-08-22T12:00:00.000Z"));

        vi.setSystemTime(new Date("2026-08-22T12:04:59.999Z"));
        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt).toEqual(first);

        vi.setSystemTime(new Date("2026-08-22T12:05:00.000Z"));
        await expect(auth.verifyToken(minted.token)).resolves.not.toBeNull();
        expect((await apiTokenAuth.listApiTokens(account.id))[0]?.lastUsedAt)
            .toEqual(new Date("2026-08-22T12:05:00.000Z"));
    });

    it("fails an API token at the existing account-eligibility gate", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
        });
        const account = await db.account.create({
            data: { publicKey: "api-token-ineligible" },
            select: { id: true },
        });
        const minted = await apiTokenAuth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Ineligible automation",
        });

        await withAuthenticatedApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${minted.token}` },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "provider-required", provider: "github" });
        });
    });
});
