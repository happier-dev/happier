import { randomUUID } from "node:crypto";
import type { Prisma, TeamDirectorySource } from "@prisma/client";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { parseTeamIdentityConnectionDocuments } from "@/app/auth/providers/managed/identityProviderDocuments";
import { resolveStoredGitHubDirectoryReadiness } from "@/app/integrations/github/githubManagedDirectory";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";
import {
    deriveGithubDirectoryExternalSourceKey,
    deriveWorkosDirectoryExternalSourceKey,
    parseTeamDirectoryBindingConfigV1,
    type TeamDirectoryBindingConfigV1,
} from "./directorySourceBinding";
import {
    deriveDirectoryFailureSchedule,
    DIRECTORY_FULL_RECONCILE_TARGET_MS,
    GITHUB_DIRECTORY_SYNC_TARGET_MS,
    isDirectoryErrorRetryable,
    retryableDirectoryErrorWhere,
    WORKOS_DIRECTORY_SYNC_TARGET_MS,
} from "./directorySourceProjection";
import { acquireExternalSourceAccountAdmissionInTx, revokeExternalSourceFactsInTx } from "../memberships/externalFacts";
import { isDirectorySourceAllowedInTx, isDirectorySourceKindAllowedInTx } from "./directorySourcePolicy";
import type { ExpectedDirectorySourceCurrentness } from "./directorySourcePolicy";
import { publishTeamChangedInTx } from "../teamChanges";
import { acquireTeamMutationLockInTx } from "../actorContext";

export type CreateDirectorySourceInput =
    | Readonly<{
        kind: "workos_directory";
        teamId: string;
        teamIdentityConnectionId: string;
        workosDirectoryId: string;
        displayName: string;
        now?: Date;
    }>
    | Readonly<{
        kind: "github_organization";
        teamId: string;
        githubAppInstallationId: string;
        displayName: string;
    }>;

export type CreateDirectorySourceResult =
    | Readonly<{ ok: true; sourceId: string }>
    | Readonly<{
        ok: false;
        code:
            | "directory_source_owner_not_found"
            | "directory_source_identity_mismatch"
            | "directory_source_already_exists";
    }>;

export type ClaimedDirectorySource = Readonly<{
    id: string;
    teamId: string;
    kind: TeamDirectoryBindingConfigV1["kind"];
    binding: TeamDirectoryBindingConfigV1;
    reconcileRunId: string;
    eventCursor: string | null;
    eventRangeStart: Date | null;
    observedManualSyncRequestedAt: Date | null;
    consecutiveFailureCount?: number;
}>;

export type ActiveWorkosDirectorySource = Readonly<{
    id: string;
    teamId: string;
    kind: "workos_directory";
    binding: Extract<TeamDirectoryBindingConfigV1, { kind: "workos_directory" }>;
    reconcileRunId: null;
    eventCursor: string | null;
    eventRangeStart: Date | null;
    observedManualSyncRequestedAt: null;
    consecutiveFailureCount?: number;
}>;

export type DirectorySourceLifecycleWriteResult =
    | Readonly<{ applied: true }>
    | Readonly<{ applied: false; reason: "stale_run" }>;

type DirectorySourceDeletionCurrentness = Readonly<{
    state: "active" | "initializing";
    activeReconcileRunId: string | null;
    manualSyncRequestedAt?: null;
}> & (Readonly<{ eventCursor: string }> | Readonly<{ eventCursor: null; eventRangeStart: Date }>);

export async function removeDirectorySourceInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; sourceId: string }>,
    currentness?: DirectorySourceDeletionCurrentness,
): Promise<Readonly<{ membershipsRemoved: number; contributionsRemoved: number }>> {
    await acquireExternalSourceAccountAdmissionInTx(tx, { owner: { kind: "directory_source", directorySourceId: input.sourceId } });
    const revoked = await revokeExternalSourceFactsInTx(tx, {
        teamId: input.teamId,
        owner: { kind: "directory_source", directorySourceId: input.sourceId },
    });
    try {
        await tx.teamDirectorySource.delete({ where: { ...currentness, id: input.sourceId } });
    } catch (error) {
        // Roll back native withdrawals before replaying a worker observation
        // invalidated by a human pause or newly requested reconciliation.
        if (currentness && isPrismaErrorCode(error, "P2025")) {
            throw new TransactionReplayRequiredError("directory-source-currentness-changed");
        }
        throw error;
    }
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return revoked;
}

