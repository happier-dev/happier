import { verifyAccountContentPublicKeyBinding } from "@happier-dev/protocol";
import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../../types";
import { z } from "zod";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { describeLoggableError } from "@/utils/logging/describeLoggableError";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { buildNewMachineUpdate, buildUpdateMachineUpdate } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { timingSafeEqual } from "node:crypto";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { parseBooleanEnv } from "@/config/env";
import {
    applyVerifiedMachineRegistrationReplacement,
    MachineRegistrationReplacementError,
    type MachineRegistrationReplacementResult,
} from "@/app/machines/applyVerifiedMachineRegistrationReplacement";
import { invalidateSessionRelayAuthorizationForMachine } from "@/app/api/socket/sessionRelayAuthCache";
import {
    computeContentPublicKeyFingerprint,
    normalizeContentPublicKeyFingerprint,
    verifyMachineInstallationRegistration,
    type VerifiedMachineInstallationIdentity,
} from "@/app/machines/installationProof";
import {
    MACHINE_SERIALIZATION_SELECT,
    serializeMachineRow,
} from "@/app/machines/machineSerialization";
import { registerMachineReplacementRoutes } from "./registerMachineReplacementRoutes";
import { isPlainMachineDataKeyMarker, machineStoredContentMatchesAccountMode } from "@happier-dev/protocol";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { registerMachineContentKeyTransitionRoutes } from "./registerMachineContentKeyTransitionRoutes";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

type ExistingMachineInstallationIdentity = Readonly<{
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
}>;

type InstallationIdentityUpdateResolution =
    | Readonly<{
        ok: true;
        data: {
            installationId?: string;
            installationPublicKey?: Uint8Array<ArrayBuffer>;
            contentPublicKeyFingerprint?: string | null;
        };
    }>
    | Readonly<{ ok: false; reason: string }>;

function resolveInstallationIdentityUpdate(
    machine: ExistingMachineInstallationIdentity,
    identity: VerifiedMachineInstallationIdentity | null,
): InstallationIdentityUpdateResolution {
    if (!identity) {
        return { ok: true, data: {} };
    }

    if (machine.installationId && machine.installationId !== identity.installationId) {
        return { ok: false, reason: "installation_id_mismatch" };
    }
    if (machine.installationPublicKey && !bytesEqual(machine.installationPublicKey, identity.installationPublicKey)) {
        return { ok: false, reason: "installation_public_key_mismatch" };
    }
    if (
        machine.contentPublicKeyFingerprint
        && identity.contentPublicKeyFingerprint
        && machine.contentPublicKeyFingerprint !== identity.contentPublicKeyFingerprint
    ) {
        return { ok: false, reason: "content_public_key_fingerprint_mismatch" };
    }

    return {
        ok: true,
        data: {
            ...(!machine.installationId ? { installationId: identity.installationId } : {}),
            ...(!machine.installationPublicKey ? { installationPublicKey: identity.installationPublicKey } : {}),
            ...(!machine.contentPublicKeyFingerprint && identity.contentPublicKeyFingerprint
                ? { contentPublicKeyFingerprint: identity.contentPublicKeyFingerprint }
                : {}),
        },
    };
}

function isMachineRevokedError(value: unknown): value is { error: 'machine_revoked' } {
    if (typeof value !== 'object' || value === null) return false;
    if (!('error' in value)) return false;
    return (value as { error?: unknown }).error === 'machine_revoked';
}

