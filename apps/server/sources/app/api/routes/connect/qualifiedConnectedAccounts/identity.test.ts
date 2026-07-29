import { describe, expect, it } from "vitest";

import {
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountServiceDigest,
    createServiceAccountTokenIdentityFields,
    classifyQualifiedConnectedAccountLegacyAuthenticationMode,
    resolveLegacyCredentialKindForAuthenticationMode,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "./identity";

describe("qualified Connected Account persistence identity", () => {
    it("hashes structured source fields without delimiter ambiguity", () => {
        const left = createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "plugin.owner", localId: "a/b" },
            accountId: "c",
        });
        const right = createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "plugin.owner", localId: "a" },
            accountId: "b/c",
        });

        expect(left).toMatch(/^[a-f0-9]{64}$/);
        expect(right).toMatch(/^[a-f0-9]{64}$/);
        expect(left).not.toBe(right);
        expect(createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "plugin.owner", localId: "a/b" },
            accountId: "c",
        })).toBe(left);
    });

    it("parses the canonical identity codec before hashing", () => {
        const canonical = createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "plugin.owner", localId: "service/path" },
            accountId: "account-1",
        });
        expect(() => createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: " plugin.owner ", localId: " service/path " },
            accountId: " account-1 ",
        })).toThrow();
        expect(canonical).toMatch(/^[a-f0-9]{64}$/);
        expect(() => createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "Plugin Owner", localId: "service/path" },
            accountId: "account-1",
        })).toThrow();
    });

    it("uses a domain-separated group digest", () => {
        const group = createQualifiedConnectedAccountGroupDigest({
            service: { pluginId: "plugin.owner", localId: "service" },
            groupId: "account",
        });
        const account = createQualifiedConnectedAccountIdentityDigest({
            service: { pluginId: "plugin.owner", localId: "service" },
            accountId: "account",
        });

        expect(group).toMatch(/^[a-f0-9]{64}$/);
        expect(group).not.toBe(account);
    });

    it("derives one service digest shared by account and group rows", () => {
        const service = { pluginId: "plugin.owner", localId: "service/path" };
        const digest = createQualifiedConnectedAccountServiceDigest(service);

        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        expect(createQualifiedConnectedAccountServiceDigest({ ...service })).toBe(digest);
        expect(createQualifiedConnectedAccountServiceDigest({
            pluginId: service.pluginId,
            localId: "service/other",
        })).not.toBe(digest);
    });

    it("normalizes a released service/profile through its bundled qualified identity owner", () => {
        const legacy =
            resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "openai",
                profileId: "default",
            });
        const qualified = createServiceAccountTokenIdentityFields({
            ref: {
                service: {
                    pluginId: "happier.voice.openai",
                    localId: "openai",
                },
                accountId: "default",
            },
            authenticationModeId: "api-key",
        });

        expect(legacy).toEqual(qualified);
        expect(legacy).toMatchObject({
            servicePluginId: "happier.voice.openai",
            serviceLocalId: "openai",
            connectedAccountId: "default",
            authenticationModeId: "api-key",
        });
        expect(legacy.qualifiedServiceDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(legacy.qualifiedIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("derives a legacy multi-mode credential from the stored credential kind", () => {
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId: "oauth-account",
            credentialKind: "oauth",
        }).authenticationModeId).toBe("oauth");
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId: "setup-account",
            credentialKind: "token",
        }).authenticationModeId).toBe("setup-token");
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId: "legacy-account",
        }).authenticationModeId).toBe("setup-token");
    });

    it("preserves unsupported historical Gemini OAuth without relabeling it as an API key", () => {
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "gemini",
            profileId: "old-oauth",
            credentialKind: "oauth",
        }).authenticationModeId).toBe("legacy-oauth-unsupported");
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "gemini",
            profileId: "api-key",
            credentialKind: "token",
        }).authenticationModeId).toBe("api-key");
        expect(resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "gemini",
            profileId: "raw-v1",
        }).authenticationModeId).toBe("api-key");
        expect(resolveLegacyCredentialKindForAuthenticationMode({
            serviceId: "gemini",
            authenticationModeId: "legacy-oauth-unsupported",
        })).toBeNull();
        expect(resolveLegacyCredentialKindForAuthenticationMode({
            serviceId: "gemini",
            authenticationModeId: "api-key",
        })).toBe("token");
        expect(classifyQualifiedConnectedAccountLegacyAuthenticationMode({
            service: {
                pluginId: "happier.agent.gemini",
                localId: "gemini-account",
            },
            authenticationModeId: "legacy-oauth-unsupported",
        })).toEqual({
            credentialKind: "oauth",
            support: "unsupported",
        });
    });
});