export async function removeDirectorySourceForObservedDeletion(input: Readonly<{
    teamId: string;
    sourceId: string;
    expectedState: "active" | "initializing";
    reconcileRunId: string | null;
    expectedPosition:
        | Readonly<{ eventCursor: string }>
        | Readonly<{ eventCursor: null; eventRangeStart: Date }>;
    expectedCurrentness?: ExpectedDirectorySourceCurrentness;
    env?: NodeJS.ProcessEnv;
}>): Promise<DirectorySourceLifecycleWriteResult> {
    return await inTx(async (tx) => {
        const admission = await acquireExternalSourceAccountAdmissionInTx(tx, {
            owner: { kind: "directory_source", directorySourceId: input.sourceId },
        });
        if (!admission) return { applied: false, reason: "stale_run" };
        await acquireTeamMutationLockInTx(tx, admission.teamId);
        await admission.recheck();
        if (!await isDirectorySourceAllowedInTx(tx, {
            id: input.sourceId, kind: "workos_directory",
        }, input.expectedCurrentness, input.env)) {
            return { applied: false, reason: "stale_run" };
        }
        const position = input.expectedPosition.eventCursor === null
            ? { eventCursor: null, eventRangeStart: input.expectedPosition.eventRangeStart }
            : { eventCursor: input.expectedPosition.eventCursor };
        const sourceWhere = {
            id: input.sourceId,
            teamId: input.teamId,
            kind: "workos_directory" as const,
            state: input.expectedState,
            activeReconcileRunId: input.reconcileRunId,
            ...(input.expectedState === "active" ? { manualSyncRequestedAt: null } : {}),
            ...position,
        };
        const current = await tx.teamDirectorySource.findFirst({
            where: sourceWhere,
            select: { id: true },
        });
        if (!current) return { applied: false, reason: "stale_run" };
        await removeDirectorySourceInTx(tx, input, sourceWhere);
        return { applied: true };
    }, { isolationLevel: "ReadCommitted" /* The outer Team guard owns contribution effects; the final observed-source delete CAS rejects stale worker evidence. */ });
}

export async function createDirectorySource(
    input: CreateDirectorySourceInput,
): Promise<CreateDirectorySourceResult> {
    return await inTx((tx) => createDirectorySourceInTx(tx, input), { isolationLevel: "ReadCommitted" /* Unique source identity and owner FKs cover this constructor without a native-fact census. */ });
}

