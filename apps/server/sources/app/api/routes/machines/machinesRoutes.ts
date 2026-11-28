import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { resolveInstallationIdentityUpdate, updateMachineInstallationIdentityInTx } from "@/app/machines/installationIdentityUpdate";
import { Fastify } from "../../types";
import { withManagedWakeAvailabilityInTx } from '@/app/machines/managed/managedWakeAvailability';
import { z } from "zod/mini";
import { readDeploymentAppEnrollmentsForMachinesInTx } from '@/app/deployments/deploymentAppEnrollment';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { createHash, timingSafeEqual } from "node:crypto";
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
} from "@/app/machines/installationProof";
import {
    acquireMachineRegistrationAccountsInTx,
    bindMachineRegistrationCredentialInTx,
    createMachineWithInstallationIdentityInTx,
    MachineStorageModeMismatchError,
    readMachineRegistrationCredentialToBind,
    revokeMachineInTx,
    recheckMachineStoredContentMutationAdmissionInTx,
} from "@/app/machines/machineMutations";
import {
    serializeExternalActionMachineBootstrapRow,
    serializeMachineRow,
    serializeAccessibleMachineRow,
    serializeMachineHostFacts,
    type MachineSerializationRow,
} from "@/app/machines/machineSerialization";
import type { FastifyRequest } from "fastify";
import { isPlainMachineDataKeyMarker, machineStoredContentMatchesAccountMode, machineUpdateMatchesStoredMode } from '@happier-dev/protocol/machines/machineStoredContent';
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { registerMachineReplacementRoutes } from "./registerMachineReplacementRoutes";
import { registerMachineAdmissionRoutes } from "./registerMachineAdmissionRoutes";
import { registerMachineSessionMessageReplyRoutes } from './registerMachineSessionMessageReplyRoutes';
import { registerMachinePoolRoutes } from "./pools/registerMachinePoolRoutes";
import { registerMachinePresetRoutes } from "./managed/registerMachinePresetRoutes";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { MachineEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/enrollmentV1';
import { registerManagedMachineRoutes } from "@/app/machines/managed/managedRoutes";
import { requireMachineEnrollmentInTx, linkMachineEnrollmentInTx } from "@/app/machines/machineEnrollment";
import { ManagedMachineError, projectMachineDevcontainerChildrenInTx } from "@/app/machines/managed/managedRows";
import { MachineContentKeyTransitionInputV1Schema, MachineContentKeyTransitionResultV1Schema, MachinePublishedRowV1Schema } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { transitionMachineContentKeyInTx, readMachineContentKeySnapshotInTx } from "@/app/machines/transitionMachineContentKeyInTx";
import { readCurrentManagedGuestActivityInTx } from '@/app/auth/externalActionExecutionAuthorization';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { registerMachineAccessRoutes } from './machineAccessRoutes';
import { MACHINE_PRESENCE_EVENTS_PROJECTION_V1 } from '@happier-dev/protocol/machines/machinePresenceTransitionsV1';
import { parseStoredMachinePresenceTransitions } from '@/app/presence/machinePresenceTransitions';
import {
    listMachineCandidatesInTx,
    listScopedTeamMachineCandidatesInTx,
    readAccessibleMachineOpeningsInTx,
} from '@/app/machines/machineAccess';

// Accept is presentation demand only. An admitted Archive reads host facts even
// when its installed signer omits that unsigned header.
function readMachineProjection(request: FastifyRequest): 'hostFacts' | undefined {
    const binding = request.externalActionExecutionAuthorizationBinding;
    if (request.externalActionExecutionAuthorized === true
        && binding?.actionId === MACHINE_PRESET_ARCHIVE_ACTION_ID_V1
        && binding.presetPreparationAdmission) return 'hostFacts';
    return request.headers.accept === 'application/json;happier-machine-projection=host-facts' ? 'hostFacts' : undefined;
}

async function readAccessibleMachineProjectionsInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; machineIds: readonly string[]; request: FastifyRequest; projection?: 'hostFacts';
        discovery?: Readonly<{ includeRevoked: boolean; persistentOnly: boolean }>;
        admission?: SocketRpcMachineAdmissionContextV1 }>,
) {
    // Recipient-work facts only schedule the present user's UI key repair; automation, API-token
    // and terminal reads never consume them, so they do not pay for the recipient query.
    const schedulesRecipientRepair = input.projection !== 'hostFacts'
        && input.request.authAuthority === 'present_user' && input.request.authTokenKind === 'account';
    const includePresenceHistory = input.request.headers.accept === MACHINE_PRESENCE_EVENTS_PROJECTION_V1;
    const openings = await readAccessibleMachineOpeningsInTx(tx, { actorAccountId: input.actorAccountId, machineIds: input.machineIds,
        discovery: input.discovery,
        ...(input.admission ? { admission: input.admission } : {}),
        ...(schedulesRecipientRepair ? { includeRecipientWork: true as const } : {}) });
    const openingRows = [...openings.values()].map(opening => opening.machine);
    const children = input.projection === 'hostFacts' ? null : await projectMachineDevcontainerChildrenInTx(tx, openingRows);
    const apps = input.projection === 'hostFacts' ? null : await readDeploymentAppEnrollmentsForMachinesInTx(tx, {
        machines: openingRows,
        reader: { accountId: input.request.userId, authentication: readTeamOperationAuthenticationFromRequest(input.request) },
    });
    return input.machineIds.flatMap(machineId => {
        const opening = openings.get(machineId);
        if (!opening) return [];
        const { machine } = opening;
        return [{ ...opening, projection: input.projection === 'hostFacts' ? serializeMachineHostFacts(machine, opening.access)
            : {
                ...serializeAccessibleMachineRow(machine, {
                    ...opening,
                    devcontainerChild: children?.get(machine.id) ?? null,
                    deploymentApp: apps?.get(machine.id) ?? null,
                    recipientAccountStoredContentProtocolVersion:
                        readAccountStoredContentCompatibilityForHttpRequest(input.request).declaration?.protocolVersion,
                }),
                ...(includePresenceHistory ? { presenceTransitions: parseStoredMachinePresenceTransitions(machine.presenceTransitions) } : {}),
            } }];
    });
}