export function machinesRoutes(app: Fastify) {
    registerMachineContentKeyTransitionRoutes(app);
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Opaque ciphertext or typed plaintext stored content.
                daemonState: z.string().optional(),
                dataEncryptionKey: z.string().nullish(),
                /**
                 * Encrypted DEK registrations may provide their account content public key.
                 * This allows the server to reject token/key mismatches that would otherwise create "poisoned" machine rows.
                 */
                contentPublicKey: z.string().optional(),
                // Optional signature binding `contentPublicKey` to the account's signing key (recommended).
                // When the account has not yet stored its `contentPublicKey`, providing this signature allows the
                // server to persist the key safely without requiring a full /v1/auth key-proof flow.
                contentPublicKeySig: z.string().optional(),
                installationId: z.string().optional(),
                installationPublicKey: z.string().optional(),
                installationProof: z.unknown().optional(),
                replacesMachineId: z.string().optional(),
                replacementReason: z.string().optional(),
                contentPublicKeyFingerprint: z.string().optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const {
            id,
            metadata,
            daemonState,
            dataEncryptionKey,
            contentPublicKey: contentPublicKeyB64,
            contentPublicKeySig: contentPublicKeySigB64,
            installationId,
            installationPublicKey,
            installationProof,
            replacesMachineId,
            replacementReason,
            contentPublicKeyFingerprint,
        } = request.body;

        const plainRegistration = isPlainMachineDataKeyMarker(dataEncryptionKey);
        if (plainRegistration && !isServerFeatureEnabledForRequest('encryption.plaintextMachine', process.env)) {
            return reply.code(404).send({ error: 'not_found' });
        }
        if (!machineStoredContentMatchesAccountMode({
            mode: plainRegistration ? 'plain' : 'e2ee', metadata, daemonState, dataEncryptionKey,
        })) {
            return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
        }
        if (plainRegistration) {
            const account = await db.account.findUnique({
                where: { id: userId }, select: { publicKey: true, encryptionMode: true },
            });
            if (!account || resolveEffectiveAccountEncryptionModeFromAccountRow(account) !== 'plain') {
                return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
            }
        }

        let resolvedContentPublicKeyFingerprint =
            !plainRegistration && typeof contentPublicKeyFingerprint === "string" && contentPublicKeyFingerprint.trim()
                ? contentPublicKeyFingerprint.trim()
                : null;
        if (resolvedContentPublicKeyFingerprint) {
            const normalizedFingerprint = normalizeContentPublicKeyFingerprint(resolvedContentPublicKeyFingerprint);
            if (!normalizedFingerprint) {
                return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_fingerprint_invalid" });
            }
            resolvedContentPublicKeyFingerprint = normalizedFingerprint;
        }

        // Guardrail: for E2EE accounts, reject machine writes that include a DEK envelope but whose
        // claimed content public key does not match the account. Without this, a token/key mismatch
        // can create machine rows that permanently fail DEK decryption for the actual account key.
        if (typeof dataEncryptionKey === "string" && !plainRegistration) {
            const requireContentPublicKeyForDek = parseBooleanEnv(
                process.env.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK,
                false,
            );

            const contentPublicKeyTrimmed = typeof contentPublicKeyB64 === "string" ? contentPublicKeyB64.trim() : "";
            const contentPublicKeySigTrimmed = typeof contentPublicKeySigB64 === "string" ? contentPublicKeySigB64.trim() : "";

            if (!contentPublicKeyTrimmed) {
                if (requireContentPublicKeyForDek) {
                    log(
                        { module: "machines", machineId: id, userId, reason: "content_public_key_required" },
                        "Machine registration rejected (missing contentPublicKey)",
                    );
                    return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_required" });
                }

                // Backward compatibility: older clients may not send `contentPublicKey`. Accept the write,
                // but skip the token/key mismatch guardrail (we cannot validate without a claimed key).
                log(
                    { module: "machines", machineId: id, userId, reason: "content_public_key_missing" },
                    "Machine registration accepted without contentPublicKey (compat mode)",
                );
            } else {
                let decoded: Uint8Array;
                try {
                    decoded = privacyKit.decodeBase64(contentPublicKeyTrimmed);
                } catch {
                    log(
                        { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                        "Machine registration rejected (invalid contentPublicKey)",
                    );
                    return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                }

                if (decoded.length !== tweetnacl.box.publicKeyLength) {
                    log(
                        { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                        "Machine registration rejected (invalid contentPublicKey length)",
                    );
                    return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                }

                const derivedContentPublicKeyFingerprint = computeContentPublicKeyFingerprint(decoded);
                if (
                    resolvedContentPublicKeyFingerprint
                    && resolvedContentPublicKeyFingerprint !== derivedContentPublicKeyFingerprint
                ) {
                    log(
                        { module: "machines", machineId: id, userId, reason: "content_public_key_fingerprint_mismatch" },
                        "Machine registration rejected (contentPublicKeyFingerprint mismatch)",
                    );
                    return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_fingerprint_mismatch" });
                }
                resolvedContentPublicKeyFingerprint = derivedContentPublicKeyFingerprint;

                const account = await db.account.findUnique({
                    where: { id: userId },
                    select: { contentPublicKey: true, publicKey: true },
                });

                let accountContentPublicKey: Uint8Array | null = account?.contentPublicKey ?? null;
                if (!accountContentPublicKey) {
                    if (contentPublicKeySigTrimmed) {
                        let decodedSig: Uint8Array;
                        try {
                            decodedSig = privacyKit.decodeBase64(contentPublicKeySigTrimmed);
                        } catch {
                            log(
                                { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                                "Machine registration rejected (invalid contentPublicKeySig)",
                            );
                            return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                        }

                        if (decodedSig.length !== tweetnacl.sign.signatureLength) {
                            log(
                                { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                                "Machine registration rejected (invalid contentPublicKeySig length)",
                            );
                            return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                        }

                        const publicKeyHex = typeof account?.publicKey === "string" ? account.publicKey : "";
                        const expectedHexLength = tweetnacl.sign.publicKeyLength * 2;
                        if (!publicKeyHex || publicKeyHex.length !== expectedHexLength || !/^[0-9a-f]+$/i.test(publicKeyHex)) {
                            log(
                                { module: "machines", machineId: id, userId, reason: "account_missing_public_key" },
                                "Machine registration rejected (account publicKey invalid/missing)",
                            );
                            return reply.code(500).send({ error: "internal" });
                        }

                        const contentSigOk = verifyAccountContentPublicKeyBinding({
                            signingPublicKeyHex: publicKeyHex,
                            contentPublicKeyB64: contentPublicKeyTrimmed,
                            contentPublicKeySigB64: contentPublicKeySigTrimmed,
                        });
                        if (!contentSigOk) {
                            log(
                                { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                                "Machine registration rejected (invalid contentPublicKeySig binding)",
                            );
                            return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                        }

                        // Prisma bytes fields require ArrayBuffer-backed Uint8Array (not SharedArrayBuffer).
                        const contentPublicKeyCopy = new Uint8Array(decoded.byteLength);
                        contentPublicKeyCopy.set(decoded);
                        const contentPublicKeySigCopy = new Uint8Array(decodedSig.byteLength);
                        contentPublicKeySigCopy.set(decodedSig);

                        const updated = await db.account.updateMany({
                            where: { id: userId, contentPublicKey: null },
                            data: { contentPublicKey: contentPublicKeyCopy, contentPublicKeySig: contentPublicKeySigCopy },
                        });
                        if (updated.count > 0) {
                            accountContentPublicKey = contentPublicKeyCopy;
                        } else {
                            const refetched = await db.account.findUnique({
                                where: { id: userId },
                                select: { contentPublicKey: true },
                            });
                            accountContentPublicKey = refetched?.contentPublicKey ?? null;
                        }
                    }
                }

                if (!accountContentPublicKey) {
                    if (requireContentPublicKeyForDek) {
                        log(
                            { module: "machines", machineId: id, userId, reason: "account_missing_content_public_key" },
                            "Machine registration rejected (account missing contentPublicKey)",
                        );
                        return reply.code(400).send({ error: "invalid-params", reason: "account_missing_content_public_key" });
                    }

                    log(
                        { module: "machines", machineId: id, userId, reason: "account_missing_content_public_key" },
                        "Machine registration accepted without account contentPublicKey (compat mode)",
                    );
                    // Backward compatibility: some older accounts may not have stored their content public key yet.
                    // Without it, we cannot validate token/key mismatches for DEK-bearing machine registrations.
                }

                if (accountContentPublicKey && !bytesEqual(accountContentPublicKey, decoded)) {
                    log(
                        { module: "machines", machineId: id, userId, reason: "content_public_key_mismatch" },
                        "Machine registration rejected (contentPublicKey mismatch)",
                    );
                    return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_mismatch" });
                }
            }
        }

        const automaticReplacementReason = typeof replacementReason === "string" && replacementReason.trim()
            ? replacementReason.trim()
            : "machine_rotation";

        const installationRegistration = verifyMachineInstallationRegistration({
            accountId: userId,
            machineId: id,
            installationId,
            installationPublicKey,
            installationProof,
            replacesMachineId,
            replacementReason: automaticReplacementReason,
            contentPublicKeyFingerprint: resolvedContentPublicKeyFingerprint,
        });
        if (!installationRegistration.ok) {
            return reply.code(400).send({ error: "invalid-params", reason: installationRegistration.reason });
        }
        const verifiedInstallationIdentity = installationRegistration.identity;

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            if (machine.revokedAt) {
                return reply.code(410).send({ error: 'machine_revoked' });
            }
            if (plainRegistration !== isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) {
                return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
            }

            const nextDataEncryptionKey =
                dataEncryptionKey === null
                    ? null
                    : typeof dataEncryptionKey === 'string'
                        ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                        : undefined;

            const registrationKeyDiffers =
                nextDataEncryptionKey === undefined
                    ? (machine.dataEncryptionKey ?? null) !== null
                    : !bytesEqual(machine.dataEncryptionKey ?? null, nextDataEncryptionKey);
            if (plainRegistration && registrationKeyDiffers) {
                return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
            }
            // Registration cannot change the key without converting both incumbent ciphertexts.
            // A randomized re-seal may represent the same key, so return the incumbent content
            // for the client to open rather than guessing which key encrypted its new state.
            const wantsDaemonStateUpdate = !plainRegistration && !registrationKeyDiffers
                && typeof daemonState === 'string' && daemonState !== (machine.daemonState ?? null);
            const installationIdentityUpdate = resolveInstallationIdentityUpdate(machine, verifiedInstallationIdentity);
            if (!installationIdentityUpdate.ok) {
                return reply.code(400).send({ error: "invalid-params", reason: installationIdentityUpdate.reason });
            }
            if (registrationKeyDiffers) delete installationIdentityUpdate.data.contentPublicKeyFingerprint;
            const wantsInstallationUpdate = Object.keys(installationIdentityUpdate.data).length > 0;

            const wantsAutomaticReplacement = Boolean(verifiedInstallationIdentity?.replacesMachineId);

            if (
                !wantsDaemonStateUpdate
                && !wantsInstallationUpdate
                && !wantsAutomaticReplacement
            ) {
                // Machine exists and payload matches - just return it.
                // Note: This checks the pre-tx row (which may be slightly stale under concurrency),
                // but the response is still safe and consistent for the authenticated account.
                log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
                return reply.send({
                    machine: {
                        ...serializeMachineRow(machine),
                    }
                });
            }

            log({ module: 'machines', machineId: id, userId }, 'Updating existing machine');

            type UpdatedMachineRow = Parameters<typeof serializeMachineRow>[0] | null | { error: 'machine_revoked' } | { error: 'invalid_installation_identity'; reason: string };
            let updated: UpdatedMachineRow;
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            try {
                updated = await inTx(async (tx) => {
                    const current = await tx.machine.findFirst({
                        where: {
                            accountId: userId,
                            id,
                        },
                    });
                    if (!current) return null;
                    if (current.revokedAt) return { error: 'machine_revoked' as const };
                    if (plainRegistration !== isPlainMachineDataKeyMarker(current.dataEncryptionKey)) {
                        return { error: 'invalid_installation_identity' as const, reason: 'machine_storage_mode_mismatch' };
                    }

                    const currentRegistrationKeyDiffers =
                        nextDataEncryptionKey === undefined
                            ? (current.dataEncryptionKey ?? null) !== null
                            : !bytesEqual(current.dataEncryptionKey ?? null, nextDataEncryptionKey);
                    if (plainRegistration && currentRegistrationKeyDiffers) {
                        return { error: 'invalid_installation_identity' as const, reason: 'machine_storage_mode_mismatch' };
                    }
                    const currentWantsDaemonStateUpdate = !plainRegistration && !currentRegistrationKeyDiffers
                        && typeof daemonState === 'string' && daemonState !== (current.daemonState ?? null);
                    const currentInstallationIdentityUpdate = resolveInstallationIdentityUpdate(current, verifiedInstallationIdentity);
                    if (!currentInstallationIdentityUpdate.ok) {
                        return { error: 'invalid_installation_identity' as const, reason: currentInstallationIdentityUpdate.reason };
                    }
                    if (currentRegistrationKeyDiffers) delete currentInstallationIdentityUpdate.data.contentPublicKeyFingerprint;
                    const currentWantsInstallationUpdate = Object.keys(currentInstallationIdentityUpdate.data).length > 0;
                    const currentWantsAutomaticReplacement = Boolean(verifiedInstallationIdentity?.replacesMachineId);

                    if (
                        !currentWantsDaemonStateUpdate
                        && !currentWantsInstallationUpdate
                        && !currentWantsAutomaticReplacement
                    ) {
                        return current;
                    }

                    // Registration metadata is create-only. Existing metadata also contains
                    // user-owned fields such as displayName, and the server cannot merge its
                    // encrypted value. Daemons refresh their owned fields through the versioned
                    // machine-update-metadata socket after registration.
                    const updatedMachine = currentWantsDaemonStateUpdate
                        || currentWantsInstallationUpdate
                        ? await tx.machine.update({
                            where: { accountId_id: { accountId: userId, id } },
                            data: {
                                ...(currentWantsDaemonStateUpdate
                                    ? { daemonState, daemonStateVersion: { increment: 1 } }
                                    : {}),
                                ...(currentWantsInstallationUpdate && verifiedInstallationIdentity
                                    ? currentInstallationIdentityUpdate.data
                                    : {}),
                            },
                        })
                        : current;

                    if (
                        currentWantsDaemonStateUpdate
                        || currentWantsInstallationUpdate
                    ) {
                        await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: updatedMachine.id });
                    }

                    if (verifiedInstallationIdentity?.replacesMachineId) {
                        machineReplacement = await applyVerifiedMachineRegistrationReplacement({
                            tx,
                            accountId: userId,
                            replacementMachineId: updatedMachine.id,
                            replacementMachine: updatedMachine,
                            replacesMachineId: verifiedInstallationIdentity.replacesMachineId,
                            reason: automaticReplacementReason,
                        });
                    }

                    return updatedMachine;
                });
            } catch (error) {
                if (error instanceof MachineRegistrationReplacementError) {
                    return reply.code(error.statusCode).send({ error: "invalid-params", reason: error.reason });
                }
                // Control-plane guardrail: when SQLite is under heavy contention, starting an interactive transaction
                // can fail (P2028/P1008) which would brick daemon startup/session spawning. Degrade only for
                // best-effort registration refreshes; content-key changes use their own atomic transition.
                if (isPrismaErrorCode(error, 'P2028') || isPrismaErrorCode(error, 'P1008')) {
                    log(
                        {
                            module: 'machines',
                            level: 'warn',
                            machineId: id,
                            userId,
                            reason: 'tx_busy',
                            error: describeLoggableError(error),
                        },
                        'Machine update skipped due to transaction contention',
                    );
                    return reply.send({
                        machine: {
                            ...serializeMachineRow(machine),
                        },
                    });
                }
                throw error;
            }

            if (!updated) {
                // Machine disappeared between the initial lookup and the transaction.
                return reply.code(404).send({ error: "machine_not_found" });
            }

            if (isMachineRevokedError(updated)) {
                return reply.code(410).send({ error: 'machine_revoked' });
            }

            if (typeof updated === 'object' && updated && 'error' in updated && updated.error === 'invalid_installation_identity') {
                return reply.code(400).send({ error: "invalid-params", reason: updated.reason });
            }

            return reply.send({
                machine: {
                    ...serializeMachineRow(updated),
                },
                ...(machineReplacement ? { machineReplacement } : {}),
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            let newMachine;
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            try {
                newMachine = await inTx(async (tx) => {
                    if (plainRegistration) {
                        // The preliminary read can precede an Account migration. Read again in
                        // the same serializable transaction as insertion so its census cannot miss us.
                        const account = await tx.account.findUnique({
                            where: { id: userId }, select: { publicKey: true, encryptionMode: true },
                        });
                        if (!account || resolveEffectiveAccountEncryptionModeFromAccountRow(account) !== 'plain') return null;
                    }
                    const created = await tx.machine.create({
                        data: {
                            id,
                            accountId: userId,
                            metadata,
                            metadataVersion: 1,
                            daemonState: daemonState || null,
                            daemonStateVersion: daemonState ? 1 : 0,
                            dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                            ...(verifiedInstallationIdentity
                                ? {
                                    installationId: verifiedInstallationIdentity.installationId,
                                    installationPublicKey: verifiedInstallationIdentity.installationPublicKey,
                                    contentPublicKeyFingerprint: verifiedInstallationIdentity.contentPublicKeyFingerprint,
                                }
                                : resolvedContentPublicKeyFingerprint
                                    ? { contentPublicKeyFingerprint: resolvedContentPublicKeyFingerprint }
                                    : {}),
                            // Default to offline - in case the user does not start daemon
                            active: false,
                            // lastActiveAt and activeAt defaults to now() in schema
                        }
                    });

                    if (verifiedInstallationIdentity?.replacesMachineId) {
                        machineReplacement = await applyVerifiedMachineRegistrationReplacement({
                            tx,
                            accountId: userId,
                            replacementMachineId: created.id,
                            replacementMachine: created,
                            replacesMachineId: verifiedInstallationIdentity.replacesMachineId,
                            reason: automaticReplacementReason,
                        });
                    }

                    const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: created.id });

                    afterTx(tx, () => {
                        // Emit both new-machine and update-machine events for backward compatibility.
                        // IMPORTANT: Both share the same cursor (one durable change).
                        const newMachinePayload = buildNewMachineUpdate(created, cursor, randomKeyNaked(12));
                        eventRouter.emitUpdate({
                            userId,
                            payload: newMachinePayload,
                            recipientFilter: { type: 'user-scoped-only' }
                        });

                        const machineMetadata = { version: 1, value: metadata };
                        const updatePayload = buildUpdateMachineUpdate(created.id, cursor, randomKeyNaked(12), machineMetadata);
                        eventRouter.emitUpdate({
                            userId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId: created.id }
                        });
                    });

                    return created;
                });
            } catch (e) {
                if (e instanceof MachineRegistrationReplacementError) {
                    return reply.code(e.statusCode).send({ error: "invalid-params", reason: e.reason });
                }
                // Concurrency safety: multiple clients may race to create the same machine (e.g. daemon + session spawns).
                // If we lost the race, fetch the winner row and return it instead of surfacing a 500.
                if (isPrismaErrorCode(e, 'P2002')) {
                    const existingSameAccount = await db.machine.findFirst({ where: { accountId: userId, id } });
                    if (existingSameAccount) {
                        if (existingSameAccount.revokedAt) {
                            return reply.code(410).send({ error: 'machine_revoked' });
                        }
                        if (plainRegistration !== isPlainMachineDataKeyMarker(existingSameAccount.dataEncryptionKey)) {
                            return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
                        }
                        let concurrentMachineReplacement: MachineRegistrationReplacementResult | null = null;
                        if (verifiedInstallationIdentity?.replacesMachineId) {
                            try {
                                await inTx(async (tx) => {
                                    concurrentMachineReplacement = await applyVerifiedMachineRegistrationReplacement({
                                        tx,
                                        accountId: userId,
                                        replacementMachineId: existingSameAccount.id,
                                        replacementMachine: existingSameAccount,
                                        replacesMachineId: verifiedInstallationIdentity.replacesMachineId,
                                        reason: automaticReplacementReason,
                                    });
                                    return null;
                                });
                            } catch (replacementError) {
                                if (replacementError instanceof MachineRegistrationReplacementError) {
                                    return reply.code(replacementError.statusCode).send({
                                        error: "invalid-params",
                                        reason: replacementError.reason,
                                    });
                                }
                                throw replacementError;
                            }
                        }
                        log({ module: 'machines', machineId: id, userId }, 'Machine created concurrently; returning existing machine');
                        return reply.send({
                            machine: {
                                ...serializeMachineRow(existingSameAccount),
                            },
                            ...(concurrentMachineReplacement ? { machineReplacement: concurrentMachineReplacement } : {}),
                        });
                    }

                    // Unique violation but no row for this account: id is owned elsewhere.
                    log({ module: 'machines', machineId: id, userId }, 'Machine id conflict: machine id belongs to another account');
                    return reply
                        .code(409)
                        .send({ error: 'machine_id_conflict', message: 'This machine id is already registered to another account' });
                }
                throw e;
            }

            if (!newMachine) {
                return reply.code(400).send({ error: 'invalid-params', reason: 'machine_storage_mode_mismatch' });
            }
            return reply.send({
                machine: {
                    ...serializeMachineRow(newMachine),
                },
                ...(machineReplacement ? { machineReplacement } : {}),
            });
        }
    });

    // POST /v1/machines/:id/revoke - revoke/forget a machine and invalidate its access.
    app.post('/v1/machines/:id/revoke', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const result = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: {
                    accountId: userId,
                    id,
                },
            });
            if (!machine) return { kind: 'not_found' as const };

            const now = new Date();
            const revokedAt = machine.revokedAt ?? now;

            const updated = await tx.machine.update({
                where: { accountId_id: { accountId: userId, id } },
                data: {
                    active: false,
                    revokedAt,
                },
            });

            await tx.accessKey.deleteMany({
                where: {
                    accountId: userId,
                    machineId: id,
                },
            });

            await tx.automationAssignment.deleteMany({
                where: {
                    machineId: id,
                },
            });

            const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: updated.id });

            afterTx(tx, () => {
                const updatePayload = buildUpdateMachineUpdate(
                    updated.id,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    { active: false, revokedAt: revokedAt.getTime() },
                );
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' },
                });
                activityCache.invalidateMachine(updated.id);
                invalidateSessionRelayAuthorizationForMachine(updated.id);
            });

            return { kind: 'ok' as const, machine: updated };
        });

        if (result.kind === 'not_found') {
            return reply.code(404).send({ error: 'machine_not_found' });
        }

        return reply.send({ machine: serializeMachineRow(result.machine) });
    });

    registerMachineReplacementRoutes(app);


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "machines"),
        },
    }, async (request, reply) => {
        const userId = request.userId;

        // The response is a bare array with no pagination metadata, so this read stays unbounded:
        // a row cap here would be silent truncation a client could not detect. The cost guard is
        // the explicit projection, which keeps the payload to the columns the serializer emits.
        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' },
            select: MACHINE_SERIALIZATION_SELECT,
        });

        return machines.map(serializeMachineRow);
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "machines"),
        },
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                ...serializeMachineRow(machine),
            }
        };
    });

}