export async function createDirectorySourceInTx(
    tx: Tx,
    input: CreateDirectorySourceInput,
): Promise<CreateDirectorySourceResult> {
    const now = input.kind === "workos_directory" ? input.now ?? new Date() : new Date();
    const activeReconcileRunId = randomUUID();
    if (!await isDirectorySourceKindAllowedInTx(tx, input.kind)) {
        return { ok: false, code: "directory_source_owner_not_found" };
    }

    let owner:
        | Readonly<{
            externalSourceKey: string;
            bindingConfig: TeamDirectoryBindingConfigV1;
            teamIdentityConnectionId: string | null;
            githubAppInstallationId: string | null;
        }>
        | null = null;

    if (input.kind === "workos_directory") {
        // Directory sync consumes the connection as the same-Team WorkOS
        // organization carrier. A disabled connection only stops SSO sign-in,
        // matching the directory arm of the connection runtime owner; the
        // provider instance itself must still be enabled.
        const connection = await tx.teamIdentityConnection.findFirst({
            where: {
                id: input.teamIdentityConnectionId,
                teamId: input.teamId,
                providerInstance: { kind: "workos_sso", enabled: true },
            },
            include: { providerInstance: true },
        });
        if (!connection) return { ok: false, code: "directory_source_owner_not_found" };
        const documents = parseTeamIdentityConnectionDocuments({
            providerKind: connection.providerInstance.kind,
            externalReference: connection.externalReference,
            settings: connection.settings,
            lastObservation: connection.lastObservation,
            lastSuccessfulTestAt: connection.lastSuccessfulTestAt,
        });
        if (
            !documents.ok
            || documents.value.externalReference.kind !== "workos_sso"
            || documents.value.externalReference.organizationId === null
        ) {
            return { ok: false, code: "directory_source_identity_mismatch" };
        }
        owner = {
            externalSourceKey: deriveWorkosDirectoryExternalSourceKey({
                organizationId: documents.value.externalReference.organizationId,
                directoryId: input.workosDirectoryId,
            }),
            bindingConfig: {
                v: 1,
                kind: "workos_directory",
                workosDirectoryId: input.workosDirectoryId,
            },
            teamIdentityConnectionId: connection.id,
            githubAppInstallationId: null,
        };
    } else {
        const installation = await tx.gitHubAppInstallation.findUnique({
            where: { id: input.githubAppInstallationId },
            include: { registration: true },
        });
        if (!installation) return { ok: false, code: "directory_source_owner_not_found" };
        const readiness = resolveStoredGitHubDirectoryReadiness({
            teamId: input.teamId,
            home: await readHomeGovernancePolicyInTx(tx),
            installation: {
                ...installation,
                registration: {
                    ...installation.registration,
                    encryptedSecrets: Uint8Array.from(installation.registration.encryptedSecrets),
                },
            },
        });
        if (!readiness.ok) {
            return { ok: false, code: "directory_source_identity_mismatch" };
        }
        owner = {
            externalSourceKey: deriveGithubDirectoryExternalSourceKey({
                registrationId: installation.registrationId,
                installationId: installation.githubInstallationId,
                organizationId: installation.githubOrganizationId,
            }),
            bindingConfig: {
                v: 1,
                kind: "github_organization",
                githubOrganizationLogin: installation.githubOrganizationLogin,
            },
            teamIdentityConnectionId: null,
            githubAppInstallationId: installation.id,
        };
    }

    try {
        const source = await tx.teamDirectorySource.create({
            data: {
                teamId: input.teamId,
                kind: input.kind,
                state: "initializing",
                displayName: input.displayName,
                externalSourceKey: owner.externalSourceKey,
                bindingConfig: owner.bindingConfig,
                teamIdentityConnectionId: owner.teamIdentityConnectionId,
                githubAppInstallationId: owner.githubAppInstallationId,
                eventRangeStart: input.kind === "workos_directory" ? now : null,
                activeReconcileRunId,
                activeReconcileStartedAt: now,
                lastAttemptAt: now,
            },
            select: { id: true },
        });
        return { ok: true, sourceId: source.id };
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            return { ok: false, code: "directory_source_already_exists" };
        }
        throw error;
    }
}

const DIRECTORY_SOURCE_KINDS = ["workos_directory", "github_organization"] as const;

function directorySourceDueWhere(
    now: Date,
    kinds: readonly TeamDirectoryBindingConfigV1["kind"][],
): Prisma.TeamDirectorySourceWhereInput {
    const fullReconcileDueBefore = new Date(now.getTime() - DIRECTORY_FULL_RECONCILE_TARGET_MS);
    const workosIncrementalDueBefore = new Date(now.getTime() - WORKOS_DIRECTORY_SYNC_TARGET_MS);
    const githubFullDueBefore = new Date(now.getTime() - GITHUB_DIRECTORY_SYNC_TARGET_MS);
    return {
        AND: [
            { kind: { in: [...kinds] } },
            { OR: [{ retryNotBefore: null }, { retryNotBefore: { lte: now } }] },
            { OR: [
                { state: "initializing" },
                {
                    state: "active",
                    activeReconcileRunId: { not: null },
                },
                {
                    state: { in: ["active", "needs_attention"] },
                    manualSyncRequestedAt: { not: null },
                    // An explicit Retry of a source parked on a
                    // non-retryable failure buys exactly one attempt:
                    // it is due only while no claim has consumed it.
                    OR: [
                        retryableDirectoryErrorWhere(),
                        { lastAttemptAt: null },
                        { manualSyncRequestedAt: { gt: db.teamDirectorySource.fields.lastAttemptAt } },
                    ],
                },
                {
                    state: "needs_attention",
                    ...retryableDirectoryErrorWhere(),
                },
                {
                    state: "active",
                    kind: "workos_directory",
                    AND: [retryableDirectoryErrorWhere()],
                    OR: [
                        { lastFullReconcileAt: null },
                        { lastFullReconcileAt: { lte: fullReconcileDueBefore } },
                        { lastSuccessAt: null },
                        { lastSuccessAt: { lte: workosIncrementalDueBefore } },
                    ],
                },
                {
                    state: "active",
                    kind: "github_organization",
                    AND: [retryableDirectoryErrorWhere()],
                    OR: [
                        { lastSuccessAt: null },
                        { lastSuccessAt: { lte: githubFullDueBefore } },
                    ],
                },
            ] },
        ],
    };
}

