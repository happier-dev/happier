import { describe, expect, it, vi } from "vitest";

import {
    CredentialAccessDeclarationDigestSchema,
    CredentialAccessSelectedAuthorityDigestSchema,
    CredentialAccessSelectedRawAccessDigestSchema,
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    PluginCredentialAccessSlotIdSchema,
    PluginInstallReviewPrincipalDigestSchema,
    PluginPermissionInstalledGenerationIdSchema,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    type PluginPermissionGrantAuditEventV1,
    type PluginPermissionGrantV1,
} from "@happier-dev/protocol";

type CapturedSql = Readonly<{
    sql: string;
    values: readonly unknown[];
}>;

const databaseBoundary = vi.hoisted(() => {
    const executeRaw = vi.fn(async (_query: CapturedSql): Promise<number> => 1);
    const transaction = vi.fn(async (
        callback: (tx: Readonly<{ $executeRaw: typeof executeRaw }>) => Promise<unknown>,
    ): Promise<unknown> => callback({ $executeRaw: executeRaw }));
    return { executeRaw, transaction };
});

vi.mock("@/storage/db", () => ({
    db: {
        $transaction: databaseBoundary.transaction,
    },
}));

import {
    createSqlPluginPermissionGrantStore,
    pluginPermissionGrantActiveIdentityKey,
} from "./storage";

function identity(machineId: string, installationId: string) {
    return {
        pluginId: "happier.review.coderabbit",
        capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
        targetScope: { kind: "project" as const, projectId: "project-1" },
        subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
        authoritySource: {
            kind: "machine_installation" as const,
            machineId,
            installationId,
        },
    };
}

describe("plugin permission grant active identity", () => {
    it("is bounded and does not alias delimiter-containing identity parts", () => {
        const left = pluginPermissionGrantActiveIdentityKey(identity("machine\u001Fpart", "installation"));
        const right = pluginPermissionGrantActiveIdentityKey(identity("machine", "part\u001Finstallation"));
        const long = pluginPermissionGrantActiveIdentityKey(identity("m".repeat(2_000), "i".repeat(2_000)));

        expect(left).not.toBe(right);
        expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(right).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(long).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });

    it("does not alias distinct strict permission subjects", () => {
        const general = pluginPermissionGrantActiveIdentityKey(identity("machine", "installation"));
        const credential = pluginPermissionGrantActiveIdentityKey({
            ...identity("machine", "installation"),
            subject: {
                kind: "credential_access_disclosure",
                contribution: { pluginId: "happier.voice.openai", localId: "openai-realtime" },
                credentialSlotId: PluginCredentialAccessSlotIdSchema.parse("api-key"),
                purpose: "voice-session",
                accessDeclarationDigest: CredentialAccessDeclarationDigestSchema.parse("a".repeat(64)),
                selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema.parse("c".repeat(64)),
                selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema.parse("d".repeat(64)),
                installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse("generation-1"),
                installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse("b".repeat(64)),
            },
        });

        expect(general).not.toBe(credential);
    });

    it("targets the exact grant id when revoking an active identity", async () => {
        databaseBoundary.executeRaw.mockClear();
        databaseBoundary.transaction.mockClear();
        const authoritySource = {
            kind: "machine_installation",
            machineId: "machine-1",
            installationId: "installation-1",
        } as const;
        const grant = {
            v: 1,
            id: "grant-stale-reader",
            accountId: "account-1",
            pluginId: "happier.review.coderabbit",
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            authoritySource,
            status: "revoked",
            requestId: "request-1",
            grantedByUserId: "user-1",
            grantedAt: 1,
            revokedByUserId: "user-2",
            revokedAt: 2,
            createdAt: 1,
            updatedAt: 2,
        } satisfies PluginPermissionGrantV1;
        const event = {
            v: 1,
            eventId: "event-1",
            accountId: grant.accountId,
            pluginId: grant.pluginId,
            capability: grant.capability,
            targetScope: grant.targetScope,
            subject: grant.subject,
            authoritySource,
            eventKind: "revoked",
            actor: { kind: "user", userId: "user-2" },
            requestId: grant.requestId,
            grantId: grant.id,
            previousState: { grantStatus: "active" },
            nextState: { grantStatus: "revoked" },
            createdAt: 2,
        } satisfies PluginPermissionGrantAuditEventV1;

        await createSqlPluginPermissionGrantStore().revokeGrant({ grant, event });

        const transition = databaseBoundary.executeRaw.mock.calls[0]?.[0];
        expect(transition).toBeDefined();
        expect(transition?.sql.replace(/\s+/gu, " ")).toMatch(/\bWHERE\b.*\bid = \?/u);
        expect(transition?.values).toContain(grant.id);
    });
});
