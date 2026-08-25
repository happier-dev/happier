import { inTx, type Tx } from "@/storage/inTx";

import {
    decryptPluginWebhookCredentialSecretV1,
    encryptPluginWebhookCredentialSecretV1,
} from "./credentialCipher";
import { markPluginWebhookRouteAccountsChangedInTxV1 } from "./accountChange";

const PLUGIN_WEBHOOK_CREDENTIAL_OVERLAP_MS_V1 = 24 * 60 * 60 * 1_000;
const DEFAULT_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1 = 100;
const MAX_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1 = 500;

function assertGitHubRoute(route: Readonly<{
    verifierKind: string;
    currentCredentialId: string | null;
    previousCredentialId: string | null;
}> | null): asserts route is Readonly<{
    verifierKind: "github_hmac_sha256_v1";
    currentCredentialId: string | null;
    previousCredentialId: string | null;
}> {
    if (!route || route.verifierKind !== "github_hmac_sha256_v1") {
        throw new Error("Plugin webhook credential route is unavailable");
    }
}

export async function createInitialPluginWebhookCredentialV1(_params: Readonly<{
    routeId: string;
    credentialVersionId: string;
    secret: string;
}>): Promise<Readonly<{ credentialVersionId: string; secret: string }>> {
    return await inTx(async (tx) => await createInitialPluginWebhookCredentialTxV1(tx, _params));
}

export async function createInitialPluginWebhookCredentialTxV1(tx: Tx, _params: Readonly<{
    routeId: string;
    credentialVersionId: string;
    secret: string;
}>): Promise<Readonly<{ credentialVersionId: string; secret: string }>> {
        const route = await tx.pluginWebhookRoute.findUnique({
            where: { id: _params.routeId },
            select: {
                verifierKind: true,
                currentCredentialId: true,
                previousCredentialId: true,
            },
        });
        assertGitHubRoute(route);
        if (route.currentCredentialId !== null || route.previousCredentialId !== null) {
            throw new Error("Plugin webhook route already has credential custody");
        }

        const encryptedSecret = encryptPluginWebhookCredentialSecretV1({
            routeId: _params.routeId,
            verifierKind: route.verifierKind,
            credentialVersionId: _params.credentialVersionId,
            secret: _params.secret,
        });
        const credential = await tx.pluginWebhookCredential.create({
            data: {
                routeId: _params.routeId,
                credentialVersionId: _params.credentialVersionId,
                verifierKind: route.verifierKind,
                encryptedSecret,
                state: "current",
            },
            select: { id: true },
        });
        const attached = await tx.pluginWebhookRoute.updateMany({
            where: {
                id: _params.routeId,
                currentCredentialId: null,
                previousCredentialId: null,
            },
            data: { currentCredentialId: credential.id },
        });
        if (attached.count !== 1) {
            throw new Error("Plugin webhook route credential currentness changed");
        }
        await markPluginWebhookRouteAccountsChangedInTxV1(tx, _params.routeId);
        return {
            credentialVersionId: _params.credentialVersionId,
            secret: _params.secret,
        };
}

export async function rotatePluginWebhookCredentialV1(_params: Readonly<{
    routeId: string;
    credentialVersionId: string;
    secret: string;
    requestedPreviousAcceptUntil?: Date;
    now?: Date;
}>): Promise<Readonly<{ credentialVersionId: string; secret: string }>> {
    const result = await inTx(async (tx) => await rotatePluginWebhookCredentialTxV1(tx, _params));
    return { credentialVersionId: result.credentialVersionId, secret: result.secret };
}