/** A scheduling hint only; the locked selector and claim still decide admission. */
export async function hasDirectorySourceDueForSync(params: Readonly<{ now?: Date }> = {}): Promise<boolean> {
    return await db.teamDirectorySource.findFirst({
        where: directorySourceDueWhere(params.now ?? new Date(), DIRECTORY_SOURCE_KINDS),
        select: { id: true },
    }) !== null;
}

/**
 * Select the oldest runnable source. The durable manual request is only one
 * way a source becomes due; it does not create a separate in-memory queue or
 * a priority class that can starve scheduled repair work.
 */
export async function findNextDirectorySourceDueForSync(params: Readonly<{
    now?: Date;
}> = {}): Promise<Readonly<{ id: string; mode: "full" | "incremental" }> | null> {
    const now = params.now ?? new Date();
    const fullReconcileDueBefore = new Date(now.getTime() - DIRECTORY_FULL_RECONCILE_TARGET_MS);
    const candidate = await inTx(async (tx) => {
        const allowedKinds = DIRECTORY_SOURCE_KINDS;
        const runnableKinds: typeof allowedKinds[number][] = [];
        for (const kind of allowedKinds) {
            if (await isDirectorySourceKindAllowedInTx(tx, kind)) runnableKinds.push(kind);
        }
        if (runnableKinds.length === 0) return null;
        return await tx.teamDirectorySource.findFirst({
            where: directorySourceDueWhere(now, runnableKinds),
            orderBy: [{ lastAttemptAt: "asc" }, { id: "asc" }],
            select: {
                id: true,
                kind: true,
                state: true,
                manualSyncRequestedAt: true,
                lastFullReconcileAt: true,
                activeReconcileRunId: true,
            },
        });
    });
    if (!candidate) return null;
    // An outstanding attempt token on an active source is an abandoned
    // paginated observation. The incremental claim refuses such a source, so
    // routing it to incremental mode would make the same source come back due
    // forever and stall every later source; the full claim is the owner that
    // replaces the token under CAS and repairs the incomplete evidence
    // (child 05 §11.2) instead of leaving staged rows permanently fenced.
    const full = candidate.state !== "active"
        || candidate.kind === "github_organization"
        || candidate.manualSyncRequestedAt !== null
        || candidate.activeReconcileRunId !== null
        || candidate.lastFullReconcileAt === null
        || candidate.lastFullReconcileAt <= fullReconcileDueBefore;
    return { id: candidate.id, mode: full ? "full" : "incremental" };
}

/** Preserve the request, position and retry decision captured by either claim. */
function directorySourceClaimWhere(current: Pick<TeamDirectorySource,
    "id" | "kind" | "state" | "activeReconcileRunId" | "manualSyncRequestedAt"
    | "eventCursor" | "eventRangeStart" | "consecutiveFailureCount" | "retryNotBefore" | "lastErrorCode"
>) {
    return {
        id: current.id,
        kind: current.kind,
        state: current.state,
        activeReconcileRunId: current.activeReconcileRunId,
        manualSyncRequestedAt: current.manualSyncRequestedAt,
        eventCursor: current.eventCursor,
        eventRangeStart: current.eventRangeStart,
        consecutiveFailureCount: current.consecutiveFailureCount,
        retryNotBefore: current.retryNotBefore,
        lastErrorCode: current.lastErrorCode,
    };
}

/**
 * Claim one complete scan after the cluster-wide directory worker lease is
 * held. Replacing the source-local token fences an abandoned or stolen run;
 * every later page and finalizer must present the returned token.
 */
export async function claimDirectorySourceFullReconcile(params: Readonly<{
    sourceId: string;
    reconcileRunId?: string;
    now?: Date;
}>): Promise<
    | Readonly<{ ok: true; source: ClaimedDirectorySource }>
    | Readonly<{ ok: false; code: "directory_source_not_found" | "directory_sync_needs_attention" }>
