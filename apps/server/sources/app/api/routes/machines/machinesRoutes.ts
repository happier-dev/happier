import { Fastify } from "../../types";
import { persistentMachineWhere } from '@/app/machines/machineSelection';
import { z } from "zod";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { timingSafeEqual } from "node:crypto";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { parseBooleanEnv } from "@/config/env";
import { admitAccountContentKey } from "@/app/encryption/accountContentKeyAdmission";
import {
    applyVerifiedMachineRegistrationReplacement,
    MachineRegistrationReplacementError,
    type MachineRegistrationReplacementResult,
} from "@/app/machines/applyVerifiedMachineRegistrationReplacement";
import {
    computeContentPublicKeyFingerprint,
    normalizeContentPublicKeyFingerprint,
    validateMachineInstallationProof,
    type VerifiedMachineInstallationIdentity,
} from "@/app/machines/installationProof";
import {
    createMachineWithInstallationIdentityInTx,
    revokeMachineInTx,
} from "@/app/machines/machineMutations";
import {
    serializeExternalActionMachineBootstrapRow,
    serializeMachineRow,
    serializeAccessibleMachineRow,
    type MachineSerializationRow,
} from "@/app/machines/machineSerialization";
import type { FastifyRequest } from "fastify";
import {
    isPlainMachineDataKeyMarker,
    machineStoredContentMatchesAccountMode,
    machineUpdateMatchesStoredMode,
} from "@happier-dev/protocol";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { registerMachineReplacementRoutes } from "./registerMachineReplacementRoutes";
import { registerMachineAdmissionRoutes } from "./registerMachineAdmissionRoutes";
import { registerMachinePoolRoutes } from "./pools/registerMachinePoolRoutes";
import { registerMachinePresetRoutes } from "./managed/registerMachinePresetRoutes";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { ManagedEnrollmentCorrelationV1Schema } from "@happier-dev/protocol";
import { registerManagedMachineRoutes } from "@/app/machines/managed/managedRoutes";
import { requireManagedMachineRegistrationInTx, linkManagedEnrollmentInTx } from "@/app/machines/managed/managedMutations";
import { ManagedMachineError, readMachineDevcontainerChildInTx } from "@/app/machines/managed/managedRows";
import { MachineContentKeyTransitionInputV1Schema, MachineContentKeyTransitionResultV1Schema } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";
import { transitionMachineContentKeyInTx } from "@/app/machines/transitionMachineContentKeyInTx";
import { readCurrentManagedGuestActivityInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { registerMachineAccessRoutes } from './machineAccessRoutes';
import {
    listMachineCandidatesInTx,
    readAccessibleMachineAccessInTx,
    readMachineDataKeyForCallerInTx,
} from '@/app/machines/machineAccess';

async function readAccessibleMachineProjectionInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; machineId: string; request: FastifyRequest }>,
) {
    const access = await readAccessibleMachineAccessInTx(tx, input);
    if (!access) return null;
    const owned = access.custodian.accountId === input.actorAccountId;
    const machine = await tx.machine.findUnique({ where: { id: input.machineId } });
    if (!machine) return null;
    const callerDataEncryptionKey = owned
        ? machine.dataEncryptionKey
        : await readMachineDataKeyForCallerInTx(tx, input);
    return {
        machine,
        owned,
        access,
        callerDataEncryptionKey,
        projection: serializeAccessibleMachineRow(machine, {
            devcontainerChild: await readMachineDevcontainerChildInTx(tx, machine.id),
            access,
            owned,
            callerDataEncryptionKey,
            recipientAccountStoredContentProtocolVersion:
                readAccountStoredContentCompatibilityForHttpRequest(input.request).declaration?.protocolVersion,
        }),
    };
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function isMachineRevokedError(value: unknown): value is { error: 'machine_revoked' } {
    if (typeof value !== 'object' || value === null) return false;
    if (!('error' in value)) return false;
    return (value as { error?: unknown }).error === 'machine_revoked';
}

async function serializeMachineRowForRequest(
    row: MachineSerializationRow,
    request: FastifyRequest,
    storageMode?: "plain" | "e2ee",
) {
    return serializeMachineRow(row, {
        devcontainerChild: await inTx(tx => readMachineDevcontainerChildInTx(tx, row.id)),
        ...(storageMode ? { storageMode } : {}),
        recipientAccountStoredContentProtocolVersion:
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .declaration?.protocolVersion,
    });
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

function describeUnknownError(error: unknown): { code?: string; message: string } {
    if (error instanceof Error) {
        const codeCandidate = (error as Error & { code?: unknown }).code;
        const code = typeof codeCandidate === 'string' ? codeCandidate : undefined;
        return {
            ...(code ? { code } : {}),
            message: error.message,
        };
    }
    if (typeof error === 'string') {
        return { message: error };
    }
    return { message: String(error) };
}

export function machinesRoutes(app: Fastify) {
    registerMachineAdmissionRoutes(app);
    registerMachineAccessRoutes(app);
    registerMachineReplacementRoutes(app);
    registerMachinePoolRoutes(app, { io: app.machineDaemonPresence });
    registerMachinePresetRoutes(app);
    registerManagedMachineRoutes(app);

    app.post('/v1/machines/:id/content-key/transition', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string().min(1) }).strict(),
            body: z.unknown(),
            response: { 200: MachineContentKeyTransitionResultV1Schema, 400: z.object({ error: z.literal("invalid-params") }) },
        },
    }, async (request, reply) => {
        const parsed = MachineContentKeyTransitionInputV1Schema.safeParse(request.body);
        if (!parsed.success || parsed.data.machineId !== request.params.id) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        return reply.send(await inTx((tx) => transitionMachineContentKeyInTx({
            tx, accountId: request.userId, input: parsed.data,
        })));
    });

    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish(),
                /**
                 * When an E2EE `dataEncryptionKey` is provided, the client must also provide its account content public key.
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
                managedEnrollment: ManagedEnrollmentCorrelationV1Schema.optional(),
            })
        }
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
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
            managedEnrollment,
        } = request.body;
        const accountStorageState = await db.account.findUnique({
            where: { id: userId },
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        if (!accountStorageState) {
            return reply.code(500).send({ error: "internal" });
        }
        const accountCurrentness =
            deriveAccountEncryptionCurrentnessFromRow(
            accountStorageState,
        );
        if (accountCurrentness.status === "inconsistent") {
            return reply.code(400).send({
                error: "invalid-params",
                reason: "machine_storage_mode_mismatch",
            });
        }
        const accountMode =
            accountCurrentness.currentness.encryptionMode;
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id,
            },
        });
        const proposedDataEncryptionKey = machine && dataEncryptionKey === undefined
            ? machine.dataEncryptionKey
            : dataEncryptionKey;
        const machineContentMatchesMode = machine
            ? (
                machineStoredContentMatchesAccountMode({
                    mode: accountMode, storedRead: true,
                    metadata: machine.metadata,
                    ...(machine.daemonState === null ? {} : { daemonState: machine.daemonState }),
                    dataEncryptionKey: machine.dataEncryptionKey,
                })
                && machineUpdateMatchesStoredMode({
                    dataEncryptionKey: machine.dataEncryptionKey,
                    metadata,
                    ...(typeof daemonState === "string" ? { daemonState } : {}),
                })
                && machineUpdateMatchesStoredMode({
                    dataEncryptionKey: proposedDataEncryptionKey,
                    metadata,
                    ...(typeof daemonState === "string" ? { daemonState } : {}),
                })
            )
            : machineStoredContentMatchesAccountMode({
                mode: accountMode,
                metadata,
                ...(typeof daemonState === "string" ? { daemonState } : {}),
                dataEncryptionKey,
            });
        if (!machineContentMatchesMode) {
            return reply.code(400).send({
                error: "invalid-params",
                reason: "machine_storage_mode_mismatch",
            });
        }
        const machineStorageMode = accountMode;
        const storedContentCompatibility =
            readAccountStoredContentCompatibilityForHttpRequest(request);
        if (
            machineStorageMode === "plain"
            && !storedContentCompatibility.supportsCurrentProtocol
        ) {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            );
            return;
        }
        let resolvedContentPublicKeyFingerprint =
            typeof contentPublicKeyFingerprint === "string" && contentPublicKeyFingerprint.trim()
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
        if (machineStorageMode === "e2ee" && typeof dataEncryptionKey === "string") {
            const requireContentPublicKeyForDek = parseBooleanEnv(
                requestHomeEnv.HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK,
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

                let accountContentPublicKey: Uint8Array | null = null;
                if (contentPublicKeySigTrimmed) {
                    let decodedSignature: Uint8Array;
                    try {
                        decodedSignature = privacyKit.decodeBase64(
                            contentPublicKeySigTrimmed,
                        );
                    } catch {
                        log(
                            { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                            "Machine registration rejected (invalid contentPublicKeySig)",
                        );
                        return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                    }
                    const admission = await admitAccountContentKey(db, {
                        accountId: userId,
                        contentPublicKey: decoded,
                        contentPublicKeySignature: decodedSignature,
                    });
                    if (admission.status === "key_mismatch") {
                        log(
                            { module: "machines", machineId: id, userId, reason: "content_public_key_mismatch" },
                            "Machine registration rejected (contentPublicKey mismatch)",
                        );
                        return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_mismatch" });
                    }
                    if (admission.status === "invalid_binding") {
                        log(
                            { module: "machines", machineId: id, userId, reason: "content_public_key_invalid" },
                            "Machine registration rejected (invalid contentPublicKeySig binding)",
                        );
                        return reply.code(400).send({ error: "invalid-params", reason: "content_public_key_invalid" });
                    }
                    if (admission.status === "account_not_found") {
                        log(
                            { module: "machines", machineId: id, userId, reason: "account_missing" },
                            "Machine registration rejected (account missing)",
                        );
                        return reply.code(500).send({ error: "internal" });
                    }
                    if (!("binding" in admission)) {
                        return reply.code(500).send({
                            error: "internal",
                        });
                    }
                    accountContentPublicKey =
                        admission.binding.contentPublicKey;
                } else {
                    accountContentPublicKey =
                        accountStorageState.contentPublicKey ?? null;
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

        const installationRegistration = validateMachineInstallationProof({
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
        if (managedEnrollment && !verifiedInstallationIdentity) {
            return reply.code(400).send({ error: "invalid-params", reason: "installation_identity_required" });
        }

        if (machine) {
            if (machine.revokedAt) {
                return reply.code(410).send({ error: 'machine_revoked' });
            }

            const installationIdentityUpdate = resolveInstallationIdentityUpdate(machine, verifiedInstallationIdentity);
            if (!installationIdentityUpdate.ok) {
                return reply.code(400).send({ error: "invalid-params", reason: installationIdentityUpdate.reason });
            }
            const wantsInstallationUpdate = Object.keys(installationIdentityUpdate.data).length > 0;
            const wantsAutomaticReplacement = Boolean(verifiedInstallationIdentity?.replacesMachineId);

            if (
                !wantsInstallationUpdate
                && !wantsAutomaticReplacement
                && !managedEnrollment
            ) {
                try {
                    await inTx(tx => requireManagedMachineRegistrationInTx(tx, { custodianAccountId: userId, machineId: id }), { readOnly: true });
                } catch (error) {
                    if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                    throw error;
                }
                // Registration content is create-only: adopt the winning content basis.
                // Note: This checks the pre-tx row (which may be slightly stale under concurrency),
                // but the response is still safe and consistent for the authenticated account.
                log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
                return reply.send({
                    machine: {
                        ...await serializeMachineRowForRequest(machine, request, accountMode),
                    }
                });
            }

            log({ module: 'machines', machineId: id, userId }, 'Updating existing machine');

            type UpdatedMachineRow =
                | Parameters<typeof serializeMachineRow>[0]
                | null
                | { error: 'machine_revoked' }
                | { error: 'invalid_installation_identity'; reason: string }
                | { error: 'machine_storage_mode_mismatch' };
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            let updated: UpdatedMachineRow;
            try {
                updated = await inTx(async (tx) => {
                    await requireManagedMachineRegistrationInTx(tx, { custodianAccountId: userId, machineId: id, enrollment: managedEnrollment });
                    const current = await tx.machine.findFirst({
                        where: {
                            accountId: userId,
                            id,
                        },
                    });
                    if (!current) return null;
                    if (current.revokedAt) return { error: 'machine_revoked' as const };

                    const currentProposedDataEncryptionKey = dataEncryptionKey === undefined
                        ? current.dataEncryptionKey
                        : dataEncryptionKey;
                    if (
                        !machineUpdateMatchesStoredMode({
                            dataEncryptionKey: current.dataEncryptionKey,
                            metadata,
                            ...(typeof daemonState === "string" ? { daemonState } : {}),
                        })
                        || !machineUpdateMatchesStoredMode({
                            dataEncryptionKey: currentProposedDataEncryptionKey,
                            metadata,
                            ...(typeof daemonState === "string" ? { daemonState } : {}),
                        })
                    ) {
                        return { error: 'machine_storage_mode_mismatch' as const };
                    }

                    const currentInstallationIdentityUpdate = resolveInstallationIdentityUpdate(current, verifiedInstallationIdentity);
                    if (!currentInstallationIdentityUpdate.ok) {
                        return { error: 'invalid_installation_identity' as const, reason: currentInstallationIdentityUpdate.reason };
                    }
                    const currentWantsInstallationUpdate = Object.keys(currentInstallationIdentityUpdate.data).length > 0;
                    const currentWantsAutomaticReplacement = Boolean(verifiedInstallationIdentity?.replacesMachineId);

                    if (
                        !currentWantsInstallationUpdate
                        && !currentWantsAutomaticReplacement
                    ) {
                        if (managedEnrollment) await linkManagedEnrollmentInTx(tx, managedEnrollment, userId, current.id);
                        return current;
                    }

                    // Registration metadata/state/envelope are create-only. Existing metadata also contains
                    // user-owned fields such as displayName, and the server cannot merge its
                    // encrypted value. Daemons refresh their owned fields through the versioned
                    // machine-update-metadata socket after registration.
                    const updatedMachine = currentWantsInstallationUpdate
                        ? await tx.machine.update({
                            where: { accountId_id: { accountId: userId, id } },
                            data: {
                                ...(currentWantsInstallationUpdate && verifiedInstallationIdentity
                                    ? currentInstallationIdentityUpdate.data
                                    : {}),
                            },
                        })
                        : current;

                    if (
                        currentWantsInstallationUpdate
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

                    if (managedEnrollment) await linkManagedEnrollmentInTx(tx, managedEnrollment, userId, updatedMachine.id);
                    return updatedMachine;
                });
            } catch (error) {
                if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                if (error instanceof MachineRegistrationReplacementError) {
                    return reply.code(error.statusCode).send({ error: "invalid-params", reason: error.reason });
                }
                if (managedEnrollment && (isPrismaErrorCode(error, 'P2028') || isPrismaErrorCode(error, 'P1008'))) {
                    throw error;
                }

                // Control-plane guardrail: when SQLite is under heavy contention, starting an interactive transaction
                // can fail (P2028/P1008) which would brick daemon startup/session spawning. Degrade only for
                // best-effort installation refreshes. Content/key replacement is never a registration write.
                if (isPrismaErrorCode(error, 'P2028') || isPrismaErrorCode(error, 'P1008')) {
                    try {
                        await inTx(tx => requireManagedMachineRegistrationInTx(tx, { custodianAccountId: userId, machineId: id }), { readOnly: true });
                    } catch (currentnessError) {
                        if (currentnessError instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: currentnessError.code });
                        throw currentnessError;
                    }
                    log(
                        {
                            module: 'machines',
                            level: 'warn',
                            machineId: id,
                            userId,
                            reason: 'tx_busy',
                            error: describeUnknownError(error),
                        },
                        'Machine update skipped due to transaction contention',
                    );
                    return reply.send({
                        machine: {
                            ...await serializeMachineRowForRequest(machine, request, accountMode),
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

            if (typeof updated === 'object' && updated && 'error' in updated && updated.error === 'machine_storage_mode_mismatch') {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason: "machine_storage_mode_mismatch",
                });
            }

            return reply.send({
                machine: {
                    ...await serializeMachineRowForRequest(updated, request, accountMode),
                },
                ...(machineReplacement ? { machineReplacement } : {}),
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            let newMachine;
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            try {
                const created = await inTx(async (tx) => {
                    await requireManagedMachineRegistrationInTx(tx, { custodianAccountId: userId, machineId: id, enrollment: managedEnrollment });
                    const registered = await createMachineWithInstallationIdentityInTx(tx, {
                    accountId: userId,
                    machineId: id,
                    metadata,
                    daemonState,
                    dataEncryptionKey,
                    installationIdentity: verifiedInstallationIdentity,
                    contentPublicKeyFingerprint: resolvedContentPublicKeyFingerprint,
                    replacementReason: automaticReplacementReason,
                    managedEnrollment,
                    });
                    return registered;
                });
                newMachine = created.machine;
                machineReplacement = created.machineReplacement;
            } catch (e) {
                if (e instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: e.code });
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
                        if (
                            isPlainMachineDataKeyMarker(existingSameAccount.dataEncryptionKey)
                            && !storedContentCompatibility.supportsCurrentProtocol
                        ) {
                            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                                request,
                                reply,
                            );
                            return;
                        }
                        let rejoinedMachine = existingSameAccount;
                        {
                            try {
                                rejoinedMachine = await inTx(async tx => {
                                    await requireManagedMachineRegistrationInTx(tx, { custodianAccountId: userId, machineId: id, enrollment: managedEnrollment });
                                    const current = await tx.machine.findUnique({ where: { accountId_id: { accountId: userId, id } } });
                                    if (!current || current.revokedAt) throw new ManagedMachineError("enrollment_retired");
                                    let winningMachine = current;
                                    if (managedEnrollment) {
                                        const identityUpdate = resolveInstallationIdentityUpdate(current, verifiedInstallationIdentity);
                                        if (!identityUpdate.ok) throw new ManagedMachineError("enrollment_retired");
                                        if (Object.keys(identityUpdate.data).length > 0) winningMachine = await tx.machine.update({ where: { accountId_id: { accountId: userId, id } }, data: identityUpdate.data });
                                        await linkManagedEnrollmentInTx(tx, managedEnrollment, userId, existingSameAccount.id);
                                    }
                                    if (verifiedInstallationIdentity?.replacesMachineId) {
                                        machineReplacement = await applyVerifiedMachineRegistrationReplacement({ tx, accountId: userId,
                                            replacementMachineId: existingSameAccount.id, replacementMachine: winningMachine,
                                            replacesMachineId: verifiedInstallationIdentity.replacesMachineId, reason: automaticReplacementReason });
                                    }
                                    return winningMachine;
                                });
                            } catch (error) {
                                if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                                if (error instanceof MachineRegistrationReplacementError) return reply.code(error.statusCode).send({ error: "invalid-params", reason: error.reason });
                                throw error;
                            }
                        }
                        log({ module: 'machines', machineId: id, userId }, 'Machine created concurrently; returning existing machine');
                        return reply.send({
                            machine: {
                                ...await serializeMachineRowForRequest(rejoinedMachine, request, accountMode),
                            },
                            ...(machineReplacement ? { machineReplacement } : {}),
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

            return reply.send({
                machine: {
                    ...await serializeMachineRowForRequest(newMachine, request, accountMode),
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
        const supportsCurrentStoredContentProtocol =
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol;

        const result = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: {
                    accountId: userId,
                    id,
                },
            });
            if (!machine) return { kind: 'not_found' as const };
            if (
                isPlainMachineDataKeyMarker(machine.dataEncryptionKey)
                && !supportsCurrentStoredContentProtocol
            ) {
                return { kind: 'upgrade_required' as const };
            }

            const revoked = await revokeMachineInTx(tx, {
                accountId: userId,
                machineId: id,
            });
            return revoked.ok
                ? { kind: 'ok' as const, machine: revoked.machine }
                : { kind: 'not_found' as const };
        });

        if (result.kind === 'not_found') {
            return reply.code(404).send({ error: 'machine_not_found' });
        }
        if (result.kind === 'upgrade_required') {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(request, reply);
            return;
        }

        return reply.send({ machine: await serializeMachineRowForRequest(result.machine, request) });
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            // Scoped SDK callers need the same content-free target bootstrap;
            // this never admits them to ordinary Machine detail or execution.
            allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "machines"),
        },
    }, async (request, reply) => {
        const userId = request.userId;

        // Ordinary discovery stays persistent-only. Restricted Runner bootstrap
        // is still owner-only; persistent shared targets use current access.
        const isApiTokenCaller = request.authTokenKind === "api_token";
        const accessible = await inTx(async (tx) => {
            const ids = await listMachineCandidatesInTx(tx, userId);
            const machines = await tx.machine.findMany({
                where: {
                    id: { in: ids },
                    ...(isApiTokenCaller ? {} : persistentMachineWhere),
                },
                orderBy: { lastActiveAt: 'desc' },
            });
            const projections = [];
            for (const machine of machines) {
                const result = await readAccessibleMachineProjectionInTx(tx, {
                    actorAccountId: userId, machineId: machine.id, request,
                });
                if (result) projections.push(result);
            }
            return projections;
        });
        if (isApiTokenCaller) {
            // A Runner is also selectable by the exact Session it was activated
            // for. That correspondence travels as the activation's persisted,
            // activation-signed claim — never as a Home-authored Session id — so
            // the SDK can verify it before sealing. Persistent Machines have none.
            const runnerIds = accessible
                .filter(({ machine, owned }) => owned && machine.kind === "ephemeral_session_runner")
                .map(({ machine }) => machine.id);
            const activations = runnerIds.length === 0 ? [] : await db.ephemeralRunnerActivation.findMany({
                where: { creatorAccountId: userId, machineId: { in: runnerIds } },
                select: { machineId: true, claim: true },
            });
            const claimByMachineId = new Map(
                activations.map((activation) => [activation.machineId, activation.claim]),
            );
            return accessible.map(({ machine, owned, access, callerDataEncryptionKey }) => {
                return serializeExternalActionMachineBootstrapRow({
                    ...machine,
                    activationClaim: claimByMachineId.get(machine.id) ?? null,
                    access,
                    ...(!owned ? {
                        dataEncryptionKey: access.accessState === 'ready' ? callerDataEncryptionKey : null,
                    } : {}),
                });
            });
        }
        if (
            accessible.some(({ access }) => access.resourceMode === 'plain')
            && !readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol
        ) {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            );
            return;
        }

        return accessible.map(({ projection }) => projection);
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

        const result = await inTx(async (tx) => {
            let actorAccountId = userId;
            const guestProof = request.externalActionManagedGuestActivity;
            if (guestProof) {
                const binding = request.externalActionExecutionAuthorizationBinding;
                if (!binding || request.externalActionExecutionAuthorized !== true || guestProof.machineId !== id) return null;
                const current = await readCurrentManagedGuestActivityInTx(tx, binding, id);
                if (!current || current.installationId !== guestProof.installationId) return null;
                // The verified controller owns this guest's Machine custody.
                // Original requester/root/row admission is rechecked above;
                // no requester Account material is borrowed for the RPC codec.
                actorAccountId = binding.custodianAccountId;
            }
            const projection = await readAccessibleMachineProjectionInTx(tx, { actorAccountId, machineId: id, request });
            if (guestProof) {
                const binding = request.externalActionExecutionAuthorizationBinding;
                const current = binding ? await readCurrentManagedGuestActivityInTx(tx, binding, id) : null;
                if (!current || current.installationId !== guestProof.installationId) return null;
            }
            return projection;
        });

        if (!result) {
            return reply.code(404).send({ error: 'Machine not found' });
        }
        if (
            result.access.resourceMode === 'plain'
            && !readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol
        ) {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            );
            return;
        }

        return {
            machine: result.projection,
        };
    });

}