/** Exact Machine reads share one admission path, whether transported singly or in a batch. */
async function readRequestedMachineProjectionsInTx(
    tx: Tx,
    request: FastifyRequest,
    machineIds: readonly string[],
    projection?: 'hostFacts',
) {
    let actorAccountId = request.userId;
    let admittedIds = machineIds;
    const guestProof = request.externalActionManagedGuestActivity;
    const deploymentProof = request.externalActionDeploymentChildMachineRead;
    if (deploymentProof) {
        if (guestProof || request.externalActionExecutionAuthorized !== true) return [];
        admittedIds = machineIds.filter(id => id === deploymentProof.machineId);
        if (!admittedIds.length) return [];
        actorAccountId = deploymentProof.actorAccountId;
    }
    if (guestProof) {
        const binding = request.externalActionExecutionAuthorizationBinding;
        if (!binding || request.externalActionExecutionAuthorized !== true) return [];
        admittedIds = machineIds.filter(id => id === guestProof.machineId);
        if (!admittedIds.length) return [];
        const current = await readCurrentManagedGuestActivityInTx(tx, binding, guestProof.machineId);
        if (!current || current.installationId !== guestProof.installationId) return [];
        // Only this verified controller's exact guest can borrow its custody.
        actorAccountId = binding.custodianAccountId;
    }
    const projections = await readAccessibleMachineProjectionsInTx(tx, { actorAccountId, machineIds: admittedIds, request, projection,
        ...(deploymentProof ? { admission: deploymentProof.codecAdmission } : {}) });
    return projections;
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

async function serializeMachineRowForRequestInTx(
    tx: Tx,
    row: Omit<MachineSerializationRow, 'managedResource'>,
    request: FastifyRequest,
    storageMode?: "plain" | "e2ee",
) {
    const machine = await tx.machine.findUniqueOrThrow({ where: { id: row.id }, select: {
        id: true, accountId: true, managedResource: true, deploymentAppDeploymentId: true, revokedAt: true, replacedByMachineId: true,
    } });
    const [projectedMachine] = await withManagedWakeAvailabilityInTx(tx, [machine]);
    const apps = await readDeploymentAppEnrollmentsForMachinesInTx(tx, { machines: [machine],
        reader: { accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request) },
    });
    return serializeMachineRow({ ...row, ...projectedMachine }, {
        devcontainerChild: (await projectMachineDevcontainerChildrenInTx(tx, [machine])).get(row.id) ?? null,
        deploymentApp: apps.get(row.id) ?? null,
        ...(storageMode ? { storageMode } : {}),
        recipientAccountStoredContentProtocolVersion:
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .declaration?.protocolVersion,
    });
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
    registerMachineSessionMessageReplyRoutes(app);
    registerMachineAccessRoutes(app);
    registerMachineReplacementRoutes(app);
    registerMachinePoolRoutes(app, { io: app.machineDaemonPresence });
    registerMachinePresetRoutes(app);
    registerManagedMachineRoutes(app);

    app.get('/v1/machines/:id/content-key/transition', {
        preHandler: app.authenticate,
        schema: {
            params: z.strictObject({ id: z.string().check(z.minLength(1)) }),
            response: { 200: z.strictObject({ machine: MachinePublishedRowV1Schema }),
                404: z.strictObject({ error: z.literal("machine_unavailable") }) },
        },
    }, async (request, reply) => {
        const machine = await inReadSnapshot(tx => readMachineContentKeySnapshotInTx({
            tx, accountId: request.userId, machineId: request.params.id,
        }));
        return machine ? reply.send({ machine }) : reply.code(404).send({ error: "machine_unavailable" });
    });

    app.post('/v1/machines/:id/content-key/transition', {
        preHandler: app.authenticate,
        schema: {
            params: z.strictObject({ id: z.string().check(z.minLength(1)) }),
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
                daemonState: z.optional(z.string()), // Encrypted daemon state
                dataEncryptionKey: z.nullish(z.string()),
                /**
                 * When an E2EE `dataEncryptionKey` is provided, the client must also provide its account content public key.
                 * This allows the server to reject token/key mismatches that would otherwise create "poisoned" machine rows.
                 */
                contentPublicKey: z.optional(z.string()),
                // Optional signature binding `contentPublicKey` to the account's signing key (recommended).
                // When the account has not yet stored its `contentPublicKey`, providing this signature allows the
                // server to persist the key safely without requiring a full /v1/auth key-proof flow.
                contentPublicKeySig: z.optional(z.string()),
                installationId: z.optional(z.string()),
                installationPublicKey: z.optional(z.string()),
                installationProof: z.optional(z.unknown()),
                replacesMachineId: z.optional(z.string()),
                replacementReason: z.optional(z.string()),
                contentPublicKeyFingerprint: z.optional(z.string()),
                managedEnrollment: z.optional(MachineEnrollmentCorrelationV1Schema),
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
        }).then(decodeMachineStoredContent);
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
                    const admission = await inTx(tx => admitAccountContentKey(tx, {
                        accountId: userId,
                        contentPublicKey: decoded,
                        contentPublicKeySignature: decodedSignature,
                    }));
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
        const terminalCredential = request.authTerminalCredential;
        const registrationCredential = {
            managedEnrollment,
            terminalAuthRequestId: terminalCredential?.pendingDeploymentAppEnrollment && !managedEnrollment
                ? undefined : terminalCredential?.terminalAuthRequestId,
        };
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
            const wantsCredentialBinding = Boolean(readMachineRegistrationCredentialToBind(machine, registrationCredential));

            if (
                !wantsInstallationUpdate
                && !wantsAutomaticReplacement
                && !wantsCredentialBinding
                && !managedEnrollment
            ) {
                try {
                    const registered = await inTx(async tx => {
                        await requireMachineEnrollmentInTx(tx, { accountId: userId, machineId: id });
                        // Registration content is create-only: adopt the winning content basis.
                        return serializeMachineRowForRequestInTx(tx, machine, request, accountMode);
                    }, { readOnly: true });
                    log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
                    return reply.send({ machine: registered });
                } catch (error) {
                    if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                    throw error;
                }
            }

            log({ module: 'machines', machineId: id, userId }, 'Updating existing machine');

            type UpdatedMachineResponse =
                | Awaited<ReturnType<typeof serializeMachineRowForRequestInTx>>
                | null
                | { error: 'machine_revoked' }
                | { error: 'invalid_installation_identity'; reason: string }
                | { error: 'machine_storage_mode_mismatch' };
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            let updated: UpdatedMachineResponse;
            try {
                updated = await inTx(async (tx) => {
                    const declarationBodies = await acquireMachineRegistrationAccountsInTx(tx, {
                        accountId: userId, machineId: id, managedEnrollment, installationIdentity: verifiedInstallationIdentity,
                    });
                    await requireMachineEnrollmentInTx(tx, { accountId: userId, machineId: id, enrollment: managedEnrollment, declarationBodies });
                    const current = await tx.machine.findFirst({
                        where: {
                            accountId: userId,
                            id,
                        },
                    }).then(decodeMachineStoredContent);
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

                    // Registration metadata/state/envelope are create-only. Existing metadata also contains
                    // user-owned fields such as displayName, and the server cannot merge its
                    // encrypted value. Daemons refresh their owned fields through the versioned
                    // machine-update-metadata socket after registration.
                    const updatedMachine = currentWantsInstallationUpdate
                        ? await updateMachineInstallationIdentityInTx(tx, current, currentInstallationIdentityUpdate.data)
                        : current;

                    if (
                        currentWantsInstallationUpdate
                    ) {
                        await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: updatedMachine.id });
                    }

                    if (!managedEnrollment) await bindMachineRegistrationCredentialInTx(tx, updatedMachine, registrationCredential);
                    if (verifiedInstallationIdentity?.replacesMachineId) {
                        machineReplacement = await applyVerifiedMachineRegistrationReplacement({
                            tx,
                            accountId: userId,
                            replacementMachineId: updatedMachine.id,
                            replacementMachine: updatedMachine,
                            replacesMachineId: verifiedInstallationIdentity.replacesMachineId,
                            reason: automaticReplacementReason,
                            terminalAuthRequestId: readMachineRegistrationCredentialToBind(updatedMachine, registrationCredential),
                        });
                    }

                    if (managedEnrollment) await linkMachineEnrollmentInTx(tx, managedEnrollment, userId, updatedMachine.id, declarationBodies, registrationCredential.terminalAuthRequestId);
                    return serializeMachineRowForRequestInTx(tx, updatedMachine, request, accountMode);
                }, {
                    // Exclusive Account admission protects installation and managed lifecycle predicates.
                    isolationLevel: "ReadCommitted",
                });
            } catch (error) {
                if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                if (error instanceof MachineRegistrationReplacementError) {
                    return reply.code(error.statusCode).send({ error: "invalid-params", reason: error.reason });
                }
                if ((managedEnrollment || wantsCredentialBinding) && (isPrismaErrorCode(error, 'P2028') || isPrismaErrorCode(error, 'P1008'))) {
                    throw error;
                }

                // Control-plane guardrail: when SQLite is under heavy contention, starting an interactive transaction
                // can fail (P2028/P1008) which would brick daemon startup/session spawning. Degrade only for
                // best-effort installation refreshes. Content/key replacement is never a registration write.
                if (isPrismaErrorCode(error, 'P2028') || isPrismaErrorCode(error, 'P1008')) {
                    let registered;
                    try {
                        registered = await inTx(async tx => {
                            await requireMachineEnrollmentInTx(tx, { accountId: userId, machineId: id });
                            return serializeMachineRowForRequestInTx(tx, machine, request, accountMode);
                        }, { readOnly: true });
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
                    return reply.send({ machine: registered });
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
                machine: updated,
                ...(machineReplacement ? { machineReplacement } : {}),
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            let newMachine;
            let machineReplacement: MachineRegistrationReplacementResult | null = null;
            try {
                const created = await inTx(async (tx) => {
                    const declarationBodies = await acquireMachineRegistrationAccountsInTx(tx, {
                        accountId: userId, machineId: id, managedEnrollment, installationIdentity: verifiedInstallationIdentity,
                    });
                    await requireMachineEnrollmentInTx(tx, { accountId: userId, machineId: id, enrollment: managedEnrollment, declarationBodies });
                    const registered = await createMachineWithInstallationIdentityInTx(tx, {
                    accountId: userId,
                    machineId: id,
                    metadata,
                    daemonState,
                    dataEncryptionKey,
                    installationIdentity: verifiedInstallationIdentity,
                    contentPublicKeyFingerprint: resolvedContentPublicKeyFingerprint,
                    replacementReason: automaticReplacementReason,
                    declarationBodies,
                    ...registrationCredential,
                    });
                    return { ...registered, machine: await serializeMachineRowForRequestInTx(tx, registered.machine, request, accountMode) };
                }, {
                    // Registration's Account fence protects replacement and enrollment without stale snapshots.
                    isolationLevel: "ReadCommitted",
                });
                newMachine = created.machine;
                machineReplacement = created.machineReplacement;
            } catch (e) {
                if (e instanceof MachineStorageModeMismatchError) {
                    return reply.code(400).send({ error: "invalid-params", reason: e.code });
                }
                if (e instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: e.code });
                if (e instanceof MachineRegistrationReplacementError) {
                    return reply.code(e.statusCode).send({ error: "invalid-params", reason: e.reason });
                }
                // Concurrency safety: multiple clients may race to create the same machine (e.g. daemon + session spawns).
                // If we lost the race, fetch the winner row and return it instead of surfacing a 500.
                if (isPrismaErrorCode(e, 'P2002')) {
                    const existingSameAccount = await db.machine.findFirst({ where: { accountId: userId, id } }).then(decodeMachineStoredContent);
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
                        let rejoinedMachine;
                        {
                            try {
                                rejoinedMachine = await inTx(async tx => {
                                    const declarationBodies = await acquireMachineRegistrationAccountsInTx(tx, {
                                        accountId: userId, machineId: id, managedEnrollment, installationIdentity: verifiedInstallationIdentity,
                                    });
                                    await requireMachineEnrollmentInTx(tx, { accountId: userId, machineId: id, enrollment: managedEnrollment, declarationBodies });
                                    const current = await tx.machine.findUnique({ where: { accountId_id: { accountId: userId, id } } }).then(decodeMachineStoredContent);
                                    if (!current || current.revokedAt) throw new ManagedMachineError("enrollment_retired");
                                    let winningMachine = current;
                                    const identityUpdate = resolveInstallationIdentityUpdate(current, verifiedInstallationIdentity);
                                    if (!identityUpdate.ok) throw new MachineRegistrationReplacementError(400, identityUpdate.reason);
                                    if (Object.keys(identityUpdate.data).length > 0) {
                                        winningMachine = await updateMachineInstallationIdentityInTx(tx, current, identityUpdate.data);
                                        await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: current.id });
                                    }
                                    if (managedEnrollment) await linkMachineEnrollmentInTx(tx, managedEnrollment, userId, existingSameAccount.id, declarationBodies, registrationCredential.terminalAuthRequestId);
                                    else await bindMachineRegistrationCredentialInTx(tx, winningMachine, registrationCredential);
                                    if (verifiedInstallationIdentity?.replacesMachineId) {
                                        machineReplacement = await applyVerifiedMachineRegistrationReplacement({ tx, accountId: userId,
                                            replacementMachineId: existingSameAccount.id, replacementMachine: winningMachine,
                                            replacesMachineId: verifiedInstallationIdentity.replacesMachineId, reason: automaticReplacementReason,
                                            terminalAuthRequestId: readMachineRegistrationCredentialToBind(winningMachine, registrationCredential) });
                                    }
                                    return serializeMachineRowForRequestInTx(tx, winningMachine, request, accountMode);
                                }, {
                                    // Rejoin uses the same exclusive registration admission as create/update.
                                    isolationLevel: "ReadCommitted",
                                });
                            } catch (error) {
                                if (error instanceof ManagedMachineError) return reply.code(409).send({ error: "invalid-params", reason: error.code });
                                if (error instanceof MachineRegistrationReplacementError) return reply.code(error.statusCode).send({ error: "invalid-params", reason: error.reason });
                                throw error;
                            }
                        }
                        log({ module: 'machines', machineId: id, userId }, 'Machine created concurrently; returning existing machine');
                        return reply.send({
                            machine: rejoinedMachine,
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
                machine: newMachine,
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
            }).then(decodeMachineStoredContent);
            if (!machine) return { kind: 'not_found' as const };
            if (
                isPlainMachineDataKeyMarker(machine.dataEncryptionKey)
                && !supportsCurrentStoredContentProtocol
            ) {
                return { kind: 'upgrade_required' as const };
            }

            recheckMachineStoredContentMutationAdmissionInTx(tx, {
                accountId: userId, machineId: id, supportsCurrentStoredContentProtocol,
            });
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

        return reply.send({ machine: await inTx(tx => serializeMachineRowForRequestInTx(tx, result.machine, request)) });
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({ includeRevoked: z.optional(z.enum(['true', 'false'])),
                sharedWithTeamId: z.optional(z.string().check(z.minLength(1))) }),
        },
        config: {
            allowApiToken: true,
            // Scoped SDK callers need the same content-free target bootstrap;
            // this never admits them to ordinary Machine detail or execution.
            allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "machines"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        // Retained Session replacement identity needs predecessor rows; ordinary
        // discovery must not return them merely because the caller owns them.
        const includeRevokedOwned = request.query.includeRevoked === 'true';

        // Ordinary discovery stays persistent-only. Restricted Runner bootstrap
        // is still owner-only; persistent shared targets use current access.
        const isApiTokenCaller = request.authTokenKind === "api_token";
        const projection = readMachineProjection(request);
        let sharedWithTeamScopes: Awaited<ReturnType<typeof listScopedTeamMachineCandidatesInTx>> | undefined;
        const accessible = await inReadSnapshot(async (tx) => {
            sharedWithTeamScopes = request.query.sharedWithTeamId
                ? await listScopedTeamMachineCandidatesInTx(tx, userId, request.query.sharedWithTeamId) : undefined;
            const ids = sharedWithTeamScopes ? [...sharedWithTeamScopes.keys()]
                : await listMachineCandidatesInTx(tx, userId, { includeRevokedOwned });
            const machines = await readAccessibleMachineProjectionsInTx(tx, { actorAccountId: userId, machineIds: ids, request, projection,
                discovery: { includeRevoked: includeRevokedOwned, persistentOnly: !isApiTokenCaller } });
            return machines.sort((left, right) => right.machine.lastActiveAt.getTime() - left.machine.lastActiveAt.getTime());
        });
        if (isApiTokenCaller && projection !== 'hostFacts') {
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
                return { ...serializeExternalActionMachineBootstrapRow({
                    ...machine,
                    activationClaim: claimByMachineId.get(machine.id) ?? null,
                    access,
                    ...(!owned ? {
                        dataEncryptionKey: access.accessState === 'ready' ? callerDataEncryptionKey : null,
                    } : {}),
                }), ...(sharedWithTeamScopes?.has(machine.id) ? { sharedWithTeamScope: sharedWithTeamScopes.get(machine.id) } : {}) };
            });
        }
        if (
            !isApiTokenCaller && accessible.some(({ access }) => access.resourceMode === 'plain')
            && !readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol
        ) {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            );
            return;
        }

        const rows = accessible.map(({ machine, projection }) => ({ ...projection,
            ...(sharedWithTeamScopes?.has(machine.id) ? { sharedWithTeamScope: sharedWithTeamScopes.get(machine.id) } : {}),
        }));
        // The present-user census also drives retries of pending key repair.
        // Deliver the rows to that owner while repair still needs attention.
        const hasPendingKeyRepair = rows.some(row => 'recipientWorkPending' in row && row.recipientWorkPending === true);
        if (!isApiTokenCaller && projection !== 'hostFacts' && !hasPendingKeyRepair
            && request.headers.accept === MACHINE_PRESENCE_EVENTS_PROJECTION_V1) {
            const hash = createHash('sha256').update(JSON.stringify([userId, includeRevokedOwned, request.query.sharedWithTeamId]));
            // The ordinary heartbeat only moves activeAt and census order. Keep
            // presence transitions and the admitted access projection in the validator.
            for (const { activeAt: _heartbeat, ...row } of rows.toSorted((a, b) => a.id.localeCompare(b.id))) {
                hash.update(JSON.stringify(row));
            }
            const etag = `W/"machine-census-v1-${hash.digest('hex')}"`;
            reply.header('ETag', etag).header('Cache-Control', 'private, no-store');
            if (request.headers['if-none-match']?.split(',').some(value => value.trim() === etag)) {
                return reply.code(304).send();
            }
        }
        return rows;
    });

    app.post('/v1/machines/read-batch', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "machines") },
        schema: { body: MachineReadBatchRequestV1Schema },
    }, async (request, reply) => {
        const ids = [...new Set(request.body.machineIds)];
        const accessible = await inReadSnapshot(tx => readRequestedMachineProjectionsInTx(tx, request, ids));
        if (accessible.some(result => result.access.resourceMode === 'plain')
            && !readAccountStoredContentCompatibilityForHttpRequest(request).supportsCurrentProtocol) {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(request, reply);
            return;
        }
        const byId = new Map(accessible.map(result => [result.machine.id, result.projection]));
        return MachineReadBatchResponseV1Schema.parse({ results: ids.map(machineId => {
            const machine = byId.get(machineId);
            return machine ? { machineId, status: 'found', machine } : { machineId, status: 'not_found' };
        }) });
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
        const { id } = request.params;
        const projection = readMachineProjection(request);
        const result = await inReadSnapshot(async tx => (await readRequestedMachineProjectionsInTx(tx, request, [id], projection))[0] ?? null);

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
