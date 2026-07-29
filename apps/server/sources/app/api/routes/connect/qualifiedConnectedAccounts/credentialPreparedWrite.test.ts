import { describe, expect, it } from "vitest";

import {
    assertQualifiedConnectedAccountPreparedCreateWinner,
    type QualifiedConnectedAccountPreparedCreate,
} from "./credentialPreparedWrite";

const prepared: QualifiedConnectedAccountPreparedCreate = {
    authenticationModeId: "api-key",
    credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
    credentialBytes: Uint8Array.of(1, 2, 3),
    metadata: {
        v: 4,
        storage: "stored_envelope_v1",
        credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
        values: {
            providerIdentity: {
                accountId: null,
                email: "operator@example.com",
            },
            scopes: [],
        },
    },
    configurationRevision: "cscr_abcdefghijklmnopqrstuvwxyz",
    configurationBytes: Uint8Array.of(4, 5, 6),
};

describe("qualified Connected Account prepared create settlement", () => {
    it("accepts only the exact prepared bytes, metadata, mode, and revisions", () => {
        expect(() =>
            assertQualifiedConnectedAccountPreparedCreateWinner({
                prepared,
                winner: {
                    authenticationModeId: prepared.authenticationModeId,
                    token: prepared.credentialBytes,
                    metadata: prepared.metadata,
                    configurationRevision: prepared.configurationRevision,
                    configurationContent: prepared.configurationBytes,
                },
            }),
        ).not.toThrow();

        const divergentWinners = [
            { token: Uint8Array.of(9) },
            { authenticationModeId: "oauth" },
            {
                metadata: {
                    ...prepared.metadata,
                    credentialRevision: "csr_zyxwvutsrqponmlkjihgfedcba",
                },
            },
            {
                metadata: {
                    ...prepared.metadata,
                    values: {
                        ...prepared.metadata.values,
                        providerIdentity: {
                            email: "operator@example.com",
                        },
                    },
                },
            },
            { configurationRevision: "cscr_other" },
            { configurationContent: Uint8Array.of(8) },
        ];
        for (const divergence of divergentWinners) {
            expect(() =>
                assertQualifiedConnectedAccountPreparedCreateWinner({
                    prepared,
                    winner: {
                        authenticationModeId: prepared.authenticationModeId,
                        token: prepared.credentialBytes,
                        metadata: prepared.metadata,
                        configurationRevision: prepared.configurationRevision,
                        configurationContent: prepared.configurationBytes,
                        ...divergence,
                    },
                }),
            ).toThrow(/prepared create winner mismatch/i);
        }
    });
});