export async function rotatePluginWebhookCredentialTxV1(tx: Tx, _params: Readonly<{
    routeId: string;
    credentialVersionId: string;
    secret: string;
    requestedPreviousAcceptUntil?: Date;
    now?: Date;
}>): Promise<Readonly<{
    credentialVersionId: string;
    secret: string;
    previousCredentialVersionId: string;
    previousAcceptUntil: Date;
}>> {
    const now = _params.now ?? new Date();
    const maximumAcceptUntil = new Date(now.getTime() + PLUGIN_WEBHOOK_CREDENTIAL_OVERLAP_MS_V1);
    const acceptUntil = _params.requestedPreviousAcceptUntil
        && _params.requestedPreviousAcceptUntil.getTime() < maximumAcceptUntil.getTime()
        ? _params.requestedPreviousAcceptUntil
        : maximumAcceptUntil;

    return await (async () => {
        const route = await tx.pluginWebhookRoute.findUnique({
            where: { id: _params.routeId },
            select: {
                verifierKind: true,
                currentCredentialId: true,
                previousCredentialId: true,
                currentCredential: { select: { credentialVersionId: true } },
            },
        });
        assertGitHubRoute(route);
        if (!route.currentCredentialId || !route.currentCredential) {
            throw new Error("Plugin webhook route has no current credential");
        }

        const encryptedSecret = encryptPluginWebhookCredentialSecretV1({
            routeId: _params.routeId,
            verifierKind: route.verifierKind,
            credentialVersionId: _params.credentialVersionId,
            secret: _params.secret,
        });
        const next = await tx.pluginWebhookCredential.create({
            data: {
                routeId: _params.routeId,
                credentialVersionId: _params.credentialVersionId,
                verifierKind: route.verifierKind,
                encryptedSecret,
                state: "current",
            },
            select: { id: true },
        });
        const previousCurrent = await tx.pluginWebhookCredential.updateMany({
            where: {
                id: route.currentCredentialId,
                routeId: _params.routeId,
                state: "current",
            },
            data: {
                state: "previous",
                acceptUntil,
            },
        });
        if (previousCurrent.count !== 1) {
            throw new Error("Plugin webhook credential currentness changed");
        }
        const rotated = await tx.pluginWebhookRoute.updateMany({
            where: {
                id: _params.routeId,
                currentCredentialId: route.currentCredentialId,
                previousCredentialId: route.previousCredentialId,
            },
            data: {
                currentCredentialId: next.id,
                previousCredentialId: route.currentCredentialId,
            },
        });
        if (rotated.count !== 1) {
            throw new Error("Plugin webhook route credential currentness changed");
        }
        if (route.previousCredentialId) {
            await tx.pluginWebhookCredential.delete({
                where: { id: route.previousCredentialId },
            });
        }
        // A confirmation observed under the superseded secret says nothing
        // about the secret the provider must now be configured with, and every
        // delivery still signed with the old one stops verifying when the
        // overlap ends. Rotation therefore returns every endpoint this route
        // carries to provider-confirmation attention until a delivery verifies
        // under the new credential.
        await tx.pluginWebhookEndpoint.updateMany({
            where: { routeId: _params.routeId, providerConfirmedAt: { not: null } },
            data: { providerConfirmedAt: null },
        });
        await markPluginWebhookRouteAccountsChangedInTxV1(tx, _params.routeId);
        return {
            credentialVersionId: _params.credentialVersionId,
            secret: _params.secret,
            previousCredentialVersionId: route.currentCredential.credentialVersionId,
            previousAcceptUntil: acceptUntil,
        };
    })();
}

export async function readPluginWebhookVerificationCredentialsV1(_params: Readonly<{
    routeId: string;
    now?: Date;
}>): Promise<ReadonlyArray<Readonly<{ credentialVersionId: string; secret: string }>>> {
    const now = _params.now ?? new Date();
    const route = await inTx(async (tx) => {
        const selected = await tx.pluginWebhookRoute.findFirst({
            where: {
                id: _params.routeId,
                enabled: true,
                revokedAt: null,
            },
            select: {
                verifierKind: true,
                currentCredential: {
                    select: {
                        credentialVersionId: true,
                        verifierKind: true,
                        encryptedSecret: true,
                        state: true,
                    },
                },
                previousCredential: {
                    select: {
                        id: true,
                        routeId: true,
                        credentialVersionId: true,
                        verifierKind: true,
                        encryptedSecret: true,
                        state: true,
                        acceptUntil: true,
                    },
                },
            },
        });
        const previous = selected?.previousCredential;
        if (
            previous?.state === "previous"
            && previous.acceptUntil !== null
            && previous.acceptUntil.getTime() <= now.getTime()
        ) {
            const detached = await tx.pluginWebhookRoute.updateMany({
                where: {
                    id: _params.routeId,
                    previousCredentialId: previous.id,
                    NOT: { currentCredentialId: previous.id },
                },
                data: { previousCredentialId: null },
            });
            const deleted = await tx.pluginWebhookCredential.deleteMany({
                where: {
                    id: previous.id,
                    routeId: _params.routeId,
                    state: "previous",
                    acceptUntil: { lte: now },
                    currentForRoute: { is: null },
                    previousForRoute: { is: null },
                },
            });
            if (detached.count === 1 && deleted.count !== 1) {
                throw new Error("Plugin webhook previous credential retirement lost ciphertext custody");
            }
            if (deleted.count > 0) {
                await markPluginWebhookRouteAccountsChangedInTxV1(tx, _params.routeId);
            }
        }
        return selected;
    });
    if (!route || route.verifierKind !== "github_hmac_sha256_v1") return [];

    const credentials: Array<Readonly<{ credentialVersionId: string; secret: string }>> = [];
    const current = route.currentCredential;
    if (current?.state === "current" && current.verifierKind === route.verifierKind) {
        credentials.push({
            credentialVersionId: current.credentialVersionId,
            secret: decryptPluginWebhookCredentialSecretV1({
                routeId: _params.routeId,
                verifierKind: route.verifierKind,
                credentialVersionId: current.credentialVersionId,
                encryptedSecret: Uint8Array.from(current.encryptedSecret),
            }),
        });
    }
    const previous = route.previousCredential;
    if (
        previous?.state === "previous"
        && previous.verifierKind === route.verifierKind
        && previous.acceptUntil !== null
        && previous.acceptUntil.getTime() > now.getTime()
    ) {
        credentials.push({
            credentialVersionId: previous.credentialVersionId,
            secret: decryptPluginWebhookCredentialSecretV1({
                routeId: _params.routeId,
                verifierKind: route.verifierKind,
                credentialVersionId: previous.credentialVersionId,
                encryptedSecret: Uint8Array.from(previous.encryptedSecret),
            }),
        });
    }
    return credentials;
}