> {
    const now = params.now ?? new Date();
    const reconcileRunId = params.reconcileRunId ?? randomUUID();
    return await inTx(async (tx) => {
        const current = await tx.teamDirectorySource.findUnique({
            where: { id: params.sourceId },
            select: {
                id: true,
                teamId: true,
                kind: true,
                state: true,
                bindingConfig: true,
                eventCursor: true,
                eventRangeStart: true,
                activeReconcileRunId: true,
                manualSyncRequestedAt: true,
                consecutiveFailureCount: true,
                retryNotBefore: true,
                lastErrorCode: true,
            },
        });
        if (!current) return { ok: false, code: "directory_source_not_found" } as const;
        if (current.state === "paused") {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        if (current.retryNotBefore !== null && current.retryNotBefore > now) {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        if (!await isDirectorySourceKindAllowedInTx(tx, current.kind)) {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        // A request can arrive in the same persisted millisecond as the prior
        // attempt. Consume its ordered marker even when this claim's clock has
        // not advanced yet, so a failed one-shot retry cannot run forever.
        const attemptAt = current.manualSyncRequestedAt !== null && current.manualSyncRequestedAt > now
            ? current.manualSyncRequestedAt
            : now;

        let binding: TeamDirectoryBindingConfigV1 | null = null;
        try {
            binding = parseTeamDirectoryBindingConfigV1(current.bindingConfig);
        } catch {
            // Persisted source documents are untrusted at this boundary. The
            // single failure transition below quarantines malformed and
            // wrong-kind documents identically.
        }
        if (binding === null || binding.kind !== current.kind) {
            const quarantined = await tx.teamDirectorySource.updateMany({
                where: directorySourceClaimWhere(current),
                data: {
                    state: "needs_attention",
                    activeReconcileRunId: null,
                    activeReconcileStartedAt: null,
                    // This claim is the attempt that consumed any outstanding
                    // request; stamping it keeps one press to one attempt.
                    lastAttemptAt: attemptAt,
                    lastErrorCode: "directory_source_identity_mismatch",
                    consecutiveFailureCount: 0,
                    retryNotBefore: null,
                },
            });
            if (quarantined.count !== 1) throw new TransactionReplayRequiredError("directory-source-currentness-changed");
            await publishDirectorySourceStatusTransitionInTx(tx, {
                teamId: current.teamId,
                before: current,
                after: { state: "needs_attention", lastErrorCode: "directory_source_identity_mismatch" },
            });
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        const updated = await tx.teamDirectorySource.updateMany({
            where: directorySourceClaimWhere(current),
            data: {
                state: "initializing",
                activeReconcileRunId: reconcileRunId,
                activeReconcileStartedAt: now,
                lastAttemptAt: attemptAt,
                lastErrorCode: null,
                consecutiveFailureCount: 0,
                retryNotBefore: null,
                ...(current.kind === "workos_directory" && current.eventCursor === null
                    ? { eventRangeStart: now }
                    : {}),
            },
        });
        if (updated.count !== 1) {
            throw new TransactionReplayRequiredError("directory-source-currentness-changed");
        }
        // The running attempt and the cleared failure are what a mounted
        // source detail shows next; entering it is a status transition.
        await publishDirectorySourceStatusTransitionInTx(tx, {
            teamId: current.teamId,
            before: current,
            after: { state: "initializing", lastErrorCode: null },
        });
        return {
            ok: true,
            source: {
                id: current.id,
                teamId: current.teamId,
                kind: current.kind,
                binding,
                reconcileRunId,
                eventCursor: current.eventCursor,
                eventRangeStart: current.kind === "workos_directory" && current.eventCursor === null
                    ? now
                    : current.eventRangeStart,
                observedManualSyncRequestedAt: current.manualSyncRequestedAt,
                consecutiveFailureCount: current.consecutiveFailureCount,
            },
        } as const;
    }, { isolationLevel: "ReadCommitted" /* The source CAS preserves current request, position and retry decisions before returning a run. */ });
}

export async function claimWorkosDirectorySourceIncremental(params: Readonly<{
    sourceId: string;
    now?: Date;
}>): Promise<
    | Readonly<{ ok: true; source: ActiveWorkosDirectorySource }>
    | Readonly<{ ok: false; code: "directory_source_not_found" | "directory_sync_needs_attention" }>
> {
    const now = params.now ?? new Date();
    return await inTx(async (tx) => {
        const current = await tx.teamDirectorySource.findUnique({
            where: { id: params.sourceId },
            select: {
                id: true,
                teamId: true,
                kind: true,
                state: true,
                bindingConfig: true,
                eventCursor: true,
                eventRangeStart: true,
                activeReconcileRunId: true,
                manualSyncRequestedAt: true,
                consecutiveFailureCount: true,
                retryNotBefore: true,
                lastErrorCode: true,
            },
        });
        if (!current) return { ok: false, code: "directory_source_not_found" } as const;
        if (
            current.kind !== "workos_directory"
            || current.state !== "active"
            || current.activeReconcileRunId !== null
            || current.manualSyncRequestedAt !== null
        ) return { ok: false, code: "directory_sync_needs_attention" } as const;
        if (current.retryNotBefore !== null && current.retryNotBefore > now) {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        if (!await isDirectorySourceKindAllowedInTx(tx, "workos_directory")) {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }

        const binding = parseTeamDirectoryBindingConfigV1(current.bindingConfig);
        if (binding.kind !== "workos_directory") {
            return { ok: false, code: "directory_sync_needs_attention" } as const;
        }
        const claimed = await tx.teamDirectorySource.updateMany({
            where: directorySourceClaimWhere(current),
            data: {
                lastAttemptAt: now,
                lastErrorCode: null,
                consecutiveFailureCount: 0,
                retryNotBefore: null,
            },
        });
        if (claimed.count !== 1) {
            throw new TransactionReplayRequiredError("directory-source-currentness-changed");
        }
        // Clearing a shown failure is a status transition; a later empty poll
        // compares against the cleared row and would not announce it.
        await publishDirectorySourceStatusTransitionInTx(tx, {
            teamId: current.teamId,
            before: current,
            after: { state: current.state, lastErrorCode: null },
        });
        return {
            ok: true,
            source: {
                id: current.id,
                teamId: current.teamId,
                kind: "workos_directory",
                binding,
                reconcileRunId: null,
                eventCursor: current.eventCursor,
                eventRangeStart: current.eventRangeStart,
                observedManualSyncRequestedAt: null,
                consecutiveFailureCount: current.consecutiveFailureCount,
            },
        } as const;
    }, { isolationLevel: "ReadCommitted" /* The same source CAS owns incremental request, position and retry currentness. */ });
}

export async function markActiveWorkosDirectoryPollFailed(params: Readonly<{
    sourceId: string;
    expectedPosition:
        | Readonly<{ eventCursor: string }>
        | Readonly<{ eventCursor: null; eventRangeStart: Date }>;
    errorCode: string;
    reconcileRunId?: string;
    consecutiveFailureCount?: number;
    retryAfterMs?: number;
    now?: Date;
}>): Promise<DirectorySourceLifecycleWriteResult> {
    const now = params.now ?? new Date();
    const schedule = deriveDirectoryFailureSchedule({
        kind: "workos_directory",
        consecutiveFailureCount: params.consecutiveFailureCount ?? 0,
        failedAt: now,
        ...(params.retryAfterMs !== undefined ? { retryAfterMs: params.retryAfterMs } : {}),
    });
    const position = params.expectedPosition.eventCursor === null
        ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
        : { eventCursor: params.expectedPosition.eventCursor };
    const where = {
        id: params.sourceId,
        state: "active" as const,
        kind: "workos_directory" as const,
        activeReconcileRunId: params.reconcileRunId ?? null,
        manualSyncRequestedAt: null,
        ...position,
    };
    return await inTx(async (tx) => {
        const before = await tx.teamDirectorySource.findFirst({
            where,
            select: { teamId: true, state: true, lastErrorCode: true },
        });
        if (!before) return { applied: false, reason: "stale_run" } as const;
        const updated = await tx.teamDirectorySource.updateMany({
            where,
            data: {
                // A paginated event observation writes projection rows before
                // its final cursor commit. If that attempt fails, leaving the
                // source active would make those incomplete rows authoritative
                // as soon as the run fence is cleared. Reuse the existing
                // needs-attention -> full-reconcile recovery path for that
                // exact case. A one-shot incremental failure has staged no
                // partial rows and can remain active for its ordinary retry.
                ...(params.reconcileRunId !== undefined ? { state: "needs_attention" as const } : {}),
                activeReconcileRunId: null,
                activeReconcileStartedAt: null,
                lastErrorCode: params.errorCode,
                ...cursorLossRecovery(params.errorCode),
                ...(isDirectoryErrorRetryable(params.errorCode)
                    ? schedule
                    : { consecutiveFailureCount: 0, retryNotBefore: null }),
            },
        });
        if (updated.count !== 1) return { applied: false, reason: "stale_run" } as const;
        const after = await tx.teamDirectorySource.findUniqueOrThrow({
            where: { id: params.sourceId },
            select: { state: true, lastErrorCode: true },
        });
        await publishDirectorySourceStatusTransitionInTx(tx, {
            teamId: before.teamId,
            before,
            after,
        });
        return { applied: true } as const;
    }, { isolationLevel: "ReadCommitted" /* The full state/run/manual-request/position CAS rejects stale poll failures. */ });
}

/**
 * Wakes the Team's readers when a lifecycle write changes what the Directory
 * Sync projection shows.
 *
 * Administrator mutations publish unconditionally: a person is waiting on the
 * result of their own press. The worker instead runs on a timer over every
 * source, so it publishes on a status transition only — the `state` and
 * `lastErrorCode` the summary turns into attempt, error and allowed actions.
 * An identical successful poll changes nothing a reader can see, and waking
 * every Team once per sync interval for it would be pure fanout.
 */
export async function publishDirectorySourceStatusTransitionInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        before: Readonly<{ state: string; lastErrorCode: string | null }>;
        after: Readonly<{ state: string; lastErrorCode: string | null }>;
    }>,
): Promise<boolean> {
    if (
        params.before.state === params.after.state
        && params.before.lastErrorCode === params.after.lastErrorCode
    ) return false;
    await publishTeamChangedInTx(tx, { teamId: params.teamId });
    return true;
}

/**
 * A rejected event bookmark cannot be advanced, skipped, or guessed forward
 * (child 05 §8.4). Dropping the unusable position under the same
 * compare-and-swap leaves the source needing attention and makes the next
 * claimed run capture a fresh replay boundary before a complete reconciliation;
 * committed native facts and the previous success horizon are untouched.
 */
function cursorLossRecovery(errorCode: string): Readonly<{
    state?: "needs_attention";
    eventCursor?: null;
    eventRangeStart?: null;
}> {
    return errorCode === "directory_cursor_expired"
        ? { state: "needs_attention", eventCursor: null, eventRangeStart: null }
        : {};
}

export async function markDirectorySourceReconcileFailed(params: Readonly<{
    sourceId: string;
    reconcileRunId: string;
    errorCode: string;
    consecutiveFailureCount?: number;
    retryAfterMs?: number;
    now?: Date;
}>): Promise<DirectorySourceLifecycleWriteResult> {
    const now = params.now ?? new Date();
    const where = {
        id: params.sourceId,
        state: "initializing" as const,
        activeReconcileRunId: params.reconcileRunId,
    };
    return await inTx(async (tx) => {
        const before = await tx.teamDirectorySource.findFirst({
            where,
            select: { teamId: true, kind: true, state: true, lastErrorCode: true },
        });
        if (!before) return { applied: false, reason: "stale_run" } as const;
        const schedule = deriveDirectoryFailureSchedule({
            kind: before.kind,
            consecutiveFailureCount: params.consecutiveFailureCount ?? 0,
            failedAt: now,
            ...(params.retryAfterMs !== undefined ? { retryAfterMs: params.retryAfterMs } : {}),
        });
        const updated = await tx.teamDirectorySource.updateMany({
            where,
            data: {
                state: "needs_attention",
                activeReconcileRunId: null,
                activeReconcileStartedAt: null,
                lastErrorCode: params.errorCode,
                ...cursorLossRecovery(params.errorCode),
                ...(isDirectoryErrorRetryable(params.errorCode)
                    ? schedule
                    : { consecutiveFailureCount: 0, retryNotBefore: null }),
            },
        });
        if (updated.count !== 1) return { applied: false, reason: "stale_run" } as const;
        await publishDirectorySourceStatusTransitionInTx(tx, {
            teamId: before.teamId,
            before,
            after: { state: "needs_attention", lastErrorCode: params.errorCode },
        });
        return { applied: true } as const;
    }, { isolationLevel: "ReadCommitted" /* The current initializing run CAS owns this source-only failure transition. */ });
}

/**
 * Why a source cannot take a complete-scan request, other than being paused.
 *
 * Each reason names what actually blocks the repair: the Home no longer lets
 * Teams use the provider kind (only a Home administrator can change that), or
 * the persisted binding document no longer describes a directory of its kind
 * (the claim path's identity mismatch). Neither is cleared by Sync, Retry or
 * Resume, so both are reported as themselves rather than as needs-attention.
 * Sync/Retry and Resume both ask this one owner.
 */
export async function readDirectorySourceRepairRefusalInTx(
    tx: Tx,
    source: Readonly<{ kind: TeamDirectoryBindingConfigV1["kind"]; bindingConfig: unknown }>,
): Promise<DirectorySourceRepairRefusal | null> {
    if (!await isDirectorySourceKindAllowedInTx(tx, source.kind)) return "team_identity_not_allowed";
    // A durable request must be work the claim path can serve. Both claims
    // refuse a source whose binding document no longer parses for its kind.
    try {
        if (parseTeamDirectoryBindingConfigV1(source.bindingConfig).kind !== source.kind) {
            return "directory_source_identity_mismatch";
        }
    } catch {
        return "directory_source_identity_mismatch";
    }
    return null;
}

export type DirectorySourceRepairRefusal = "team_identity_not_allowed" | "directory_source_identity_mismatch";

export type DirectorySourceSyncRequestResult =
    | Readonly<{ ok: true; status: "requested" | "coalesced" }>
    | Readonly<{
        ok: false;
        code: "directory_source_not_found" | "directory_sync_needs_attention" | DirectorySourceRepairRefusal;
    }>;

export async function requestDirectorySourceSync(params: Readonly<{
    sourceId: string;
    now?: Date;
}>): Promise<DirectorySourceSyncRequestResult> {
    const now = params.now ?? new Date();
    return await inTx((tx) => requestDirectorySourceSyncInTx(tx, { ...params, now }), { isolationLevel: "ReadCommitted" /* Request markers are computed from, and guarded by, the current source lifecycle. */ });
}

/**
 * Record the explicit Sync / Retry request: one complete scan (child 05 §11.2,
 * §14.1; recovery "starts another complete scan", §9.6).
 *
 * Only a paused source answers `directory_sync_needs_attention` — its recovery
 * is the explicit Resume (:498). A failed source, including one parked on a
 * failure the scheduler will not repeat on its own, accepts the request: that
 * is the administrator's Retry. The press is bounded to one attempt by facts
 * the source already carries — the request timestamp against `lastAttemptAt`,
 * which every claim stamps — so due selection admits a parked source only for
 * a request no attempt has consumed yet, and a failed attempt never replays.
 */
export async function requestDirectorySourceSyncInTx(
    tx: Tx,
    params: Readonly<{ sourceId: string; now?: Date }>,
): Promise<DirectorySourceSyncRequestResult> {
    const now = params.now ?? new Date();
    const current = await tx.teamDirectorySource.findUnique({
        where: { id: params.sourceId },
        select: {
            state: true,
            kind: true,
            bindingConfig: true,
            manualSyncRequestedAt: true,
            lastAttemptAt: true,
            activeReconcileRunId: true,
        },
    });
    if (!current) return { ok: false, code: "directory_source_not_found" } as const;
    if (current.state === "paused") {
        return { ok: false, code: "directory_sync_needs_attention" } as const;
    }
    const refusal = await readDirectorySourceRepairRefusalInTx(tx, current);
    if (refusal !== null) return { ok: false, code: refusal } as const;
    // A request no attempt has consumed yet — or that the running attempt
    // already observed — coalesces. One an attempt already consumed is spent:
    // a new press is a new request, never a silent coalesce into a failure.
    if (
        current.manualSyncRequestedAt !== null
        && (
            current.activeReconcileRunId !== null
            || current.lastAttemptAt === null
            || current.manualSyncRequestedAt.getTime() > current.lastAttemptAt.getTime()
        )
    ) {
        return { ok: true, status: "coalesced" } as const;
    }
    const requested = await tx.teamDirectorySource.updateMany({
        where: {
            id: params.sourceId,
            state: current.state,
            activeReconcileRunId: current.activeReconcileRunId,
            manualSyncRequestedAt: current.manualSyncRequestedAt,
            lastAttemptAt: current.lastAttemptAt,
        },
        data: {
            // Preserve request-after-attempt ordering at database millisecond
            // precision without changing the source's one-request/one-claim
            // lifecycle or introducing another counter.
            manualSyncRequestedAt: current.lastAttemptAt !== null && now <= current.lastAttemptAt
                ? new Date(current.lastAttemptAt.getTime() + 1)
                : now,
        },
    });
    if (requested.count !== 1) throw new TransactionReplayRequiredError("directory-source-currentness-changed");
    return {
        ok: true,
        status: current.state === "initializing" ? "coalesced" : "requested",
    } as const;
}
