import { describe, expect, it, vi } from "vitest";
import { projectEffectiveSessionAccess, resolveSessionAccessForOperation, type SessionAccessProjectionRow } from "./sessionAccess";
import type { Tx } from "@/storage/inTx";
import { readSessionAccessAuthenticationFromRequest, readSessionAccessAuthenticationFromSocket, type SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import { V2SessionListRowSchema, projectSessionDisplayV1, sealSessionOwnerDisplayEnvelopeV1,
    sealSessionSharedDisplayEnvelopeV1Sync } from '@happier-dev/protocol';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from './sessionAccessAuthentication.testkit';
import { readmitSessionRowsWithAdmissionInTx } from './sessionReadAdmission';
import { projectSessionMetadataDocumentDescriptorForRecipient, projectSessionMetadataForRecipient,
    SessionMetadataPrivacyUpgradeRequiredError } from '../metadata/sessionMetadataRecipientProjection';

// Pure row projection never queries persistence; relational coverage uses the real SQLite harness.
vi.mock("@/storage/db", () => ({ db: {} }));

function session(overrides: Partial<SessionAccessProjectionRow> = {}): SessionAccessProjectionRow {
    return { id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 0, currentStorageState: "hosted",
        acceptedThroughServerSeq: null, materializationPublicationId: null,
        materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        shares: [], teamGrants: [], groupGrants: [], ...overrides };
}

describe("Session effective capability projection", () => {
    it.each([['plain', 'e2ee'], ['e2ee', 'plain']] as const)(
        'withdraws captured %s owner display at fresh %s Account admission', async (fromMode, toMode) => {
        const ownerMetadata = { v: 1 as const, workspace: { name: 'Mode-bound private display' } };
        const sharedMetadata = { v: 1 as const, summary: { text: 'Mode-neutral shared display', updatedAt: 0 } };
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        const randomBytes = (length: number) => new Uint8Array(length).fill(4);
        const encryptedOwner = sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material, randomBytes });
        const plainOwner = { t: 'plain' as const, v: ownerMetadata };
        const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const shared = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: semantic.shared });
        const owner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: fromMode,
            display: semantic.owner!, material, randomBytes });
        if (!shared.ok || !owner.ok) throw new Error('Canonical mode-bound display producer failed');
        const displayProjectionV1 = { v: 1 as const, metadataLayoutVersion: 1 as const, sourceMetadataVersion: 0,
            shared: shared.envelope, owner: owner.envelope };
        const stored = { id: 'session', accountId: 'owner', encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify(sharedMetadata), metadataVersion: 0, agentState: null, agentStateVersion: 0,
            ownerMetadata: JSON.stringify(fromMode === 'plain' ? plainOwner : encryptedOwner),
            displayProjectionV1: JSON.stringify(displayProjectionV1) };
        const recipient = { type: 'owner' as const, accountId: 'owner', accountMode: fromMode };
        const captured = V2SessionListRowSchema.parse({ id: 'session', seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
            ...projectSessionMetadataDocumentDescriptorForRecipient({ session: stored, recipient }) });
        const full = { id: 'session', encryptionMode: 'plain', dataEncryptionKey: null,
            ...projectSessionMetadataForRecipient({ session: stored, recipient }) };
        const fresh = { ...session(), encryptionMode: 'plain', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(toMode === 'plain' ? plainOwner : encryptedOwner), dataKeyEnvelopes: [],
            account: { status: 'active', ...createSignedAccountContentBinding(), encryptionMode: toMode } };
        const findMany = vi.fn().mockResolvedValue([fresh]);
        // Prisma is the genuine boundary; all access, mode and recipient logic stays real.
        const reader = { session: { findMany } } as unknown as Tx;
        const admission = { accountId: 'owner', accessMode: 'effective_access_v1' as const,
            authentication: createPresentUserSessionAccessAuthentication() };
        await expect(readmitSessionRowsWithAdmissionInTx(reader, admission, [full]))
            .rejects.toBeInstanceOf(SessionMetadataPrivacyUpgradeRequiredError);
        const readmitted = (await readmitSessionRowsWithAdmissionInTx(reader, admission, [captured])).get('session');
        expect(readmitted?.status).toBe('allowed');
        if (readmitted?.status !== 'allowed') throw new Error('Expected compatible shared display to remain admitted');
        const { owner: _owner, ...sharedOnly } = displayProjectionV1;
        expect(readmitted.row.displayProjectionV1).toEqual(sharedOnly);
        expect(JSON.stringify(readmitted.row)).not.toContain('Mode-bound private display');
        const storedCapture = { ...captured, displayProjectionV1: JSON.stringify(displayProjectionV1) };
        const storedAdmission = (await readmitSessionRowsWithAdmissionInTx(reader, admission, [storedCapture])).get('session');
        expect(storedAdmission?.status).toBe('allowed');
        if (storedAdmission?.status !== 'allowed') throw new Error('Expected captured database row to remain admitted');
        expect(typeof storedAdmission.row.displayProjectionV1).toBe('string');
        expect(JSON.parse(storedAdmission.row.displayProjectionV1)).toEqual(sharedOnly);
        expect(findMany.mock.calls.at(-1)?.[0].select.ownerMetadata).toBe(false);
        expect(findMany.mock.calls.at(-1)?.[0].select).not.toHaveProperty('displayProjectionV1');
    });

    it("admits an exact model Action without granting Send, while retaining underlying share limits", async () => {
        const authentication: SessionAccessAuthentication = {
            env: {}, authority: "account_automation", authenticationEvidence: undefined,
            apiTokenGrant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: ["session.model.set"] },
                targets: { sessions: ["session"], machines: [] } },
        };
        const reader = {} as Tx;
        const operation = { accountId: "owner", sessionId: "session", authentication,
            row: session(), capability: "submitAgentInput" as const,
            apiTokenAction: { actionId: "session.model.set" as const } };
        expect(await resolveSessionAccessForOperation(reader, operation)).toMatchObject({
            status: "allowed", access: { capabilities: { submitAgentInput: false } },
        });
        expect(await resolveSessionAccessForOperation(reader, { ...operation,
            apiTokenAction: { actionId: "session.message.send" } })).toEqual({ status: "unavailable" });
        expect(await resolveSessionAccessForOperation(reader, { ...operation,
            apiTokenAction: { actionId: "session.goal.set" } })).toEqual({ status: "unavailable" });
        expect(await resolveSessionAccessForOperation(reader, { ...operation, row: session({
            accountId: "other-owner", shares: [{ id: "share", sharedWithUserId: "owner",
                accessLevel: "view", canApprovePermissions: false }],
        }) })).toEqual({ status: "unavailable" });
    });
    it("preserves verified Action-effect constraints without applying a direct-token capability ceiling", async () => {
        const principal = { grant: { ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ["session.goal.set" as const] }, permissionModes: null } };
        const invocationConstraints = { models: null, permissionModes: ["default" as const] };
        const direct = readSessionAccessAuthenticationFromRequest({ authAuthority: "account_automation", apiTokenPrincipal: principal });
        const effect = readSessionAccessAuthenticationFromRequest({ authAuthority: "account_automation", apiTokenPrincipal: principal,
            externalActionExecutionAuthorized: true, externalActionSessionAccessAdmitted: true, externalActionInputConstraints: invocationConstraints });
        expect(direct.apiTokenGrant).toEqual(principal.grant);
        const unadmitted = readSessionAccessAuthenticationFromRequest({ authAuthority: "account_automation", apiTokenPrincipal: principal,
            externalActionExecutionAuthorized: true, externalActionInputConstraints: invocationConstraints });
        expect(unadmitted.apiTokenGrant).toEqual(principal.grant);
        expect(await resolveSessionAccessForOperation({} as Tx, { accountId: "owner", sessionId: "session",
            authentication: unadmitted, row: session(), capability: "submitAgentInput" })).toEqual({ status: "unavailable" });
        expect(effect).not.toHaveProperty("apiTokenGrant");
        expect(effect.callerInputConstraints).toEqual({ models: null, permissionModes: ["default"] });
        expect(await resolveSessionAccessForOperation({} as Tx, { accountId: "owner", sessionId: "session",
            authentication: direct, row: session(), capability: "submitAgentInput" })).toEqual({ status: "unavailable" });
        expect(await resolveSessionAccessForOperation({} as Tx, { accountId: "owner", sessionId: "session",
            authentication: effect, row: session(), capability: "submitAgentInput" })).toMatchObject({ status: "allowed" });
    });
    it("keeps API-token viewer credentials distinct from Runner runtime principals", () => {
        const principal = { grant: {
            v: 1, actions: null, targets: null, approve: false, origins: [], models: null, permissionModes: ["default"], create: null,
        } };
        const authentication = readSessionAccessAuthenticationFromSocket({ data: {
            authAuthority: "account_automation", apiTokenPrincipal: principal,
            ephemeralRunnerAdmission: { kind: "api-token-session-viewer", principal, sessionId: "session" },
        } });
        expect(authentication).not.toHaveProperty("sessionRuntimePrincipal");
        expect(authentication).toHaveProperty("apiTokenGrant", principal.grant);
        expect(authentication).toHaveProperty("callerInputConstraints", { models: null, permissionModes: ["default"] });
    });
    it.each(["effective_access_v1", "legacy_owner_or_direct"] as const)("caps token owner access on the %s seam and enforces the capped capability", async (accessMode) => {
        const authentication: SessionAccessAuthentication = {
            env: {}, authority: "account_automation" as const, authenticationEvidence: undefined,
            apiTokenGrant: {
                v: 1 as const, actions: { families: [], ids: ["session.transcript.get"] },
                targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null,
            },
        };
        // This operation uses the already-loaded row; no persistence query is needed.
        const reader = {} as Tx;
        const result = await resolveSessionAccessForOperation(reader, {
            accountId: "owner", sessionId: "session", authentication, accessMode, row: session(),
        });
        expect(result).toMatchObject({ status: "allowed", access: {
            capabilities: { readTranscript: true, submitAgentInput: false, approveRuntimePermissions: false, manageAccess: false },
        } });
        expect(await resolveSessionAccessForOperation(reader, {
            accountId: "owner", sessionId: "session", authentication, accessMode, row: session(), capability: "submitAgentInput",
        })).toEqual({ status: "unavailable" });
    });
    it("keeps owner custody available without published transcript or a grant", () => {
        const access = projectEffectiveSessionAccess(session({ currentStorageState: "machine_only" }), "owner");
        expect(access?.level).toBe("owner");
        expect(Object.values(access!.capabilities).every(Boolean)).toBe(true);
        expect(access?.sources).toEqual([{ kind: "owner" }]);
    });
    it.each(["suspended", "disabled"] as const)("denies an %s owner from current Account lifecycle facts", status => {
        expect(projectEffectiveSessionAccess(session({ account: { status } }), "owner")).toBeNull();
    });
    it.each(["view", "edit", "admin"] as const)("projects the direct %s level without implicit runtime delegation", level => {
        const access = projectEffectiveSessionAccess(session({ shares: [{ id: "grant", sharedWithUserId: "reader", accessLevel: level, canApprovePermissions: false }] }), "reader");
        expect(access?.capabilities.readTranscript).toBe(true);
        expect(access?.capabilities.submitAgentInput).toBe(level !== "view");
        expect(access?.capabilities.manageAccess).toBe(level === "admin");
        expect(access?.capabilities.approveRuntimePermissions).toBe(false);
        expect(access?.capabilities.managePermissionDelegation).toBe(false);
        expect(access?.capabilities.stopSession).toBe(false);
        expect(access?.capabilities.deleteSession).toBe(false);
        expect(access?.capabilities.managePublicLink).toBe(false);
    });
    it.each(["view", "edit", "admin"] as const)("requires same-grant level for delegated %s authority", level => {
        const access = projectEffectiveSessionAccess(session({ shares: [{ id: "grant", sharedWithUserId: "reader", accessLevel: level, canApprovePermissions: true }] }), "reader");
        expect(access?.capabilities.approveRuntimePermissions).toBe(level !== "view");
        expect(access?.capabilities.managePermissionDelegation).toBe(level === "admin");
    });
    it("preserves every applicable relationship kind when decisive sources omit weaker grants", () => {
        const access = projectEffectiveSessionAccess(session({
            shares: [{ id: "direct", sharedWithUserId: "reader", accessLevel: "view", canApprovePermissions: false }],
            teamGrants: [{ teamId: "team", effectiveAt: new Date(1), accessLevel: "admin", canApprovePermissions: false, requiredByTeamPolicy: false,
                team: { authenticationPolicy: null, memberships: [{ accountId: "reader", sessionAccessStartsAt: null }] } }],
            groupGrants: [{ teamGroupId: "group", effectiveAt: new Date(1), accessLevel: "view", canApprovePermissions: false,
                teamGroup: { teamId: "team", team: { authenticationPolicy: null }, memberships: [{ sessionAccessStartsAt: null, teamMembership: { accountId: "reader" } }] } }],
        }), "reader", { includeCredentialRestrictedTeamEntitlements: true });
        expect(access?.sources).toEqual([{ kind: "team", teamId: "team", requiredByTeamPolicy: false }]);
        expect(access?.relationshipKinds).toEqual(["direct", "team", "group"]);
        // Quiet row context is more specific than the strongest access explanation.
        expect(access).toMatchObject({ audienceContext: { kind: "group", teamId: "team", groupId: "group" } });
    });
    it("projects only the exact credential-qualified Teams instead of trusting row-wide query admission", () => {
        const access = projectEffectiveSessionAccess(session({
            teamGrants: [
                {
                    teamId: "qualified-team", effectiveAt: new Date(1), accessLevel: "edit",
                    canApprovePermissions: false, requiredByTeamPolicy: false,
                    team: { authenticationPolicy: { kind: "method", methodId: "qualified" }, memberships: [{ accountId: "reader", sessionAccessStartsAt: null }] },
                },
                {
                    teamId: "unqualified-team", effectiveAt: new Date(1), accessLevel: "admin",
                    canApprovePermissions: true, requiredByTeamPolicy: false,
                    team: { authenticationPolicy: { kind: "method", methodId: "unqualified" }, memberships: [{ accountId: "reader", sessionAccessStartsAt: null }] },
                },
            ],
        }), "reader", { qualifiedTeamIds: new Set(["qualified-team"]) });

        expect(access).toMatchObject({
            level: "edit",
            sources: [{ kind: "team", teamId: "qualified-team", requiredByTeamPolicy: false }],
            capabilities: { manageAccess: false, managePermissionDelegation: false },
        });
    });
    it("keeps the released projection owner/direct-only even for an unrestricted stronger Team grant", () => {
        const access = projectEffectiveSessionAccess(session({
            shares: [{ id: "direct", sharedWithUserId: "reader", accessLevel: "view", canApprovePermissions: false }],
            teamGrants: [{
                teamId: "team", effectiveAt: new Date(1), accessLevel: "admin",
                canApprovePermissions: true, requiredByTeamPolicy: false,
                team: { authenticationPolicy: null, memberships: [{ accountId: "reader", sessionAccessStartsAt: null }] },
            }],
        }), "reader", { mode: "legacy_owner_or_direct" });

        expect(access).toMatchObject({
            level: "view",
            sources: [{ kind: "direct", shareId: "direct" }],
            capabilities: { manageAccess: false, managePermissionDelegation: false },
        });
    });
    it("preserves explicit owner Team context without turning it into access or exposing the ACL", () => {
        const row = { ...session(), primaryTeamId: "context-team" };
        expect(projectEffectiveSessionAccess(row, "owner")).toMatchObject({
            sources: [{ kind: "owner" }], primaryTeamId: "context-team", audienceContext: null,
        });
        expect(projectEffectiveSessionAccess(row, "reader")).toBeNull();
    });
    it("projects safe authored Team context to an authorized direct recipient without exposing grants", () => {
        const access = projectEffectiveSessionAccess(session({
            primaryTeamId: "context-team",
            shares: [{ id: "grant", sharedWithUserId: "reader", accessLevel: "view", canApprovePermissions: false }],
        }), "reader");
        expect(access).toMatchObject({
            level: "view",
            primaryTeamId: "context-team",
            sources: [{ kind: "direct", shareId: "grant" }],
        });
    });
    it("does not admit a missing grant or unpublished recipient", () => {
        expect(projectEffectiveSessionAccess(session(), "reader")).toBeNull();
        expect(projectEffectiveSessionAccess(session({ currentStorageState: "machine_only", shares: [{ id: "grant", sharedWithUserId: "reader", accessLevel: "admin", canApprovePermissions: true }] }), "reader")).toBeNull();
    });
});