export async function retireExpiredPluginWebhookCredentialsV1(params: Readonly<{
    now?: Date;
    batchSize?: number;
}> = {}): Promise<Readonly<{ retired: number }>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1;
    if (
        !Number.isInteger(batchSize)
        || batchSize < 1
        || batchSize > MAX_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1
    ) {
        throw new TypeError("Plugin webhook credential retirement batch size must be an integer from 1 through 500");
    }

    const candidates = await inTx(async (tx) => await tx.pluginWebhookCredential.findMany({
        where: {
            state: "previous",
            acceptUntil: { lte: now },
        },
        orderBy: [{ acceptUntil: "asc" }, { id: "asc" }],
        take: batchSize,
        select: { id: true, routeId: true },
    }));

    let retired = 0;
    for (const candidate of candidates) {
        retired += await inTx(async (tx) => {
            const detached = await tx.pluginWebhookRoute.updateMany({
                where: {
                    id: candidate.routeId,
                    previousCredentialId: candidate.id,
                    NOT: { currentCredentialId: candidate.id },
                },
                data: { previousCredentialId: null },
            });
            const deleted = await tx.pluginWebhookCredential.deleteMany({
                where: {
                    id: candidate.id,
                    routeId: candidate.routeId,
                    state: "previous",
                    acceptUntil: { lte: now },
                    currentForRoute: { is: null },
                    previousForRoute: { is: null },
                },
            });
            if (detached.count === 1 && deleted.count !== 1) {
                throw new Error("Plugin webhook previous credential retirement lost ciphertext custody");
            }
            if (deleted.count > 0) {
                await markPluginWebhookRouteAccountsChangedInTxV1(tx, candidate.routeId);
            }
            return deleted.count;
        });
    }
    return { retired };
}

export async function finishPluginWebhookCredentialRotationV1(params: Readonly<{
    routeId: string;
    expectedPreviousCredentialVersionId: string;
}>): Promise<Readonly<{ kind: "retired" | "alreadyRetired" | "credentialChanged" | "unavailable" }>> {
    return await inTx(async (tx) => await finishPluginWebhookCredentialRotationTxV1(tx, params));
}

export async function finishPluginWebhookCredentialRotationTxV1(tx: Tx, params: Readonly<{
    routeId: string;
    expectedPreviousCredentialVersionId: string;
}>): Promise<Readonly<{ kind: "retired" | "alreadyRetired" | "credentialChanged" | "unavailable" }>> {
        const route = await tx.pluginWebhookRoute.findUnique({
            where: { id: params.routeId },
            select: {
                verifierKind: true,
                previousCredentialId: true,
                previousCredential: {
                    select: {
                        credentialVersionId: true,
                        state: true,
                    },
                },
            },
        });
        if (!route || route.verifierKind !== "github_hmac_sha256_v1") {
            return { kind: "unavailable" };
        }
        if (route.previousCredentialId === null && route.previousCredential === null) {
            return { kind: "alreadyRetired" };
        }
        if (
            route.previousCredentialId === null
            || route.previousCredential === null
            || route.previousCredential.state !== "previous"
            || route.previousCredential.credentialVersionId !== params.expectedPreviousCredentialVersionId
        ) {
            return { kind: "credentialChanged" };
        }

        const detached = await tx.pluginWebhookRoute.updateMany({
            where: {
                id: params.routeId,
                previousCredentialId: route.previousCredentialId,
                NOT: { currentCredentialId: route.previousCredentialId },
            },
            data: { previousCredentialId: null },
        });
        if (detached.count !== 1) return { kind: "credentialChanged" };

        const deleted = await tx.pluginWebhookCredential.deleteMany({
            where: {
                id: route.previousCredentialId,
                routeId: params.routeId,
                state: "previous",
                credentialVersionId: params.expectedPreviousCredentialVersionId,
                currentForRoute: { is: null },
                previousForRoute: { is: null },
            },
        });
        if (deleted.count !== 1) {
            throw new Error("Plugin webhook previous credential retirement lost ciphertext custody");
        }
        await markPluginWebhookRouteAccountsChangedInTxV1(tx, params.routeId);
        return { kind: "retired" };
}
