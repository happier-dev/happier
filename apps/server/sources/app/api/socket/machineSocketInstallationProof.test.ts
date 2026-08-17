import {
    encodeBase64,
    signMachineInstallationProof,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import {
    readVerifiedMachineSocketInstallationIdFromSocketData,
    resolveVerifiedMachineSocketInstallationId,
} from "./machineSocketInstallationProof";

const accountId = "account-1";
const machineId = "machine-1";

function createSignedSocketProof(params: Readonly<{
    installationId: string;
    proofMachineId?: string;
}>, keyPair: Readonly<{
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}> = tweetnacl.sign.keyPair()) {
    const installationPublicKey = encodeBase64(keyPair.publicKey, "base64url");
    return {
        installationId: params.installationId,
        installationPublicKey,
        installationProof: signMachineInstallationProof({
            payload: {
                version: 1,
                installationId: params.installationId,
                machineId: params.proofMachineId ?? machineId,
                accountId,
            },
            privateKey: keyPair.secretKey,
        }),
        installationPublicKeyBytes: new Uint8Array(keyPair.publicKey),
        keyPair,
    };
}

describe("machine Socket installation proof", () => {
    it("attests only the current stored installation from a valid Socket proof", () => {
        const current = createSignedSocketProof({ installationId: "installation-current" });

        expect(resolveVerifiedMachineSocketInstallationId({
            accountId,
            machineId,
            machine: {
                installationId: current.installationId,
                installationPublicKey: current.installationPublicKeyBytes,
            },
            socketAuth: current,
        })).toBe("installation-current");
        expect(readVerifiedMachineSocketInstallationIdFromSocketData({
            verifiedMachineInstallationId: "installation-current",
        })).toBe("installation-current");
    });

    it.each([
        {
            name: "an absent proof",
            socketAuth: {},
            createMachine: () => createSignedSocketProof({ installationId: "installation-current" }),
            createSocketAuth: undefined,
        },
        {
            name: "a signed substitute installation",
            socketAuth: null,
            createMachine: () => createSignedSocketProof({ installationId: "installation-current" }),
            createSocketAuth: () => createSignedSocketProof({ installationId: "installation-substitute" }),
        },
    ])("does not attest $name", ({ socketAuth, createMachine, createSocketAuth }) => {
        const machineIdentity = createMachine();
        const resolvedSocketAuth = createSocketAuth?.() ?? socketAuth;

        expect(resolveVerifiedMachineSocketInstallationId({
            accountId,
            machineId,
            machine: {
                installationId: machineIdentity.installationId,
                installationPublicKey: machineIdentity.installationPublicKeyBytes,
            },
            socketAuth: resolvedSocketAuth,
        })).toBeNull();
    });

    it("does not attest a stale proof replayed from another machine target", () => {
        const current = createSignedSocketProof({ installationId: "installation-current" });
        const stale = createSignedSocketProof({
            installationId: "installation-current",
            proofMachineId: "machine-retired",
        }, current.keyPair);

        expect(resolveVerifiedMachineSocketInstallationId({
            accountId,
            machineId,
            machine: {
                installationId: current.installationId,
                installationPublicKey: current.installationPublicKeyBytes,
            },
            socketAuth: stale,
        })).toBeNull();
    });
});
