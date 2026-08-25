import tweetnacl from "tweetnacl";

export type EnvValue = string | undefined;
export type EnvValues = Record<string, EnvValue>;

export function snapshotEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === "string") {
            process.env[key] = value;
            continue;
        }
        delete process.env[key];
    }
}

export function applyEnvValues(values: EnvValues): void {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }
        process.env[key] = value;
    }
}

export function snapshotEnvValues(keys: readonly string[]): EnvValues {
    const snapshot: EnvValues = {};

    for (const key of keys) {
        snapshot[key] = process.env[key];
    }

    return snapshot;
}

export function restoreEnvValues(snapshot: EnvValues): void {
    applyEnvValues(snapshot);
}

export function createEnvReset(snapshot = snapshotEnv()) {
    return (overrides: EnvValues = {}): NodeJS.ProcessEnv => {
        restoreEnv(snapshot);
        applyEnvValues(overrides);
        return snapshotEnv();
    };
}

export function createEnvPatcher(keys: readonly string[]) {
    const original = snapshotEnvValues(keys);

    const set = (key: string, value: EnvValue): void => {
        applyEnvValues({ [key]: value });
    };

    const setMany = (patch: EnvValues): void => {
        applyEnvValues(patch);
    };

    const restore = (): void => {
        restoreEnvValues(original);
    };

    return { set, setMany, restore };
}

/**
 * The peer-mediation route-grant signing variables, as a deterministic test fixture.
 *
 * Grant signing is the master switch for every server-relayed peer flow
 * (`docs/peer-mediation.md` §2.1): without it the local-service preview tunnel opener throws
 * `grant_signing_unavailable`, so `capabilities.localServices.{preview,publicPreview}` report the
 * relay as unavailable. Any suite that composes a *working* preview or public exposure needs these.
 */
export function peerMediationGrantSigningEnv(): EnvValues {
    // Ed25519 seed fixed at 0x09 repeated: the same deterministic key the peer-mediation feature
    // specs use, so a payload's advertised public key is stable across suites.
    const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    return {
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "testkit_signing_key",
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(keyPair.secretKey).toString("base64url"),
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString("base64url"),
    };
}
