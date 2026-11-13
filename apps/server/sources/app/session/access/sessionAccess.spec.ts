import { describe, expect, it, vi } from "vitest";
import { projectEffectiveSessionAccess, resolveSessionAccessForOperation, type SessionAccessProjectionRow } from "./sessionAccess";
import type { Tx } from "@/storage/inTx";
import { readSessionAccessAuthenticationFromRequest, readSessionAccessAuthenticationFromSocket, type SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";

// Pure row projection never queries persistence; relational coverage uses the real SQLite harness.
vi.mock("@/storage/db", () => ({ db: {} }));

function session(overrides: Partial<SessionAccessProjectionRow> = {}): SessionAccessProjectionRow {
    return { id: "session", primaryTeamId: null, accountId: "owner", account: { status: "active" }, seq: 0, currentStorageState: "hosted",
        acceptedThroughServerSeq: null, materializationPublicationId: null,
        materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        grants: [],   ...overrides };
}

describe("Session effective capability projection", () => {
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
            accountId: "other-owner", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share", accountId: "owner",
                accessLevel: "view", canApprovePermissions: false  }],
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
        const access = projectEffectiveSessionAccess(session({ grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "grant", accountId: "reader", accessLevel: level, canApprovePermissions: false  }] }), "reader");
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
        const access = projectEffectiveSessionAccess(session({ grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "grant", accountId: "reader", accessLevel: level, canApprovePermissions: true  }] }), "reader");
        expect(access?.capabilities.approveRuntimePermissions).toBe(level !== "view");
        expect(access?.capabilities.managePermissionDelegation).toBe(level === "admin");
    });
    it("preserves every applicable relationship kind when decisive sources omit weaker grants", () => {
        const access = projectEffectiveSessionAccess(session({
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "direct", accountId: "reader", accessLevel: "view", canApprovePermissions: false  }, { id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null,  teamId: "team", effectiveAt: new Date(1), accessLevel: "admin", canApprovePermissions: false, requiredByTeamPolicy: false,
                team: { authenticationPolicy: null, memberships: [{ accountId: "reader", role: "member", sessionAccessStartsAt: null }] }  }, { id: 'group-grant', principalKind: 'group', accountId: null, teamId: null, requiredByTeamPolicy: false, account: null, team: null,  teamGroupId: "group", effectiveAt: new Date(1), accessLevel: "view", canApprovePermissions: false,
                teamGroup: { teamId: "team", team: { authenticationPolicy: null }, memberships: [{ sessionAccessStartsAt: null, teamMembership: { accountId: "reader" } }] }  }],
            
            
        }), "reader", { includeCredentialRestrictedTeamEntitlements: true });
        expect(access?.sources).toEqual([{ kind: "team", teamId: "team", requiredByTeamPolicy: false }]);
        expect(access?.relationshipKinds).toEqual(["direct", "team", "group"]);
        // Quiet row context is more specific than the strongest access explanation.
        expect(access).toMatchObject({ audienceContext: { kind: "group", teamId: "team", groupId: "group" } });
    });
    it("projects only the exact credential-qualified Teams instead of trusting row-wide query admission", () => {
        const access = projectEffectiveSessionAccess(session({
            grants: [{ id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null, 
                    teamId: "qualified-team", effectiveAt: new Date(1), accessLevel: "edit",
                    canApprovePermissions: false, requiredByTeamPolicy: false,
                    team: { authenticationPolicy: { kind: "method", methodId: "qualified" }, memberships: [{ accountId: "reader", role: "member", sessionAccessStartsAt: null }] },
                 }, { id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null, 
                    teamId: "unqualified-team", effectiveAt: new Date(1), accessLevel: "admin",
                    canApprovePermissions: true, requiredByTeamPolicy: false,
                    team: { authenticationPolicy: { kind: "method", methodId: "unqualified" }, memberships: [{ accountId: "reader", role: "member", sessionAccessStartsAt: null }] },
                 }],
        }), "reader", { qualifiedTeamIds: new Set(["qualified-team"]) });

        expect(access).toMatchObject({
            level: "edit",
            sources: [{ kind: "team", teamId: "qualified-team", requiredByTeamPolicy: false }],
            capabilities: { manageAccess: false, managePermissionDelegation: false },
        });
    });
    it("keeps the released projection owner/direct-only even for an unrestricted stronger Team grant", () => {
        const access = projectEffectiveSessionAccess(session({
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "direct", accountId: "reader", accessLevel: "view", canApprovePermissions: false  }, { id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null, 
                teamId: "team", effectiveAt: new Date(1), accessLevel: "admin",
                canApprovePermissions: true, requiredByTeamPolicy: false,
                team: { authenticationPolicy: null, memberships: [{ accountId: "reader", role: "member", sessionAccessStartsAt: null }] },
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
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "grant", accountId: "reader", accessLevel: "view", canApprovePermissions: false  }],
        }), "reader");
        expect(access).toMatchObject({
            level: "view",
            primaryTeamId: "context-team",
            sources: [{ kind: "direct", shareId: "grant" }],
        });
    });
    it("does not admit a missing grant or unpublished recipient", () => {
        expect(projectEffectiveSessionAccess(session(), "reader")).toBeNull();
        expect(projectEffectiveSessionAccess(session({ currentStorageState: "machine_only", grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "grant", accountId: "reader", accessLevel: "admin", canApprovePermissions: true  }] }), "reader")).toBeNull();
    });
});
