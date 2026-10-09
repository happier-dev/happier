import {
    type ManagedResourceDependencyV1, type ManagedResourceDispositionV1,
    formatSharedSavedSecretRefV1,
    SHARED_SAVED_SECRET_REF_V1_PREFIX,
    isSessionEncryptionModeAllowedByStoragePolicy,
    TeamRoleV1Schema,
    parseEncryptedDataKeyEnvelopeV1,
    SavedSecretCatalogEntryV1Schema,
    SavedSecretResourceStoredContentV1Schema,
    type SavedSecretCatalogEntryV1,
    type SavedSecretCatalogCorruptEntryV1,
    type SavedSecretCatalogResultV1,
    type SavedSecretResourceEnvelopeCensusRecipientV1,
    type SavedSecretResourceStoredContentV1,
    type AccountSettingsStoredContentEnvelope,
} from "@happier-dev/protocol";
import { acceptsManagedResourceDispositions, readManagedResourceDependenciesInTx } from '@/app/machines/managed/managedRead';
import { isTeamPrincipalRoleV1 } from "@happier-dev/protocol/teams";
import { SavedSecretReferenceCensusV1Schema, SavedSecretPromoteReferenceCensusV1Schema, SavedSecretCatalogMutationsV1Schema, SavedSecretPersonalPromotionsV1Schema,
    type SavedSecretReferenceCensusV1, type SavedSecretPromoteReferenceCensusV1, type SavedSecretCatalogMutationsV1,
    type SavedSecretCatalogRevisionsV1, type SavedSecretPersonalPromotionsV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveSavedSecretImportResourceIdV1, listAccountSettingsSavedSecretReferences,
    type SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openMcpServerCatalogContentV1, parseMcpServerCatalogMigrationContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { openAcpCatalogContentV1, listAcpCatalogEnvelopeSavedSecretDiagnosticsV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { openProviderConnectionsContentV1, parseProviderConnectionsMigrationContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { openConnectedAccountCatalogContentV1, parseConnectedAccountCatalogMigrationContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsHistorySavedSecretTransferV1Schema, type AccountSettingsHistorySavedSecretTransferV1 } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ProfileRowMutationV1Schema, type ProfileRowMutationV1, type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { type ProfileTransferControlV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { listTransferredProfileIdsV1, loadAiLaunchProfileArtifacts, removeTransferredProfileSourcesV1, resolveProfileCatalogAuthorityV1 } from '@happier-dev/protocol/profiles/read';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { readLaunchProfileArtifactForReferenceCensusV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { parseSavedSecretRefV1, listSavedSecretReferenceCarrierPathsV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { RemoteHostCatalogRowMutationV1Schema, isCompleteRetainedRemoteHostCatalogV1, readRetainedRemoteHostCatalogV1, type RemoteHostCatalogRowMutationV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { MachineEnvironmentV1ReadSchema } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';
import { invalidatePresetInTx } from '@/app/machines/managed/machinePresetService';
import { invalidateManagedMachineInTx } from '@/app/machines/managed/managedRows';
import { readRemoteHostCatalogRowInTx, mutateRemoteHostCatalogRowInTx, validateRemoteHostReferenceCensusInTx } from '@/app/account/remoteHosts/remoteHostRows';
import { NotificationChannelCatalogMutationV1Schema, readLegacyNotificationChannelInventoryV1, isCompleteLegacyNotificationChannelSourceV1,
    type NotificationChannelCatalogMutationV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { readNotificationChannelCatalogInTx, mutateNotificationChannelCatalogInTx, validateNotificationChannelReferenceCensusInTx } from '@/app/account/notifications/channelRows';
import type { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import * as privacyKit from "privacy-kit";
import { writeAccountSettingsInTx } from "@/app/accountSettings/writeAccountSettingsInTx";
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { advanceProfileReferenceGuardInTx, mutateProfileRowsInTx, validateProfileReferenceCensusInTx } from '@/app/account/profiles/profileRows';
import { readProfileTransferControlInTx } from '@/app/account/profiles/profileTransferControl';
import { readArtifactForCallerInTx, projectPlainArtifactSharingResourceV1 } from '@/app/artifacts/artifactAccessService';
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import {
    resolveSessionAccessGrantAccountSubjectsInTx,
    resolveSessionAccessGrantSubjectInTx,
} from "@/app/session/access/sessionAccessGrantEligibility";
import {
    qualifyTeamOperationAuthenticationsInTx,
    resolveTeamActorContextInTx,
    resolveTeamActorContextsInTx,
    type TeamOperationAuthenticationContext,
} from "@/app/teams/actorContext";
import { resolveTeamCredentialCapabilities } from "@/app/teams/capabilities";
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
    type AccountDisplayProfileRow,
} from "@/app/account/profile/accountDisplayProfile";
import {
    decodeSensitiveContentFromAtRestStorage,
    encodeSensitiveContentForAtRestStorage,
} from "@/app/encryption/sensitiveContentAtRestStorage";
import type { Tx } from "@/storage/inTx";

type StoredResourceRow = Readonly<{
    id: string;
    ownerAccountId: string;
    displayName: string;
    kind: string;
    encryptionMode: string;
    revision: number;
    storedContent: string;
    owner: AccountDisplayProfileRow;
    accountGrants: readonly { accountId: string; account: AccountDisplayProfileRow }[];
    teamGrants: readonly {
        teamId: string;
        team: { id: string; name: string; memberships: readonly { accountId: string; role: string }[] };
    }[];
    groupGrants: readonly {
        teamGroupId: string;
        teamGroup: {
            id: string;
            teamId: string;
            name: string;
            team: { id: string; name: string };
            memberships: readonly { teamMembership: { accountId: string } }[];
        };
    }[];
    keyEnvelopes?: readonly Readonly<{
        encryptedDataKey: Uint8Array;
        recipientContentPublicKeyFingerprint: string;
    }>[];
}>;

type SavedSecretResourceReferenceCaptureInput = Readonly<{
    references: readonly string[];
    savedSecretRevisions: readonly Readonly<{ resourceId: string; expectedRevision: number }>[];
    /** Only the genuine Profile importer can retain personal ids before S2 promotion. */
    allowPersonal?: boolean;
}>;

/** The incumbent resource owner makes every catalog's use/access/currentness decision. */
export function validateSavedSecretResourceReferenceCapturesV1(
    resources: readonly SavedSecretCatalogResultV1[], input: SavedSecretResourceReferenceCaptureInput,
): boolean {
    for (const reference of input.references) {
        let parsed: ReturnType<typeof parseSavedSecretRefV1>;
        try {
            parsed = parseSavedSecretRefV1(reference);
        } catch {
            return false;
        }
        if (parsed.kind === 'personal') {
            if (!input.allowPersonal) return false;
            continue;
        }
        const entry = resources.find(resource => 'ref' in resource && resource.ref === formatSharedSavedSecretRefV1(parsed.resourceId));
        const capture = input.savedSecretRevisions.find(candidate => candidate.resourceId === parsed.resourceId);
        if (!entry || !('ref' in entry) || !entry.capabilities.use || !capture || capture.expectedRevision !== entry.revision) return false;
    }
    return true;
}

export async function validateSavedSecretResourceReferencesInTx(tx: Tx, input: SavedSecretResourceReferenceCaptureInput & Readonly<{
    accountId: string; authentication?: TeamOperationAuthenticationContext;
}>): Promise<boolean> {
    const resources = input.references.length > 0
        ? await listSavedSecretResourcesForAccountInTx(tx, input.accountId, input.authentication) : [];
    return validateSavedSecretResourceReferenceCapturesV1(resources, input);
}

/**
 * The archive state of a Saved Secret's Team-derived grant arms, as one filter
 * every reader applies.
 *
 * An archived Team or Group no longer authorizes anything, so its grant arm is
 * not an effective arm — for the outer row predicate, for the nested arms a
 * retained row is projected from, and for the recipient roster alike. These
 * lived as three byte-divergent expressions and only the roster reader carried
 * them on the nested relations, which is how an archived Group kept both
 * retaining and naming a row whose only other arm the caller failed.
 */
const ACTIVE_SAVED_SECRET_TEAM_GRANT_WHERE = { team: { archivedAt: null } } as const;
const ACTIVE_SAVED_SECRET_GROUP_GRANT_WHERE = {
    teamGroup: { archivedAt: null, team: { archivedAt: null } },
} as const;

/** Rows this Account can currently reach through any one of its four grant arms. */
function authorizedSavedSecretRowWhere(accountId: string): Prisma.SavedSecretResourceWhereInput {
    return {
        OR: [
            { ownerAccountId: accountId },
            { accountGrants: { some: { accountId } } },
            {
                teamGrants: {
                    some: {
                        team: {
                            archivedAt: null,
                            memberships: { some: { accountId, status: "active", role: { not: "guest" }, account: { status: "active" } } },
                        },
                    },
                },
            },
            {
                groupGrants: {
                    some: {
                        teamGroup: {
                            archivedAt: null,
                            team: { archivedAt: null },
                            memberships: {
                                some: {
                                    teamMembership: {
                                        accountId,
                                        status: "active",
                                        account: { status: "active" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        ],
    };
}

/**
 * The one row shape both catalog and material reads project, with the caller's
 * own membership rows on each effective arm. Retention, provenance and material
 * disclosure therefore always read the same arms.
 */
function authorizedSavedSecretRowSelect(accountId: string) {
    return {
        id: true, ownerAccountId: true, displayName: true, kind: true,
        encryptionMode: true, revision: true, storedContent: true,
        owner: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
        accountGrants: { select: { accountId: true, account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } } },
        teamGrants: {
            where: ACTIVE_SAVED_SECRET_TEAM_GRANT_WHERE,
            select: {
                teamId: true,
                team: {
                    select: {
                        id: true,
                        name: true,
                        memberships: {
                            where: { accountId, status: "active", account: { status: "active" } },
                            select: { accountId: true, role: true },
                        },
                    },
                },
            },
        },
        groupGrants: {
            where: ACTIVE_SAVED_SECRET_GROUP_GRANT_WHERE,
            select: {
                teamGroupId: true,
                teamGroup: {
                    select: {
                        id: true,
                        teamId: true,
                        name: true,
                        team: { select: { id: true, name: true } },
                        memberships: {
                            where: { teamMembership: { accountId, status: "active", account: { status: "active" } } },
                            select: { teamMembership: { select: { accountId: true } } },
                        },
                    },
                },
            },
        },
        keyEnvelopes: {
            where: { recipientAccountId: accountId },
            select: { encryptedDataKey: true, recipientContentPublicKeyFingerprint: true },
        },
    } as const;
}

type SavedSecretRecipientAccountRow = Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

/**
 * Which of these Teams the caller's exact credential currently qualifies for.
 *
 * Shared Saved Secrets own no authentication policy: they read the one Team
 * qualification owner, in this transaction, for every Team-derived arm. The
 * batch entry point is used so a catalog page costs one qualification, not one
 * per row.
 */
async function qualifiedSavedSecretTeamIdsInTx(
    tx: Tx,
    input: Readonly<{
        teamIds: readonly string[];
        actorAccountId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<ReadonlySet<string>> {
    const teamIds = [...new Set(input.teamIds)];
    if (teamIds.length === 0) return new Set();
    const { isServerFeatureEnabledForHome } = await import("@/app/features/catalog/serverFeatureGate");
    if (!await isServerFeatureEnabledForHome('teams', { tx })) return new Set();
    const contexts = await resolveTeamActorContextsInTx(tx, {
        teamIds,
        actorAccountId: input.actorAccountId,
    });
    if (contexts.size === 0) return new Set();
    const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, {
        ...input.authentication,
        contexts: [...contexts.values()],
    });
    const qualified = new Set<string>();
    for (const [teamId, result] of qualifications) if (result.ok) qualified.add(teamId);
    return qualified;
}

/** Every named Team qualifies, or the Team-derived operation is refused. */
async function areSavedSecretTeamsQualifiedInTx(
    tx: Tx,
    input: Readonly<{
        teamIds: readonly string[];
        actorAccountId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<boolean> {
    const teamIds = [...new Set(input.teamIds)];
    if (teamIds.length === 0) return true;
    const qualified = await qualifiedSavedSecretTeamIdsInTx(tx, input);
    return teamIds.every((teamId) => qualified.has(teamId));
}

type SavedSecretTeamDerivedRow = Readonly<{
    ownerAccountId: string;
    accountGrants: readonly { accountId: string }[];
    teamGrants: readonly { teamId: string; team: { memberships: readonly { role: string }[] } }[];
    groupGrants: readonly { teamGroup: { teamId: string; memberships: readonly unknown[] } }[];
}>;

/**
 * The Team-derived arms of one row that structurally authorize this Account,
 * before Team qualification: a Team arm needs a current principal membership,
 * a Group arm needs a current Group membership, and an archived Team or Group
 * carries no arm at all because the read never selected it.
 *
 * Retention and provenance both consume this one answer, so a row can never be
 * kept by an arm the projection would then refuse to name — or, worse, named by
 * an arm retention never proved.
 */
function effectiveSavedSecretTeamArms<TRow extends SavedSecretTeamDerivedRow>(row: TRow): Readonly<{
    teamGrants: readonly TRow["teamGrants"][number][];
    groupGrants: readonly TRow["groupGrants"][number][];
}> {
    return {
        teamGrants: row.teamGrants.filter((grant) => grant.team.memberships.some((membership) => {
            const role = TeamRoleV1Schema.safeParse(membership.role);
            return role.success && isTeamPrincipalRoleV1(role.data);
        })),
        groupGrants: row.groupGrants.filter((grant) => grant.teamGroup.memberships.length > 0),
    };
}

/**
 * Drop the rows whose only authorization is a Team or Group arm the caller's
 * current credential does not satisfy, and say which Teams it did satisfy.
 *
 * The owner and direct-Account arms are independent of any Team policy and are
 * never touched. Only the Team-derived arms consume the Lane 03 qualification,
 * so a restricted Team never discloses its granted secrets to a member holding
 * a weaker credential — and never refuses the caller's own resources either.
 *
 * The qualified Team set is returned because the row projection needs the same
 * answer: a row kept by its direct grant must not then name a restricted Team
 * the credential never qualified through. One batch call over the union of
 * every candidate row's Teams answers both questions, so provenance and
 * retention can never disagree.
 */
async function retainQualifiedSavedSecretRowsInTx<TRow extends SavedSecretTeamDerivedRow>(
    tx: Tx,
    input: Readonly<{
        rows: readonly TRow[];
        accountId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<Readonly<{ rows: readonly TRow[]; qualifiedTeamIds: ReadonlySet<string> }>> {
    const qualifiedTeamIds = await qualifiedSavedSecretTeamIdsInTx(tx, {
        teamIds: input.rows.flatMap(savedSecretRowTeamIds),
        actorAccountId: input.accountId,
        authentication: input.authentication,
    });
    return {
        rows: input.rows.filter((row) => isDirectlyAuthorizedSavedSecretRow(row, input.accountId)
            || savedSecretRowTeamIds(row).some((teamId) => qualifiedTeamIds.has(teamId))),
        qualifiedTeamIds,
    };
}

function isDirectlyAuthorizedSavedSecretRow(row: SavedSecretTeamDerivedRow, accountId: string): boolean {
    return row.ownerAccountId === accountId
        || row.accountGrants.some((grant) => grant.accountId === accountId);
}

function savedSecretRowTeamIds(row: SavedSecretTeamDerivedRow): readonly string[] {
    const arms = effectiveSavedSecretTeamArms(row);
    return [
        ...arms.teamGrants.map((grant) => grant.teamId),
        ...arms.groupGrants.map((grant) => grant.teamGroup.teamId),
    ];
}

/**
 * Compose the existing Home-local collaboration and Team credential decisions.
 * This service owns no role, lifecycle, friendship, membership, or Group rule.
 */
async function isSavedSecretAudienceEligibleInTx(
    tx: Tx,
    input: Readonly<{
        ownerAccountId: string;
        accountIds: readonly string[];
        teamIds: readonly string[];
        groupIds: readonly string[];
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<boolean> {
    const groups = input.groupIds.length === 0
        ? []
        : await tx.teamGroup.findMany({
            where: { id: { in: [...input.groupIds] } },
            select: { id: true, teamId: true },
        });
    if (groups.length !== input.groupIds.length) return false;

    const teamIds = [...new Set([...input.teamIds, ...groups.map((group) => group.teamId)])];
    // A Team or Group audience is Team-derived authority, so the writer's exact
    // credential must satisfy that Team's current authentication policy before
    // the grant is persisted. Structural membership alone is not admission.
    if (!await areSavedSecretTeamsQualifiedInTx(tx, {
        teamIds,
        actorAccountId: input.ownerAccountId,
        authentication: input.authentication,
    })) return false;
    const [accountSubjects, teamSubjects, groupSubjects, teamActors] = await Promise.all([
        resolveSessionAccessGrantAccountSubjectsInTx(tx, {
            actorAccountId: input.ownerAccountId,
            sessionOwnerAccountId: input.ownerAccountId,
            subjectAccountIds: input.accountIds,
            hasExistingGrant: false,
        }),
        Promise.all(input.teamIds.map((teamId) => resolveSessionAccessGrantSubjectInTx(tx, {
            actorAccountId: input.ownerAccountId,
            sessionOwnerAccountId: input.ownerAccountId,
            subject: { kind: "team", teamId },
            hasExistingGrant: false,
        }))),
        Promise.all(groups.map((group) => resolveSessionAccessGrantSubjectInTx(tx, {
            actorAccountId: input.ownerAccountId,
            sessionOwnerAccountId: input.ownerAccountId,
            subject: { kind: "group", teamId: group.teamId, groupId: group.id },
            hasExistingGrant: false,
        }))),
        Promise.all(teamIds.map((teamId) => resolveTeamActorContextInTx(tx, {
            actorAccountId: input.ownerAccountId,
            teamId,
        }))),
    ]);
    return accountSubjects.every((result) => result.ok)
        && teamSubjects.every((result) => result.ok)
        && groupSubjects.every((result) => result.ok)
        && teamActors.every((actor) => actor !== null && resolveTeamCredentialCapabilities({
            ...actor,
            teamArchivedAt: actor.team.archivedAt,
        }).offerOwnCredential);
}

async function listAuthorizedAccountIdsForResourceInTx(
    tx: Tx,
    resourceId: string,
): Promise<readonly string[]> {
    const row = await tx.savedSecretResource.findUnique({
        where: { id: resourceId },
        select: {
            ownerAccountId: true,
            accountGrants: { select: { accountId: true } },
            teamGrants: {
                where: ACTIVE_SAVED_SECRET_TEAM_GRANT_WHERE,
                select: {
                    team: {
                        select: {
                            memberships: {
                                where: { status: "active", account: { status: "active" } },
                                select: { accountId: true, role: true },
                            },
                        },
                    },
                },
            },
            groupGrants: {
                where: ACTIVE_SAVED_SECRET_GROUP_GRANT_WHERE,
                select: {
                    teamGroup: {
                        select: {
                            memberships: {
                                where: { teamMembership: { status: "active", account: { status: "active" } } },
                                select: { teamMembership: { select: { accountId: true } } },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!row) return [];
    return [...new Set([
        row.ownerAccountId,
        ...row.accountGrants.map((grant) => grant.accountId),
        ...row.teamGrants.flatMap((grant) => grant.team.memberships
            .filter((member) => {
                const role = TeamRoleV1Schema.safeParse(member.role);
                return role.success && isTeamPrincipalRoleV1(role.data);
            })
            .map((member) => member.accountId)),
        ...row.groupGrants.flatMap((grant) => grant.teamGroup.memberships.map((member) => member.teamMembership.accountId)),
    ])];
}

async function resolveSavedSecretAudienceAccountIdsInTx(
    tx: Tx,
    input: Readonly<{
        ownerAccountId: string;
        accountIds: readonly string[];
        teamIds: readonly string[];
        groupIds: readonly string[];
    }>,
): Promise<readonly string[]> {
    const [teamMembers, groupMembers] = await Promise.all([
        input.teamIds.length === 0 ? [] : tx.teamMembership.findMany({
            where: {
                teamId: { in: [...input.teamIds] },
                status: "active",
                account: { status: "active" },
                team: { archivedAt: null },
            },
            select: { accountId: true, role: true },
        }),
        input.groupIds.length === 0 ? [] : tx.teamGroupMembership.findMany({
            where: {
                teamGroupId: { in: [...input.groupIds] },
                group: { archivedAt: null, team: { archivedAt: null } },
                teamMembership: { status: "active", account: { status: "active" } },
            },
            select: { teamMembership: { select: { accountId: true } } },
        }),
    ]);
    return [...new Set([
        input.ownerAccountId,
        ...input.accountIds,
        ...teamMembers.filter((member) => isTeamPrincipalRoleV1(member.role)).map((member) => member.accountId),
        ...groupMembers.map((member) => member.teamMembership.accountId),
    ])];
}

async function markResourceChangedForAccounts(
    tx: Tx,
    resourceId: string,
    revision: number,
    accountIds: readonly string[],
): Promise<void> {
    void revision;
    await markAccountsChanged(tx, {
        accountIds,
        kind: "savedSecretResource",
        entityId: resourceId,
    });
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function hasSameStringSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

type SavedSecretRecipientEnvelopeInput = Readonly<{
    recipientAccountId: string;
    encryptedDataKey: Uint8Array;
    recipientContentPublicKeyFingerprint: string;
}>;

type SavedSecretRecipientEnvelopeRejection =
    | "duplicate_recipient"
    | "unknown_recipient"
    | "key_unavailable"
    | "fingerprint_mismatch"
    | "malformed_envelope";

/**
 * One answer to "is this submitted envelope material current, verified and
 * well-formed for its recipient".
 *
 * Creation, grant replacement, mode conversion and envelope repair all admit
 * recipient material on exactly these terms; they used to write the same three
 * checks separately, so a change to key readiness had to be made in every copy.
 * Who may hold an envelope at all genuinely differs per operation and stays
 * with the caller, as does the error vocabulary each one publishes.
 */
function readSavedSecretRecipientEnvelopeRejection(
    envelopes: readonly SavedSecretRecipientEnvelopeInput[],
    recipientsById: ReadonlyMap<string, SavedSecretRecipientAccountRow>,
): SavedSecretRecipientEnvelopeRejection | null {
    const recipientIds = envelopes.map((envelope) => envelope.recipientAccountId);
    if (new Set(recipientIds).size !== recipientIds.length) return "duplicate_recipient";
    for (const envelope of envelopes) {
        const recipient = recipientsById.get(envelope.recipientAccountId);
        if (!recipient) return "unknown_recipient";
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(recipient);
        if (readiness.status !== "available") return "key_unavailable";
        if (readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            return "fingerprint_mismatch";
        }
        if (parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) === null) return "malformed_envelope";
    }
    return null;
}

/** The one idempotent recipient-envelope write, shared by every admitting owner. */
async function upsertSavedSecretResourceKeyEnvelopesInTx(
    tx: Tx,
    resourceId: string,
    envelopes: readonly SavedSecretRecipientEnvelopeInput[],
): Promise<void> {
    for (const envelope of envelopes) {
        await tx.savedSecretResourceKeyEnvelope.upsert({
            where: {
                resourceId_recipientAccountId: {
                    resourceId,
                    recipientAccountId: envelope.recipientAccountId,
                },
            },
            create: {
                resourceId,
                recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey: copyBytes(envelope.encryptedDataKey),
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
            },
            update: {
                encryptedDataKey: copyBytes(envelope.encryptedDataKey),
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
            },
        });
    }
}

const SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT = {
    id: true,
    publicKey: true,
    encryptionMode: true,
    contentPublicKey: true,
    contentPublicKeySig: true,
} as const;

export type SavedSecretResourceServiceError =
    | "invalid_resource"
    | "resource_not_found"
    | "forbidden"
    | "resource_changed"
    | "recipient_changed"
    | "recipient_key_unavailable"
    | "invalid_cursor"
    | "recipient_mode_unsupported"
    | "settings_conflict"
    | "settings_invalid"
    | "references_conflict"
    | "references_invalid"
    | "resource_in_use";

export type SavedSecretResourceServiceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: SavedSecretResourceServiceError }>;

export type SavedSecretResourceDeleteResult =
    | SavedSecretResourceServiceResult<{ resourceId: string }>
    | Readonly<{ ok: false; error: "managed_resources_review_required"; resources: readonly ManagedResourceDependencyV1[] }>;

/**
 * A typed business rejection discovered after promotion has already written rows.
 * It must escape the transaction callback so Prisma rolls every preceding write
 * back; the HTTP owner catches it only after `inTx` has completed that rollback.
 */
export class SavedSecretResourceTransactionAbort extends Error {
    readonly error: SavedSecretResourceServiceError;

    constructor(error: SavedSecretResourceServiceError) {
        super(`Saved Secret resource transaction aborted: ${error}`);
        this.name = "SavedSecretResourceTransactionAbort";
        this.error = error;
    }
}

function readStoredContent(resourceId: string, value: string): SavedSecretResourceStoredContentV1 | null {
    try {
        const opened = decodeSensitiveContentFromAtRestStorage({
            keyPath: ["storage", "saved_secret_resource", resourceId, "v1"],
            value,
        });
        const parsed = SavedSecretResourceStoredContentV1Schema.safeParse(opened);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function storeContent(resourceId: string, content: SavedSecretResourceStoredContentV1): string {
    return encodeSensitiveContentForAtRestStorage({
        contentMode: content.t === "plain" ? "plain" : "e2ee",
        keyPath: ["storage", "saved_secret_resource", resourceId, "v1"],
        content,
    });
}

type EncryptedMaterialStatus =
    | "ready"
    | "preparing_encrypted_access"
    | "recipient_mode_unsupported"
    | "update_required";

/**
 * The stored recipient envelope, but only when its bytes still parse as a V1
 * envelope.
 *
 * One answer to "is this persisted envelope usable", shared by the material
 * status, the owner census and the material projection. They used to decide it
 * separately, so the projection kept emitting the very bytes the status had
 * already classified `update_required` — and because the wire schema refines
 * those bytes to an exact canonical length, one damaged row failed the whole
 * materials response instead of only itself.
 */
function readUsableRecipientEnvelope<TEnvelope extends Readonly<{ encryptedDataKey: Uint8Array }>>(
    envelope: TEnvelope | null,
): TEnvelope | null {
    if (!envelope) return null;
    return parseEncryptedDataKeyEnvelopeV1(new Uint8Array(envelope.encryptedDataKey)) === null
        ? null
        : envelope;
}

function resolveEncryptedMaterialStatus(
    account: SavedSecretRecipientAccountRow | null,
    envelope: StoredResourceRow["keyEnvelopes"] extends readonly (infer T)[] | undefined ? T | null : never,
): EncryptedMaterialStatus {
    if (!account) return "update_required";
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    if (readiness.status === "unavailable") {
        if (readiness.reason === "plain_account") return "recipient_mode_unsupported";
        if (readiness.reason === "encryption_setup_required") return "preparing_encrypted_access";
        return "update_required";
    }
    if (!envelope) return "preparing_encrypted_access";
    const usable = readUsableRecipientEnvelope(envelope);
    if (!usable) return "update_required";
    return usable.recipientContentPublicKeyFingerprint
        === readiness.binding.contentPublicKeyFingerprint
        ? "ready"
        : "preparing_encrypted_access";
}

function projectCorruptRow(
    row: StoredResourceRow,
    accountId: string,
): SavedSecretCatalogCorruptEntryV1 {
    return row.ownerAccountId === accountId
        ? {
            materialStatus: "resource_corrupt",
            relationship: "owner",
            repair: {
                kind: "delete_resource",
                resourceId: row.id,
                expectedRevision: row.revision,
            },
        }
        : {
            materialStatus: "resource_corrupt",
            relationship: "recipient",
            repair: null,
        };
}

/**
 * `qualifiedTeamIds` is the set the retention pass established for this caller
 * in this transaction. Recipient provenance names only the arms that actually
 * admitted the caller, so a resource kept by a direct grant never discloses the
 * identity of a restricted Team whose policy the caller failed. Owner `audience`
 * is the roster the owner wrote and is unaffected.
 */
function projectRow(
    row: StoredResourceRow,
    accountId: string,
    encryptedMaterialStatus: EncryptedMaterialStatus,
    qualifiedTeamIds: ReadonlySet<string>,
): SavedSecretCatalogResultV1 | null {
    const isOwner = row.ownerAccountId === accountId;
    const hasDirect = row.accountGrants.some((grant) => grant.accountId === accountId);
    const effective = effectiveSavedSecretTeamArms(row);
    const matchingTeams = effective.teamGrants.filter((grant) => qualifiedTeamIds.has(grant.teamId));
    const matchingGroups = effective.groupGrants.filter((grant) => qualifiedTeamIds.has(grant.teamGroup.teamId));
    const hasGrant = isOwner || hasDirect || matchingTeams.length > 0 || matchingGroups.length > 0;
    if (!hasGrant) return null;
    let ref: string;
    try {
        ref = formatSharedSavedSecretRefV1(row.id);
    } catch {
        return projectCorruptRow(row, accountId);
    }
    const stored = readStoredContent(row.id, row.storedContent);
    const modeMatches = (row.encryptionMode === "plain" && stored?.t === "plain")
        || (row.encryptionMode === "e2ee" && stored?.t === "encrypted");
    const metadataKind = row.kind === "apiKey" || row.kind === "token" || row.kind === "password" || row.kind === "other"
        ? row.kind : null;
    if (!metadataKind || !stored || !modeMatches) {
        return projectCorruptRow(row, accountId);
    }
    const materialStatus = row.encryptionMode === "e2ee"
        ? encryptedMaterialStatus
        : "ready";
    const projected = SavedSecretCatalogEntryV1Schema.safeParse({
        ref,
        source: "shared_resource",
        relationship: isOwner ? "owner" : "recipient",
        name: row.displayName.trim().length > 0 ? row.displayName : null,
        kind: metadataKind,
        encryptionMode: row.encryptionMode === "plain" || row.encryptionMode === "e2ee"
            ? row.encryptionMode
            : null,
        owner: {
            kind: "account",
            accountId: row.owner.id,
            ...projectAccountDisplayProfileV1(row.owner),
        },
        accessSources: isOwner ? [] : [
            ...(hasDirect ? [{ kind: "account" as const }] : []),
            ...matchingTeams.map((grant) => ({
                kind: "team" as const,
                teamId: grant.team.id,
                name: grant.team.name,
            })),
            ...matchingGroups.map((grant) => ({
                kind: "group" as const,
                teamId: grant.teamGroup.team.id,
                teamName: grant.teamGroup.team.name,
                groupId: grant.teamGroup.id,
                name: grant.teamGroup.name,
            })),
        ],
        audience: isOwner ? {
            accounts: row.accountGrants.map((grant) => ({
                kind: "account" as const,
                accountId: grant.account.id,
                ...projectAccountDisplayProfileV1(grant.account),
            })),
            teams: row.teamGrants.map((grant) => ({ kind: "team" as const, teamId: grant.team.id, name: grant.team.name })),
            groups: row.groupGrants.map((grant) => ({
                kind: "group" as const,
                teamId: grant.teamGroup.team.id,
                teamName: grant.teamGroup.team.name,
                groupId: grant.teamGroup.id,
                name: grant.teamGroup.name,
            })),
        } : null,
        ownerAccountId: row.ownerAccountId,
        revision: row.revision,
        materialStatus,
        capabilities: {
            use: materialStatus === "ready",
            rename: isOwner,
            rotate: isOwner,
            manageAccess: isOwner,
            delete: isOwner,
        },
    });
    return projected.success ? projected.data : projectCorruptRow(row, accountId);
}

/** Lists only resources currently authorized for the Account. */
export async function listSavedSecretResourcesForAccountInTx(
    tx: Tx,
    accountId: string,
    authentication?: TeamOperationAuthenticationContext,
): Promise<readonly SavedSecretCatalogResultV1[]> {
    const [rows, account] = await Promise.all([tx.savedSecretResource.findMany({
        where: authorizedSavedSecretRowWhere(accountId),
        orderBy: { updatedAt: "desc" },
        select: authorizedSavedSecretRowSelect(accountId),
    }), tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    })]);
    const authorized = await retainQualifiedSavedSecretRowsInTx(tx, { rows, accountId, authentication });
    return authorized.rows.flatMap((row) => {
        const projected = projectRow(
            row,
            accountId,
            resolveEncryptedMaterialStatus(account, row.keyEnvelopes[0] ?? null),
            authorized.qualifiedTeamIds,
        );
        return projected ? [projected] : [];
    });
}

export type SavedSecretResourceMaterialProjection = Readonly<{
    resourceId: string;
    entry: SavedSecretCatalogEntryV1;
    encryptionMode: "plain" | "e2ee";
    storedContent: SavedSecretResourceStoredContentV1 | null;
    encryptedDataKey: Uint8Array | null;
    recipientContentPublicKeyFingerprint: string | null;
}> | Readonly<{
    entry: SavedSecretCatalogCorruptEntryV1;
}>;

export type SavedSecretResourceEnvelopeCensusProjection = Readonly<{
    resourceId: string;
    revision: number;
    recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[];
    nextCursor: string | null;
}>;

/** Owner-only effective-recipient census used to prepare/repair current E2EE envelopes. */
export async function listSavedSecretResourceEnvelopeCensusInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; resourceId: string; cursor?: string; limit: number }>,
): Promise<SavedSecretResourceServiceResult<SavedSecretResourceEnvelopeCensusProjection>> {
    const resource = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: { ownerAccountId: true, encryptionMode: true, revision: true },
    });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.ownerAccountId !== input.accountId) return { ok: false, error: "forbidden" };
    if (resource.encryptionMode !== "e2ee") return { ok: false, error: "invalid_resource" };

    const authorizedIds = (await listAuthorizedAccountIdsForResourceInTx(tx, input.resourceId))
        .filter((id) => input.cursor === undefined || id > input.cursor)
        .sort((left, right) => left.localeCompare(right));
    const pageIds = authorizedIds.slice(0, input.limit);
    const accounts = await tx.account.findMany({
        where: { id: { in: pageIds }, status: "active" },
        select: {
            ...ACCOUNT_DISPLAY_PROFILE_SELECT,
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            savedSecretResourceKeyEnvelopes: {
                where: { resourceId: input.resourceId },
                select: { encryptedDataKey: true, recipientContentPublicKeyFingerprint: true },
            },
        },
        orderBy: { id: "asc" },
    });
    const recipients = accounts.map((account): SavedSecretResourceEnvelopeCensusRecipientV1 => {
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
        const envelope = account.savedSecretResourceKeyEnvelopes[0] ?? null;
        const usableEnvelope = readUsableRecipientEnvelope(envelope);
        const envelopeStatus = !envelope
            ? "missing" as const
            : !usableEnvelope
                ? "invalid" as const
                : readiness.status === "available"
                    && readiness.binding.contentPublicKeyFingerprint === usableEnvelope.recipientContentPublicKeyFingerprint
                    ? "prepared" as const
                    : "stale" as const;
        return {
            account: {
                kind: "account",
                accountId: account.id,
                ...projectAccountDisplayProfileV1(account),
            },
            readiness: readiness.status === "available"
                ? {
                    status: "available",
                    contentPublicKey: privacyKit.encodeBase64(readiness.binding.contentPublicKey),
                    contentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
                }
                : readiness,
            envelopeStatus,
        };
    });
    return {
        ok: true,
        value: {
            resourceId: input.resourceId,
            revision: resource.revision,
            recipients,
            nextCursor: authorizedIds.length > input.limit ? pageIds.at(-1) ?? null : null,
        },
    };
}

/** Returns authorized ciphertext/plain storage plus only the caller's envelope. */
export async function listSavedSecretResourceMaterialsForAccountInTx(
    tx: Tx,
    accountId: string,
    authentication?: TeamOperationAuthenticationContext,
): Promise<readonly SavedSecretResourceMaterialProjection[]> {
    const [rows, account] = await Promise.all([tx.savedSecretResource.findMany({
        where: authorizedSavedSecretRowWhere(accountId),
        orderBy: { updatedAt: "desc" },
        select: authorizedSavedSecretRowSelect(accountId),
    }), tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    })]);
    const authorized = await retainQualifiedSavedSecretRowsInTx(tx, { rows, accountId, authentication });
    const projectedRows: SavedSecretResourceMaterialProjection[] = [];
    for (const row of authorized.rows) {
        const envelope = row.keyEnvelopes?.[0] ?? null;
        const entry = projectRow(
            row,
            accountId,
            resolveEncryptedMaterialStatus(account, envelope),
            authorized.qualifiedTeamIds,
        );
        if (!entry) continue;
        if (entry.materialStatus === "resource_corrupt") {
            projectedRows.push({ entry });
            continue;
        }
        const usableEnvelope = readUsableRecipientEnvelope(envelope);
        projectedRows.push({
            resourceId: row.id,
            entry,
            encryptionMode: row.encryptionMode === "plain" ? "plain" : "e2ee",
            storedContent: readStoredContent(row.id, row.storedContent),
            encryptedDataKey: usableEnvelope?.encryptedDataKey ?? null,
            recipientContentPublicKeyFingerprint: usableEnvelope?.recipientContentPublicKeyFingerprint ?? null,
        });
    }
    return projectedRows;
}

export type CreateSavedSecretResourceInput = Readonly<{
    accountId: string;
    authentication?: TeamOperationAuthenticationContext;
    resourceId: string;
    displayName: string;
    kind: "apiKey" | "token" | "password" | "other";
    encryptionMode: "plain" | "e2ee";
    storedContent: SavedSecretResourceStoredContentV1;
    accountGrants?: readonly string[];
    teamGrants?: readonly string[];
    groupGrants?: readonly string[];
    keyEnvelopes?: readonly SavedSecretRecipientEnvelopeInput[];
}>;

/** Creates one owner-controlled resource and its explicit grant tuples. */
export async function createSavedSecretResourceInTx(
    tx: Tx,
    input: CreateSavedSecretResourceInput,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; revision: number }>> {
    try {
        formatSharedSavedSecretRefV1(input.resourceId);
    } catch {
        return { ok: false, error: "invalid_resource" };
    }
    if (!input.resourceId.trim() || !input.displayName.trim()) return { ok: false, error: "invalid_resource" };
    if (input.resourceId.length > 256 || input.displayName.trim().length > 100) return { ok: false, error: "invalid_resource" };
    if (!["apiKey", "token", "password", "other"].includes(input.kind)) return { ok: false, error: "invalid_resource" };
    if (input.encryptionMode === "plain" && input.storedContent.t !== "plain") return { ok: false, error: "invalid_resource" };
    if (input.encryptionMode === "e2ee" && input.storedContent.t !== "encrypted") return { ok: false, error: "invalid_resource" };
    if (input.storedContent.t === "plain"
        && (input.storedContent.v.name !== input.displayName.trim() || input.storedContent.v.kind !== input.kind)) {
        return { ok: false, error: "invalid_resource" };
    }
    const owner = await tx.account.findUnique({ where: { id: input.accountId }, select: { id: true, encryptionMode: true } });
    if (!owner) return { ok: false, error: "resource_not_found" };
    if (input.encryptionMode === "e2ee" && owner.encryptionMode !== "e2ee") return { ok: false, error: "recipient_mode_unsupported" };
    if (input.encryptionMode === "e2ee"
        && !(input.keyEnvelopes ?? []).some((envelope) => envelope.recipientAccountId === input.accountId)) {
        return { ok: false, error: "invalid_resource" };
    }
    if (input.encryptionMode === "plain" && (input.keyEnvelopes?.length ?? 0) > 0) {
        return { ok: false, error: "invalid_resource" };
    }
    const recipients = [...new Set(input.accountGrants ?? [])].filter((accountId) => accountId !== input.accountId);
    const teams = [...new Set(input.teamGrants ?? [])];
    const groups = [...new Set(input.groupGrants ?? [])];
    const requestedEnvelopes = input.keyEnvelopes ?? [];
    const existing = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: {
            ownerAccountId: true,
            revision: true,
            displayName: true,
            kind: true,
            encryptionMode: true,
            storedContent: true,
            accountGrants: { select: { accountId: true } },
            teamGrants: { select: { teamId: true } },
            groupGrants: { select: { teamGroupId: true } },
            keyEnvelopes: {
                select: {
                    recipientAccountId: true,
                    encryptedDataKey: true,
                    recipientContentPublicKeyFingerprint: true,
                },
            },
        },
    });
    if (existing) {
        const existingEnvelopesByRecipient = new Map(existing.keyEnvelopes.map((envelope) => [
            envelope.recipientAccountId,
            envelope,
        ]));
        const isExactRetry = existing.ownerAccountId === input.accountId
            && existing.displayName === input.displayName.trim()
            && existing.kind === input.kind
            && existing.encryptionMode === input.encryptionMode
            && isDeepStrictEqual(readStoredContent(input.resourceId, existing.storedContent), input.storedContent)
            && hasSameStringSet(existing.accountGrants.map((grant) => grant.accountId), recipients)
            && hasSameStringSet(existing.teamGrants.map((grant) => grant.teamId), teams)
            && hasSameStringSet(existing.groupGrants.map((grant) => grant.teamGroupId), groups)
            && existing.keyEnvelopes.length === requestedEnvelopes.length
            && requestedEnvelopes.every((requested) => {
                const persisted = existingEnvelopesByRecipient.get(requested.recipientAccountId);
                return persisted !== undefined
                    && persisted.recipientContentPublicKeyFingerprint === requested.recipientContentPublicKeyFingerprint
                    && isDeepStrictEqual(new Uint8Array(persisted.encryptedDataKey), requested.encryptedDataKey);
            });
        return isExactRetry
            ? { ok: true, value: { resourceId: input.resourceId, revision: existing.revision } }
            : { ok: false, error: "resource_changed" };
    }
    const envelopeRecipients = [...new Set(
        requestedEnvelopes.map((envelope) => envelope.recipientAccountId),
    )];
    if (!await isSavedSecretAudienceEligibleInTx(tx, {
        ownerAccountId: input.accountId,
        accountIds: recipients.filter((accountId) => accountId !== input.accountId),
        teamIds: teams,
        groupIds: groups,
        ...(input.authentication ? { authentication: input.authentication } : {}),
    })) {
        return { ok: false, error: "forbidden" };
    }
    const requestedAccountIds = [...new Set([...recipients, ...envelopeRecipients])];
    const [teamMembers, groupMembers, recipientCount, teamCount, groupCount] = await Promise.all([
        teams.length === 0 ? [] : tx.teamMembership.findMany({
            where: { teamId: { in: teams }, status: "active", account: { status: "active" }, team: { archivedAt: null } },
            select: { accountId: true, role: true },
        }),
        groups.length === 0 ? [] : tx.teamGroupMembership.findMany({
            where: {
                teamGroupId: { in: groups },
                group: { archivedAt: null, team: { archivedAt: null } },
                teamMembership: { status: "active", account: { status: "active" } },
            },
            select: { teamMembership: { select: { accountId: true } } },
        }),
        requestedAccountIds.length === 0 ? 0 : tx.account.count({ where: { id: { in: requestedAccountIds } } }),
        teams.length === 0 ? 0 : tx.team.count({ where: { id: { in: teams }, archivedAt: null } }),
        groups.length === 0 ? 0 : tx.teamGroup.count({ where: { id: { in: groups }, archivedAt: null, team: { archivedAt: null } } }),
    ]);
    const teamRecipientIds = teamMembers
        .filter((member) => isTeamPrincipalRoleV1(member.role))
        .map((member) => member.accountId);
    const recipientIds = [...new Set([
        ...recipients,
        ...teamRecipientIds,
        ...groupMembers.map((member) => member.teamMembership.accountId),
        ...envelopeRecipients,
    ])];
    if (recipientCount !== requestedAccountIds.length || teamCount !== teams.length || groupCount !== groups.length) {
        return { ok: false, error: "invalid_resource" };
    }
    if (input.encryptionMode === "e2ee") {
        const recipientRows = recipientIds.length === 0
            ? []
            : await tx.account.findMany({
                where: { id: { in: recipientIds } },
                select: SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT,
            });
        const authorizedRecipientIds = new Set([input.accountId, ...recipients, ...teamRecipientIds, ...groupMembers.map((member) => member.teamMembership.accountId)]);
        if (envelopeRecipients.some((accountId) => !authorizedRecipientIds.has(accountId))) {
            return { ok: false, error: "invalid_resource" };
        }
        const recipientRowsById = new Map(recipientRows.map((account) => [account.id, account]));
        if (readSavedSecretRecipientEnvelopeRejection(requestedEnvelopes, recipientRowsById) !== null) {
            return { ok: false, error: "invalid_resource" };
        }
    }
    const resource = await tx.savedSecretResource.create({
        data: {
            id: input.resourceId,
            ownerAccountId: input.accountId,
            displayName: input.displayName.trim(),
            kind: input.kind,
            encryptionMode: input.encryptionMode,
            storedContent: storeContent(input.resourceId, input.storedContent),
            accountGrants: recipients.length ? { create: recipients.map((accountId) => ({ accountId, createdByAccountId: input.accountId })) } : undefined,
            teamGrants: teams.length ? { create: teams.map((teamId) => ({ teamId, createdByAccountId: input.accountId })) } : undefined,
            groupGrants: groups.length ? { create: groups.map((teamGroupId) => ({ teamGroupId, createdByAccountId: input.accountId })) } : undefined,
            keyEnvelopes: requestedEnvelopes.length ? {
                createMany: {
                    data: requestedEnvelopes.map((envelope) => ({
                        recipientAccountId: envelope.recipientAccountId,
                        encryptedDataKey: copyBytes(envelope.encryptedDataKey),
                        recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
                    })),
                },
            } : undefined,
        },
        select: { id: true, revision: true },
    });
    await markResourceChangedForAccounts(tx, input.resourceId, resource.revision, [input.accountId, ...recipientIds]);
    return { ok: true, value: { resourceId: resource.id, revision: resource.revision } };
}

export type PromoteSavedSecretResourceInput = CreateSavedSecretResourceInput & Readonly<{
    expectedSettingsVersion?: number;
    nextSettings: AccountSettingsStoredContentEnvelope | null;
    referenceCensus: SavedSecretPromoteReferenceCensusV1;
    profileMutations: readonly ProfileRowMutationV1[];
    catalogMutations?: SavedSecretCatalogMutationsV1;
    additionalSavedSecretResources?: readonly Omit<CreateSavedSecretResourceInput, 'accountId' | 'authentication'>[];
    personalSecretPromotions?: SavedSecretPersonalPromotionsV1;
    remoteHostMutation?: RemoteHostCatalogRowMutationV1;
    notificationChannelMutation?: NotificationChannelCatalogMutationV1;
}>;

export type SetSavedSecretResourceGrantsInput = Readonly<{
    accountId: string;
    authentication?: TeamOperationAuthenticationContext;
    resourceId: string;
    expectedRevision: number;
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    keyEnvelopes?: readonly SavedSecretRecipientEnvelopeInput[];
}>;

export async function setSavedSecretResourceGrantsInTx(
    tx: Tx,
    input: SetSavedSecretResourceGrantsInput,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; revision: number }>> {
    const existing = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: { ownerAccountId: true, revision: true, encryptionMode: true },
    });
    if (!existing) return { ok: false, error: "resource_not_found" };
    if (existing.ownerAccountId !== input.accountId) return { ok: false, error: "forbidden" };
    if (existing.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };

    const accountIds = [...new Set(input.accountGrants)].filter((id) => id !== input.accountId);
    const teamIds = [...new Set(input.teamGrants)];
    const groupIds = [...new Set(input.groupGrants)];
    if (!await isSavedSecretAudienceEligibleInTx(tx, {
        ownerAccountId: input.accountId,
        accountIds,
        teamIds,
        groupIds,
        ...(input.authentication ? { authentication: input.authentication } : {}),
    })) return { ok: false, error: "forbidden" };

    const [before, after] = await Promise.all([
        listAuthorizedAccountIdsForResourceInTx(tx, input.resourceId),
        resolveSavedSecretAudienceAccountIdsInTx(tx, {
            ownerAccountId: input.accountId,
            accountIds,
            teamIds,
            groupIds,
        }),
    ]);
    const envelopes = input.keyEnvelopes ?? [];
    if (existing.encryptionMode === "plain" && envelopes.length > 0) {
        return { ok: false, error: "invalid_resource" };
    }
    if (existing.encryptionMode === "e2ee") {
        const afterSet = new Set(after);
        if (envelopes.some((envelope) => !afterSet.has(envelope.recipientAccountId))) {
            return { ok: false, error: "invalid_resource" };
        }
        const recipientRows = envelopes.length === 0 ? [] : await tx.account.findMany({
            where: { id: { in: envelopes.map((envelope) => envelope.recipientAccountId) } },
            select: SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT,
        });
        const recipientRowsById = new Map(recipientRows.map((account) => [account.id, account]));
        if (readSavedSecretRecipientEnvelopeRejection(envelopes, recipientRowsById) !== null) {
            return { ok: false, error: "invalid_resource" };
        }
    }
    const updated = await tx.savedSecretResource.updateMany({
        where: {
            id: input.resourceId,
            ownerAccountId: input.accountId,
            revision: input.expectedRevision,
        },
        data: { revision: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };

    await Promise.all([
        tx.savedSecretAccountGrant.deleteMany({ where: { resourceId: input.resourceId } }),
        tx.savedSecretTeamGrant.deleteMany({ where: { resourceId: input.resourceId } }),
        tx.savedSecretGroupGrant.deleteMany({ where: { resourceId: input.resourceId } }),
        tx.savedSecretResourceKeyEnvelope.deleteMany({
            where: { resourceId: input.resourceId, recipientAccountId: { notIn: [...after] } },
        }),
    ]);
    if (accountIds.length > 0) await tx.savedSecretAccountGrant.createMany({
        data: accountIds.map((accountId) => ({
            resourceId: input.resourceId,
            accountId,
            createdByAccountId: input.accountId,
        })),
    });
    if (teamIds.length > 0) await tx.savedSecretTeamGrant.createMany({
        data: teamIds.map((teamId) => ({
            resourceId: input.resourceId,
            teamId,
            createdByAccountId: input.accountId,
        })),
    });
    if (groupIds.length > 0) await tx.savedSecretGroupGrant.createMany({
        data: groupIds.map((teamGroupId) => ({
            resourceId: input.resourceId,
            teamGroupId,
            createdByAccountId: input.accountId,
        })),
    });
    await upsertSavedSecretResourceKeyEnvelopesInTx(tx, input.resourceId, envelopes);
    await markResourceChangedForAccounts(
        tx,
        input.resourceId,
        input.expectedRevision + 1,
        [...new Set([...before, ...after])],
    );
    return { ok: true, value: { resourceId: input.resourceId, revision: input.expectedRevision + 1 } };
}

export async function repairSavedSecretResourceKeyEnvelopesInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        expectedRevision: number;
        keyEnvelopes: readonly SavedSecretRecipientEnvelopeInput[];
    }>,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; revision: number }>> {
    const resource = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: { ownerAccountId: true, encryptionMode: true, revision: true },
    });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.ownerAccountId !== input.accountId) return { ok: false, error: "forbidden" };
    if (resource.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };
    if (resource.encryptionMode !== "e2ee" || input.keyEnvelopes.length === 0) {
        return { ok: false, error: "invalid_resource" };
    }
    // Acquire the resource-row write lock without advancing the content/audience
    // revision. Concurrent grant/update/delete transactions serialize here, so
    // the eligibility and key checks below belong to this exact revision.
    const current = await tx.savedSecretResource.updateMany({
        where: {
            id: input.resourceId,
            ownerAccountId: input.accountId,
            revision: input.expectedRevision,
            encryptionMode: "e2ee",
        },
        data: { revision: input.expectedRevision },
    });
    if (current.count !== 1) return { ok: false, error: "resource_changed" };
    const recipientIds = input.keyEnvelopes.map((envelope) => envelope.recipientAccountId);
    const authorizedIds = new Set(await listAuthorizedAccountIdsForResourceInTx(tx, input.resourceId));
    if (recipientIds.some((accountId) => !authorizedIds.has(accountId))) {
        return { ok: false, error: "recipient_changed" };
    }
    const recipients = await tx.account.findMany({
        where: { id: { in: recipientIds }, status: "active" },
        select: SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT,
    });
    const rejection = readSavedSecretRecipientEnvelopeRejection(
        input.keyEnvelopes,
        new Map(recipients.map((recipient) => [recipient.id, recipient])),
    );
    // Repair publishes a recoverable answer where creation only says "invalid":
    // the owner device is expected to re-read the census and reseal.
    if (rejection !== null) {
        return {
            ok: false,
            error: rejection === "key_unavailable" ? "recipient_key_unavailable"
                : rejection === "unknown_recipient" || rejection === "fingerprint_mismatch" ? "recipient_changed"
                    : "invalid_resource",
        };
    }
    await upsertSavedSecretResourceKeyEnvelopesInTx(tx, input.resourceId, input.keyEnvelopes);
    await markResourceChangedForAccounts(tx, input.resourceId, resource.revision, [input.accountId, ...recipientIds]);
    return { ok: true, value: { resourceId: input.resourceId, revision: resource.revision } };
}

export type UpdateSavedSecretResourceInput = Readonly<{
    accountId: string;
    resourceId: string;
    expectedRevision: number;
    displayName: string;
    kind: "apiKey" | "token" | "password" | "other";
    storedContent: SavedSecretResourceStoredContentV1;
    /**
     * Explicit owner mode conversion (plan 10.08 §10.5/§11.0). Absent keeps the
     * current mode, so rename and value rotation are unchanged.
     */
    toMode?: "plain" | "e2ee";
    /** Owner and current-recipient envelopes, only for a Plain to E2EE conversion. */
    keyEnvelopes?: readonly SavedSecretRecipientEnvelopeInput[];
}>;

/**
 * Rewrites the owner's resource content, and — when the owner asks for it —
 * the mode that content is stored in.
 *
 * Rename, value rotation and mode conversion are the same content write under
 * the same revision CAS, so the resource keeps its id, references, grants and
 * audience across a conversion and advances exactly one revision. The mode the
 * write lands in decides which stored container is correct, so a mode/content
 * mismatch stays rejected in every arm.
 */
export async function updateSavedSecretResourceInTx(
    tx: Tx,
    input: UpdateSavedSecretResourceInput,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; revision: number }>> {
    const resource = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: { ownerAccountId: true, encryptionMode: true, revision: true },
    });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.ownerAccountId !== input.accountId) return { ok: false, error: "forbidden" };
    if (resource.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };
    const nextMode = input.toMode ?? resource.encryptionMode;
    if ((nextMode === "plain" && input.storedContent.t !== "plain")
        || (nextMode === "e2ee" && input.storedContent.t !== "encrypted")) {
        return { ok: false, error: "invalid_resource" };
    }
    if (input.storedContent.t === "plain"
        && (input.storedContent.v.name !== input.displayName.trim() || input.storedContent.v.kind !== input.kind)) {
        return { ok: false, error: "invalid_resource" };
    }
    const converting = input.toMode !== undefined && input.toMode !== resource.encryptionMode;
    // A conversion is "subject to Home policy" (plan 10.08 §10.5): the Home's
    // storage policy decides which content mode it admits, with the same
    // decision Session storage applies. Rename and rotation in the existing
    // mode are not a conversion and stay outside it.
    if (converting && input.toMode !== undefined && !isSessionEncryptionModeAllowedByStoragePolicy(
        readEncryptionFeatureEnv(process.env).storagePolicy,
        input.toMode,
    )) {
        return { ok: false, error: "forbidden" };
    }
    const envelopes = input.keyEnvelopes ?? [];
    // Recipient material travels only with a conversion into E2EE. Every other
    // envelope write stays with the census/repair owner, so this write never
    // becomes a second way to reseal a resource.
    if (envelopes.length > 0 && !(converting && nextMode === "e2ee")) {
        return { ok: false, error: "invalid_resource" };
    }
    const authorizedAccountIds = await listAuthorizedAccountIdsForResourceInTx(tx, input.resourceId);
    if (converting && nextMode === "e2ee") {
        const owner = await tx.account.findUnique({
            where: { id: input.accountId },
            select: SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT,
        });
        if (!owner) return { ok: false, error: "resource_not_found" };
        if (owner.encryptionMode !== "e2ee") return { ok: false, error: "recipient_mode_unsupported" };
        // The owner must keep its own access, exactly as at creation; the
        // remaining recipients are prepared by the existing census/repair pass.
        if (!envelopes.some((envelope) => envelope.recipientAccountId === input.accountId)) {
            return { ok: false, error: "invalid_resource" };
        }
        const authorized = new Set(authorizedAccountIds);
        if (envelopes.some((envelope) => !authorized.has(envelope.recipientAccountId))) {
            return { ok: false, error: "invalid_resource" };
        }
        const recipientRows = await tx.account.findMany({
            where: { id: { in: envelopes.map((envelope) => envelope.recipientAccountId) } },
            select: SAVED_SECRET_RECIPIENT_ACCOUNT_SELECT,
        });
        const recipientRowsById = new Map(recipientRows.map((account) => [account.id, account]));
        if (readSavedSecretRecipientEnvelopeRejection(envelopes, recipientRowsById) !== null) {
            return { ok: false, error: "invalid_resource" };
        }
    }
    const updated = await tx.savedSecretResource.updateMany({
        where: { id: input.resourceId, ownerAccountId: input.accountId, revision: input.expectedRevision },
        data: {
            displayName: input.displayName.trim(),
            kind: input.kind,
            storedContent: storeContent(input.resourceId, input.storedContent),
            ...(converting ? { encryptionMode: nextMode } : {}),
            revision: { increment: 1 },
        },
    });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    if (converting) {
        // Envelopes belong to the mode the resource is now in: a Plain resource
        // keeps none, and a converted E2EE one keeps exactly what this write
        // sealed. Grants, audience and the resource id are untouched.
        await tx.savedSecretResourceKeyEnvelope.deleteMany({
            where: {
                resourceId: input.resourceId,
                ...(envelopes.length > 0
                    ? { recipientAccountId: { notIn: envelopes.map((envelope) => envelope.recipientAccountId) } }
                    : {}),
            },
        });
        await upsertSavedSecretResourceKeyEnvelopesInTx(tx, input.resourceId, envelopes);
    }
    await markResourceChangedForAccounts(tx, input.resourceId, input.expectedRevision + 1, authorizedAccountIds);
    return { ok: true, value: { resourceId: input.resourceId, revision: input.expectedRevision + 1 } };
}

type SavedSecretCatalogReferenceFacets = Pick<SavedSecretReferenceCatalogsV1,
    'mcp' | 'acp' | 'providerConnections' | 'connectedConfigurations' | 'connectedPurposes'>;
type SavedSecretCatalogCapturedContents = Partial<Record<keyof SavedSecretCatalogRevisionsV1,
    Readonly<{ revision: number | 'absent'; content: unknown | null }>>>;

function savedSecretCatalogCaptureError(row: Readonly<{ status: string; revision?: number }>, capture: number | 'absent' | undefined) {
    if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') return 'references_invalid' as const;
    const revision = row.status === 'absent' ? 'absent' : row.revision;
    return revision === (capture ?? 'absent') ? null : 'references_conflict' as const;
}

/**
 * Closed domain arms reuse their complete stored-envelope owners before census admission.
 * E2EE payload inventory stays client-declared; visible envelope carriers cannot be skipped.
 */
async function readSavedSecretCatalogCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; accountMode: 'plain' | 'e2ee'; captures?: Partial<SavedSecretCatalogRevisionsV1>; destinationOnly?: boolean;
}>): Promise<SavedSecretResourceServiceResult<{
    catalogs: SavedSecretCatalogReferenceFacets; contents: SavedSecretCatalogCapturedContents;
}>> {
    const catalogs: { -readonly [K in keyof SavedSecretCatalogReferenceFacets]: SavedSecretCatalogReferenceFacets[K] } = {};
    const contents: SavedSecretCatalogCapturedContents = {};
    if (!input.destinationOnly || input.captures?.mcp !== undefined) {
        const { readMcpServerCatalogRowInTx } = await import('@/app/account/mcp/serverRows');
        const row = await readMcpServerCatalogRowInTx(tx, input);
        const error = savedSecretCatalogCaptureError(row, input.captures?.mcp);
        if (error) return { ok: false, error };
        if (row.status === 'present') {
            if (!parseMcpServerCatalogMigrationContentV1(row.content)) return { ok: false, error: 'references_invalid' };
            contents.mcp = { revision: row.revision, content: row.content };
            if (input.accountMode === 'plain') {
                const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: row.content });
                if (opened.status !== 'opened') return { ok: false, error: 'references_invalid' };
                catalogs.mcp = opened.catalog;
            }
        } else if (row.status === 'deleted') { catalogs.mcp = null; contents.mcp = { revision: row.revision, content: null }; }
        else contents.mcp = { revision: 'absent', content: null };
    }
    if (!input.destinationOnly || input.captures?.acp !== undefined) {
        const { readConfiguredAgentCatalogRowInTx } = await import('@/app/account/agents/configuredAgentRows');
        const row = await readConfiguredAgentCatalogRowInTx(tx, input);
        const error = savedSecretCatalogCaptureError(row, input.captures?.acp);
        if (error) return { ok: false, error };
        if (row.status === 'present') {
            if (listAcpCatalogEnvelopeSavedSecretDiagnosticsV1(row.content).length > 0) return { ok: false, error: 'references_invalid' };
            contents.acp = { revision: row.revision, content: row.content };
            if (input.accountMode === 'plain') {
                const opened = openAcpCatalogContentV1({ mode: 'plain', material: null, content: row.content });
                if (opened.status !== 'opened') return { ok: false, error: 'references_invalid' };
                catalogs.acp = opened.record;
            }
        } else if (row.status === 'deleted') { catalogs.acp = null; contents.acp = { revision: row.revision, content: null }; }
        else contents.acp = { revision: 'absent', content: null };
    }
    if (!input.destinationOnly || input.captures?.providerConnections !== undefined) {
        const { readProviderConnectionsRowInTx } = await import('@/app/account/providers/connectionRows');
        const row = await readProviderConnectionsRowInTx(tx, input);
        const error = savedSecretCatalogCaptureError(row, input.captures?.providerConnections);
        if (error) return { ok: false, error };
        if (row.status === 'present') {
            if (!parseProviderConnectionsMigrationContentV1(row.content)) return { ok: false, error: 'references_invalid' };
            contents.providerConnections = { revision: row.revision, content: row.content };
            if (input.accountMode === 'plain') {
                const opened = openProviderConnectionsContentV1({ mode: 'plain', material: null, content: row.content });
                if (opened.status !== 'opened') return { ok: false, error: 'references_invalid' };
                catalogs.providerConnections = opened.catalog;
            }
        } else if (row.status === 'deleted') { catalogs.providerConnections = null; contents.providerConnections = { revision: row.revision, content: null }; }
        else contents.providerConnections = { revision: 'absent', content: null };
    }
    if (!input.destinationOnly || input.captures?.connectedConfigurations !== undefined) {
        const { readConnectedAccountCatalogRowInTx } = await import('@/app/account/connectedAccounts/configurationRows');
        const row = await readConnectedAccountCatalogRowInTx(tx, { accountId: input.accountId, key: 'configurations' });
        const error = savedSecretCatalogCaptureError(row, input.captures?.connectedConfigurations);
        if (error) return { ok: false, error };
        if (row.status === 'present') {
            if (!parseConnectedAccountCatalogMigrationContentV1(row.content, 'configurations')) return { ok: false, error: 'references_invalid' };
            contents.connectedConfigurations = { revision: row.revision, content: row.content };
            if (input.accountMode === 'plain') {
                const opened = openConnectedAccountCatalogContentV1({ key: 'configurations', mode: 'plain', material: null, content: row.content });
                if (opened.status !== 'opened' || opened.record.key !== 'configurations') return { ok: false, error: 'references_invalid' };
                catalogs.connectedConfigurations = opened.record.value;
            }
        } else if (row.status === 'deleted') { catalogs.connectedConfigurations = null; contents.connectedConfigurations = { revision: row.revision, content: null }; }
        else contents.connectedConfigurations = { revision: 'absent', content: null };
    }
    if (!input.destinationOnly || input.captures?.connectedPurposes !== undefined) {
        const { readConnectedAccountCatalogRowInTx } = await import('@/app/account/connectedAccounts/configurationRows');
        const row = await readConnectedAccountCatalogRowInTx(tx, { accountId: input.accountId, key: 'purposes' });
        const error = savedSecretCatalogCaptureError(row, input.captures?.connectedPurposes);
        if (error) return { ok: false, error };
        if (row.status === 'present') {
            if (!parseConnectedAccountCatalogMigrationContentV1(row.content, 'purposes')) return { ok: false, error: 'references_invalid' };
            contents.connectedPurposes = { revision: row.revision, content: row.content };
            if (input.accountMode === 'plain') {
                const opened = openConnectedAccountCatalogContentV1({ key: 'purposes', mode: 'plain', material: null, content: row.content });
                if (opened.status !== 'opened' || opened.record.key !== 'purposes') return { ok: false, error: 'references_invalid' };
                catalogs.connectedPurposes = opened.record.value;
            }
        } else if (row.status === 'deleted') { catalogs.connectedPurposes = null; contents.connectedPurposes = { revision: row.revision, content: null }; }
        else contents.connectedPurposes = { revision: 'absent', content: null };
    }
    return { ok: true, value: { catalogs, contents } };
}

/** The Account fence serializes Settings, Profile CRUD and this resource write. */
export async function readSavedSecretReferenceCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; expectedSettingsVersion: number; referenceCensus: SavedSecretReferenceCensusV1;
}>): Promise<SavedSecretResourceServiceResult<{
    rows: readonly ProfileRowV1[]; settingsContent: AccountSettingsStoredContentEnvelope | null;
    profileControl: ProfileTransferControlV1 | null;
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
    catalogs: SavedSecretCatalogReferenceFacets;
    catalogContents: SavedSecretCatalogCapturedContents;
    remoteHostRecords?: SavedSecretReferenceCatalogsV1['remoteHostRecords'];
    remoteHostResourceRefs: readonly string[];
    notificationChannelResourceRefs: readonly string[];
}>> {
    const parsed = SavedSecretReferenceCensusV1Schema.safeParse(input.referenceCensus);
    if (!parsed.success) return { ok: false, error: 'references_invalid' };
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status !== 'ready') return { ok: false, error: 'settings_invalid' };
    if (fence.account.currentness.encryptionMode !== parsed.data.accountMode) return { ok: false, error: 'references_conflict' };
    if (fence.account.settingsVersion !== input.expectedSettingsVersion) return { ok: false, error: 'settings_conflict' };
    const catalogs = await readSavedSecretCatalogCensusInTx(tx, { accountId: input.accountId,
        accountMode: parsed.data.accountMode, captures: parsed.data.catalogs });
    if (!catalogs.ok) return catalogs;
    const remoteHosts = await validateRemoteHostReferenceCensusInTx(tx, { accountId: input.accountId, capture: parsed.data.remoteHosts });
    if (remoteHosts.status !== 'ready') return { ok: false, error: remoteHosts.status === 'references-conflict' ? 'references_conflict' : 'references_invalid' };
    const notificationChannels = await validateNotificationChannelReferenceCensusInTx(tx, { accountId: input.accountId, capture: parsed.data.notificationChannels });
    if (notificationChannels.status !== 'ready') return { ok: false, error: notificationChannels.status === 'references-conflict' ? 'references_conflict' : 'references_invalid' };
    const control = await readProfileTransferControlInTx(tx, { accountId: input.accountId });
    if (control.status !== 'present' && control.status !== 'deleted' && control.status !== 'absent') {
        return { ok: false, error: 'references_invalid' };
    }
    if ((control.status === 'absent' ? 'absent' : control.revision) !== (parsed.data.profileTransferRevision ?? 'absent')) {
        return { ok: false, error: 'references_conflict' };
    }
    const profiles = await validateProfileReferenceCensusInTx(tx, { accountId: input.accountId,
        referenceGuardRevision: parsed.data.profiles.referenceGuardRevision, rows: parsed.data.profiles.rows,
        expectedAccountMode: parsed.data.accountMode });
    if (profiles.status !== 'ready') return { ok: false,
        error: profiles.status === 'reference-conflict' ? 'references_conflict' : 'references_invalid' };
    try {
        const settingsContent = parsed.data.accountMode === 'plain'
            ? openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings })
            : fence.account.settings ? { t: 'encrypted' as const, c: fence.account.settings } : null;
        const profileControl = control.status === 'present' && control.envelope.t === 'plain' ? control.envelope.v : null;
        const capturedArtifacts = new Map((parsed.data.artifacts ?? []).map(artifact => [artifact.artifactId, artifact]));
        const reachedArtifacts = new Set<string>();
        let artifactFailure: 'references_conflict' | 'references_invalid' | null = null;
        const readCapturedArtifact = async (artifactId: string): Promise<ArtifactSharingResourceV1 | null> => {
            reachedArtifacts.add(artifactId);
            const captured = capturedArtifacts.get(artifactId);
            if (!captured) { artifactFailure = 'references_conflict'; return null; }
            const current = await readArtifactForCallerInTx(tx, { actorAccountId: input.accountId, artifactId });
            if (!current.ok || current.artifact.headerVersion !== captured.headerVersion
                || current.artifact.bodyVersion !== captured.bodyVersion) {
                artifactFailure = 'references_conflict'; return null;
            }
            if (current.artifact.encryptionMode !== 'plain') {
                // The admitted E2EE client opens its captured Artifact. The
                // server checks only its real access and exact revisions.
                if (parsed.data.accountMode === 'plain') artifactFailure = 'references_invalid';
                return null;
            }
            const resource = projectPlainArtifactSharingResourceV1(current.artifact);
            if (!resource || !readLaunchProfileArtifactForReferenceCensusV1(resource)) { artifactFailure = 'references_invalid'; return null; }
            return resource;
        };
        let artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
        if (parsed.data.accountMode === 'plain') {
            const raw = settingsContent?.t === 'plain' ? settingsContent.v : {};
            const source = profileControl && resolveProfileCatalogAuthorityV1({ rawSettings: raw, control: profileControl }) === 'destination'
                ? removeTransferredProfileSourcesV1(raw, listTransferredProfileIdsV1(profileControl)) : raw;
            artifactsById = await loadAiLaunchProfileArtifacts([
                ...profiles.rows.flatMap(row => row.content?.t === 'plain' ? [row.content.v] : []),
                ...(Array.isArray(source.profiles) ? source.profiles : []),
            ], { read: readCapturedArtifact });
            if (reachedArtifacts.size !== capturedArtifacts.size) return { ok: false, error: 'references_conflict' };
        } else {
            const opened = new Map<string, ArtifactSharingResourceV1>();
            for (const artifactId of capturedArtifacts.keys()) {
                const resource = await readCapturedArtifact(artifactId);
                if (resource) opened.set(artifactId, resource);
            }
            artifactsById = opened;
        }
        if (artifactFailure) return { ok: false, error: artifactFailure };
        return { ok: true, value: { rows: profiles.rows, settingsContent, profileControl, artifactsById,
            catalogs: catalogs.value.catalogs, catalogContents: catalogs.value.contents,
            remoteHostRecords: remoteHosts.remoteHostRecords, remoteHostResourceRefs: remoteHosts.resourceRefs,
            notificationChannelResourceRefs: notificationChannels.resourceRefs } };
    } catch {
        return { ok: false, error: 'settings_invalid' };
    }
}

/**
 * History's caller holds its current Account/Settings/control fences. This
 * read-only proof admits only a characterized source identity's real, usable,
 * owner-controlled destination at the captured revision; it never opens E2EE.
 */
async function readSavedSecretHistoryResourceValueInTx(tx: Tx, input: Readonly<{
    resourceId: string; expectedRevision: number;
}>): Promise<string | null> {
    const row = await tx.savedSecretResource.findUnique({ where: { id: input.resourceId },
        select: { revision: true, encryptionMode: true, storedContent: true } });
    if (!row || row.revision !== input.expectedRevision || row.encryptionMode !== 'plain') return null;
    const content = readStoredContent(input.resourceId, row.storedContent);
    return content?.t === 'plain' ? content.v.value : null;
}

export async function validateSavedSecretHistoryTransferProofsInTx(tx: Tx, input: Readonly<{
    accountId: string; transfers: readonly AccountSettingsHistorySavedSecretTransferV1[];
    recordedContent?: AccountSettingsStoredContentEnvelope | null;
}>): Promise<Readonly<{ status: 'ready' | 'conflict' | 'invalid' }>> {
    const sourceIds = new Set<string>();
    for (const transfer of input.transfers) {
        const parsed = AccountSettingsHistorySavedSecretTransferV1Schema.safeParse(transfer);
        if (!parsed.success) return { status: 'invalid' };
        try {
            const source = 'savedSecretId' in parsed.data
                ? { kind: 'personal-saved-secret' as const, secretId: parsed.data.savedSecretId } : parsed.data.source;
            const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: input.accountId, source });
            if (sourceIds.has(resourceId) || resourceId !== transfer.resourceId) return { status: 'invalid' };
            sourceIds.add(resourceId);
        } catch {
            return { status: 'invalid' };
        }
    }
    if (input.transfers.length === 0) return { status: 'ready' };
    const resources = await listSavedSecretResourcesForAccountInTx(tx, input.accountId);
    for (const transfer of input.transfers) {
        const ref = formatSharedSavedSecretRefV1(transfer.resourceId);
        const resource = resources.find(candidate => 'ref' in candidate && candidate.ref === ref);
        if (!resource || !('ref' in resource)) return { status: 'conflict' };
        if (resource.relationship !== 'owner' || !resource.capabilities.use) return { status: 'invalid' };
        if (resource.revision !== transfer.expectedRevision) return { status: 'conflict' };
        if ('source' in transfer && transfer.source.kind === 'remote-host-ssh-credential' && input.recordedContent == null)
            return { status: 'invalid' };
        if ('source' in transfer && transfer.source.kind === 'remote-host-ssh-credential' && input.recordedContent?.t === 'plain') {
            const raw = input.recordedContent.v.remoteHostsV1;
            if (!isCompleteRetainedRemoteHostCatalogV1(raw)) return { status: 'invalid' };
            const inventory = readRetainedRemoteHostCatalogV1(raw);
            const source = transfer.source;
            const host = inventory.status === 'ready' ? inventory.hosts.find(host => host.id === source.hostId) : null;
            const secret = host?.ssh[source.slot === 'password' ? 'passwordEnc' : 'identityPrivateKeyEnc'];
            if (secret == null) return { status: 'invalid' };
            // Opaque nested E2EE material retains the existing exact client proof boundary.
            const value = decryptSecretValueWithKeysV1(secret, []);
            if (value !== null && resource.encryptionMode === 'plain'
                && await readSavedSecretHistoryResourceValueInTx(tx, transfer) !== value) return { status: 'invalid' };
        }
        if ('source' in transfer && transfer.source.kind === 'notification-channel-signing-secret' && input.recordedContent?.t === 'plain') {
            if (!isCompleteLegacyNotificationChannelSourceV1(input.recordedContent.v)) return { status: 'invalid' };
            const inventory = readLegacyNotificationChannelInventoryV1(input.recordedContent.v);
            const source = transfer.source;
            const channel = inventory.status === 'ready' ? inventory.channels.find(channel => channel.id === source.channelId) : null;
            if (channel?.kind !== 'webhook' || channel.signingSecret == null) return { status: 'invalid' };
            const value = decryptSecretValueWithKeysV1(channel.signingSecret, []);
            if (value !== null && resource.encryptionMode === 'plain'
                && await readSavedSecretHistoryResourceValueInTx(tx, transfer) !== value) return { status: 'invalid' };
        }
    }
    return { status: 'ready' };
}

export async function deleteSavedSecretResourceInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; resourceId: string; expectedRevision: number;
        expectedSettingsVersion: number; referenceCensus: SavedSecretReferenceCensusV1;
        managedResourceDispositions?: readonly ManagedResourceDispositionV1[] }>,
): Promise<SavedSecretResourceDeleteResult> {
    const existing = await tx.savedSecretResource.findUnique({
        where: { id: input.resourceId },
        select: { ownerAccountId: true, revision: true },
    });
    if (!existing) return { ok: false, error: "resource_not_found" };
    if (existing.ownerAccountId !== input.accountId) return { ok: false, error: "forbidden" };
    if (existing.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };
    const resources = await readManagedResourceDependenciesInTx(tx, { kind: "saved-secret", resourceId: input.resourceId });
    if (!acceptsManagedResourceDispositions(resources, input.managedResourceDispositions)) {
        return { ok: false, error: "managed_resources_review_required", resources };
    }
    const census = await readSavedSecretReferenceCensusInTx(tx, input);
    if (!census.ok) return census;
    const referenceCandidate = `${SHARED_SAVED_SECRET_REF_V1_PREFIX}${input.resourceId}`;
    if (census.value.notificationChannelResourceRefs.includes(referenceCandidate)) return { ok: false, error: 'resource_in_use' };
    const presets = await tx.managedMachinePreset.findMany({ select: { environment: true } });
    if (presets.some(preset => listSavedSecretReferenceCarrierPathsV1(preset.environment, { secretId: referenceCandidate }).length > 0)
        || census.value.remoteHostResourceRefs.includes(referenceCandidate)) return { ok: false, error: 'resource_in_use' };
    // Plain references are derived from the real stored payload, never the
    // caller's projection. E2EE is opened and classified by the captured client.
    if (input.referenceCensus.accountMode === 'plain') {
        try {
            const settings = census.value.settingsContent?.t === 'plain' ? census.value.settingsContent.v : {};
            const profileRecords = census.value.rows.flatMap(row => row.content?.t === 'plain' ? [row.content.v] : []);
            // Recovery can target a retained invalid opaque identity. This is
            // a conservative reference search, not a producer of valid refs.
            if (listAccountSettingsSavedSecretReferences(settings, referenceCandidate, { ...census.value.catalogs, profileRecords,
                profileControl: census.value.profileControl, artifactsById: census.value.artifactsById,
                remoteHostRecords: census.value.remoteHostRecords }).length > 0) {
                return { ok: false, error: 'resource_in_use' };
            }
        } catch {
            return { ok: false, error: 'references_invalid' };
        }
    }
    const guard = await advanceProfileReferenceGuardInTx(tx, { accountId: input.accountId,
        expectedRevision: input.referenceCensus.profiles.referenceGuardRevision });
    if (guard.status !== 'updated') return { ok: false, error: guard.status === 'conflict' ? 'references_conflict' : 'references_invalid' };
    const authorizedAccountIds = await listAuthorizedAccountIdsForResourceInTx(tx, input.resourceId);
    const deleted = await tx.savedSecretResource.deleteMany({
        where: { id: input.resourceId, ownerAccountId: input.accountId, revision: input.expectedRevision },
    });
    if (deleted.count !== 1) throw new SavedSecretResourceTransactionAbort('resource_changed');
    await markResourceChangedForAccounts(tx, input.resourceId, input.expectedRevision + 1, authorizedAccountIds);
    return { ok: true, value: { resourceId: input.resourceId } };
}

const savedSecretCatalogMutationKeys = ['mcp', 'acp', 'providerConnections', 'connectedConfigurations', 'connectedPurposes'] as const;

function rejectSavedSecretCatalogMutation(result: Readonly<{ status: string }>): void {
    if (result.status !== 'updated') throw new SavedSecretResourceTransactionAbort(result.status === 'conflict'
        ? 'references_conflict' : result.status === 'settings-conflict' ? 'settings_conflict' : 'references_invalid');
}

/** The domain transaction remains the only catalog writer and resource-reference classifier. */
async function mutateSavedSecretCatalogsInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication?: TeamOperationAuthenticationContext; mutations: SavedSecretCatalogMutationsV1;
    savedSecretRefs?: ReadonlyMap<string, string>;
}>): Promise<void> {
    const actor = { accountId: input.accountId, authentication: input.authentication };
    if (input.mutations.mcp) {
        const { mutateMcpServerCatalogRowInTx } = await import('@/app/account/mcp/serverRows');
        rejectSavedSecretCatalogMutation(await mutateMcpServerCatalogRowInTx(tx, { ...actor, ...input.mutations.mcp }));
    }
    if (input.mutations.acp) {
        const { mutateConfiguredAgentCatalogRowInTx, transferConfiguredAgentCatalogSourceInTx } = await import('@/app/account/agents/configuredAgentRows');
        const mutation = input.mutations.acp;
        if (mutation.expectedRevision === 'absent' && mutation.source && mutation.sourceSettingsVersion !== undefined) {
            rejectSavedSecretCatalogMutation(await transferConfiguredAgentCatalogSourceInTx(tx, { ...actor,
                mutation: { ...mutation, expectedRevision: 'absent', source: mutation.source, sourceSettingsVersion: mutation.sourceSettingsVersion },
                savedSecretRefs: input.savedSecretRefs }));
        } else rejectSavedSecretCatalogMutation(await mutateConfiguredAgentCatalogRowInTx(tx, { ...actor, ...mutation }));
    }
    if (input.mutations.providerConnections) {
        const { mutateProviderConnectionsRowInTx } = await import('@/app/account/providers/connectionRows');
        rejectSavedSecretCatalogMutation(await mutateProviderConnectionsRowInTx(tx, { ...actor, ...input.mutations.providerConnections }));
    }
    if (input.mutations.connectedConfigurations) {
        const { mutateConnectedAccountCatalogRowInTx } = await import('@/app/account/connectedAccounts/configurationRows');
        rejectSavedSecretCatalogMutation(await mutateConnectedAccountCatalogRowInTx(tx,
            { ...actor, key: 'configurations', ...input.mutations.connectedConfigurations }));
    }
    if (input.mutations.connectedPurposes) {
        const { mutateConnectedAccountCatalogRowInTx } = await import('@/app/account/connectedAccounts/configurationRows');
        rejectSavedSecretCatalogMutation(await mutateConnectedAccountCatalogRowInTx(tx,
            { ...actor, key: 'purposes', ...input.mutations.connectedPurposes }));
    }
}

function savedSecretPromotionResources(input: PromoteSavedSecretResourceInput): readonly CreateSavedSecretResourceInput[] {
    return [input, ...(input.additionalSavedSecretResources ?? []).map(resource => ({ ...resource,
        accountId: input.accountId, authentication: input.authentication }))];
}

async function validateNotificationPromotionReferencesInTx(tx: Tx, input: PromoteSavedSecretResourceInput,
    mutation: NotificationChannelCatalogMutationV1): Promise<boolean> {
    return validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
        references: mutation.savedSecretRevisions.map(capture => capture.resourceRef),
        savedSecretRevisions: mutation.savedSecretRevisions.map(capture => {
            const parsed = parseSavedSecretRefV1(capture.resourceRef);
            if (parsed.kind !== 'shared_resource') throw new Error('Non-resource notification reference');
            return { resourceId: parsed.resourceId, expectedRevision: capture.revision };
        }) });
}

async function validatePersonalPromotionSourcesInTx(tx: Tx, input: PromoteSavedSecretResourceInput, removesSettingsSources = false): Promise<boolean> {
    if (!input.personalSecretPromotions?.length && !removesSettingsSources) return true;
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status !== 'ready') return false;
    // Encrypted Settings remain the admitted client's captured source declaration.
    const settings = fence.account.currentness.encryptionMode === 'plain'
        ? openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings }) : null;
    const secrets = settings?.t === 'plain' && Array.isArray(settings.v.secrets) ? settings.v.secrets : [];
    const mapped = new Set(input.personalSecretPromotions?.map(promotion => promotion.personalSecretId) ?? []);
    if (settings?.t === 'plain' && [...mapped].some(id => !secrets.some(secret => secret !== null && typeof secret === 'object'
        && !Array.isArray(secret) && 'id' in secret && secret.id === id))) return false;
    const nextSecrets = input.nextSettings?.t === 'plain' && Array.isArray(input.nextSettings.v.secrets) ? input.nextSettings.v.secrets : [];
    const removed = removesSettingsSources ? secrets.flatMap(secret => secret !== null && typeof secret === 'object' && !Array.isArray(secret)
        && 'id' in secret && typeof secret.id === 'string' && !mapped.has(secret.id)
        && !nextSecrets.some(next => next !== null && typeof next === 'object' && !Array.isArray(next) && 'id' in next && next.id === secret.id)
        ? [secret.id] : []) : [];
    if (mapped.size === 0 && removed.length === 0) return true;
    const controllers = await tx.machine.findMany({ where: { accountId: input.accountId }, select: { id: true } });
    const presets = await tx.managedMachinePreset.findMany({ where: { controllerMachineId: { in: controllers.map(machine => machine.id) } }, select: { environment: true } });
    const machines = await tx.managedMachine.findMany({ where: { custodianAccountId: input.accountId }, select: { environmentSetup: true } });
    const snapshots = machines.map(machine => machine.environmentSetup);
    const carriers = [...presets.map(preset => preset.environment), ...snapshots];
    if (removed.some(secretId => carriers.some(value => listSavedSecretReferenceCarrierPathsV1(value, { secretId }).length > 0))) return false;
    const snapshotEnvironments = snapshots.map(setup => setup !== null && typeof setup === 'object' && !Array.isArray(setup) ? setup.environment ?? null : null);
    if (snapshots.some((setup, index) => [...mapped].some(secretId =>
        listSavedSecretReferenceCarrierPathsV1(setup, { secretId }).length !== listSavedSecretReferenceCarrierPathsV1(snapshotEnvironments[index], { secretId }).length))) return false;
    const environments = [...presets.map(preset => preset.environment), ...snapshotEnvironments];
    return environments.every(value => isPromotedMachineEnvironmentRewritable(value, [...mapped]));
}

async function createSavedSecretPromotionResourcesInTx(tx: Tx, input: PromoteSavedSecretResourceInput): Promise<void> {
    const promoted = new Map<string, Readonly<{ ref: string; revision: number }>>();
    for (const resource of savedSecretPromotionResources(input)) {
        const result = await createSavedSecretResourceInTx(tx, resource);
        if (!result.ok) throw new SavedSecretResourceTransactionAbort(result.error);
        if (result.value.revision !== 1) throw new SavedSecretResourceTransactionAbort('resource_changed');
        const source = input.personalSecretPromotions?.find(promotion => promotion.resourceId === result.value.resourceId);
        if (source) promoted.set(source.personalSecretId, { ref: formatSharedSavedSecretRefV1(result.value.resourceId), revision: result.value.revision });
    }
    await rewritePromotedMachineReferencesInTx(tx, input.accountId, promoted);
}

/** A lost-response receipt can inspect existing resources, never create while proving a prior commit. */
async function proveSavedSecretPromotionResourcesInTx(tx: Tx, input: PromoteSavedSecretResourceInput): Promise<SavedSecretResourceServiceResult<null>> {
    const resources = savedSecretPromotionResources(input);
    const existing = await tx.savedSecretResource.count({ where: { id: { in: resources.map(resource => resource.resourceId) } } });
    if (existing !== resources.length) return { ok: false, error: 'references_conflict' };
    for (const resource of resources) {
        // All identities already exist: this canonical exact-retry branch is
        // read-only, so a refusal can safely return without rolling back writes.
        const result = await createSavedSecretResourceInTx(tx, resource);
        if (!result.ok) return result;
        if (result.value.revision !== 1) return { ok: false, error: 'resource_changed' };
    }
    return { ok: true, value: null };
}

async function promoteCatalogOnlySavedSecretResourcesInTx(tx: Tx, input: PromoteSavedSecretResourceInput,
    census: Extract<SavedSecretPromoteReferenceCensusV1, { scope: 'catalogs' }>, mutations: SavedSecretCatalogMutationsV1,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; settingsVersion: number; remoteHostRevision?: number; notificationChannelRevision?: number; catalogRevisions?: Partial<SavedSecretCatalogRevisionsV1> }>> {
    if (input.nextSettings !== null || input.profileMutations.length !== 0) return { ok: false, error: 'references_invalid' };
    let count = 0;
    const postCaptures: Partial<SavedSecretCatalogRevisionsV1> = {};
    const declaredReferences = new Set<string>();
    for (const key of savedSecretCatalogMutationKeys) {
        const mutation = mutations[key];
        const capture = census.catalogs[key];
        if (!mutation) {
            if (capture !== undefined) return { ok: false, error: 'references_invalid' };
            continue;
        }
        count += 1;
        if (typeof capture !== 'number' || mutation.expectedRevision !== capture || mutation.sourceSettingsVersion !== undefined
            || 'source' in mutation && mutation.source !== undefined) return { ok: false, error: 'references_invalid' };
        postCaptures[key] = capture + 1;
        mutation.referencedSavedSecretIds.forEach(reference => declaredReferences.add(reference));
    }
    const remote = input.remoteHostMutation;
    if (remote) {
        if (census.remoteHosts?.revision !== remote.expectedRevision) return { ok: false, error: 'references_invalid' };
        count += 1;
        remote.referencedSavedSecretRevisions.forEach(capture => declaredReferences.add(formatSharedSavedSecretRefV1(capture.resourceId)));
    } else if (census.remoteHosts !== undefined) return { ok: false, error: 'references_invalid' };
    const notification = input.notificationChannelMutation;
    if (notification) {
        if (typeof notification.expectedRevision !== 'number' || notification.sourceSettingsVersion !== undefined
            || notification.settingsMutation !== undefined || census.notificationChannels?.revision !== notification.expectedRevision)
            return { ok: false, error: 'references_invalid' };
        count += 1;
        notification.savedSecretRevisions.forEach(capture => declaredReferences.add(capture.resourceRef));
    } else if (census.notificationChannels !== undefined) return { ok: false, error: 'references_invalid' };
    if (count === 0) return { ok: false, error: 'references_invalid' };
    const receiptValue = (settingsVersion: number) => ({ resourceId: input.resourceId, settingsVersion,
        ...(Object.keys(postCaptures).length ? { catalogRevisions: postCaptures } : {}),
        ...(remote ? { remoteHostRevision: typeof remote.expectedRevision === 'number' ? remote.expectedRevision + 1 : 0 } : {}),
        ...(notification ? { notificationChannelRevision: typeof notification.expectedRevision === 'number' ? notification.expectedRevision + 1 : 0 } : {}) });
    const resources = savedSecretPromotionResources(input);
    if (new Set(resources.map(resource => resource.resourceId)).size !== resources.length) return { ok: false, error: 'references_invalid' };
    let resourcesBound: boolean;
    try { resourcesBound = resources.every(resource => declaredReferences.has(formatSharedSavedSecretRefV1(resource.resourceId))); }
    catch { return { ok: false, error: 'invalid_resource' }; }
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status !== 'ready') return { ok: false, error: 'settings_invalid' };
    if (fence.account.currentness.encryptionMode !== census.accountMode) return { ok: false, error: 'references_conflict' };
    let current = await readSavedSecretCatalogCensusInTx(tx, { accountId: input.accountId, accountMode: census.accountMode,
        captures: census.catalogs, destinationOnly: true });
    if (remote) {
        const hostCensus = await validateRemoteHostReferenceCensusInTx(tx, { accountId: input.accountId, capture: census.remoteHosts });
        if (hostCensus.status !== 'ready') current = { ok: false, error: hostCensus.status === 'references-conflict' ? 'references_conflict' : 'references_invalid' };
    }
    if (notification) {
        const channelCensus = await validateNotificationChannelReferenceCensusInTx(tx, { accountId: input.accountId, capture: census.notificationChannels });
        if (channelCensus.status !== 'ready') current = { ok: false, error: channelCensus.status === 'references-conflict' ? 'references_conflict' : 'references_invalid' };
    }
    if (!current.ok) {
        if (current.error !== 'references_conflict') return current;
        const receipt = await readSavedSecretCatalogCensusInTx(tx, { accountId: input.accountId, accountMode: census.accountMode,
            captures: postCaptures, destinationOnly: true });
        if (!resourcesBound || !receipt.ok || savedSecretCatalogMutationKeys.some(key => mutations[key]
            && !isDeepStrictEqual(receipt.value.contents[key]?.content, mutations[key]!.content))) return current;
        if (remote) {
            const row = await readRemoteHostCatalogRowInTx(tx, { accountId: input.accountId });
            if (row.status !== 'present' || row.revision !== receiptValue(fence.account.settingsVersion).remoteHostRevision
                || !isDeepStrictEqual(row.content, remote.content)) return current;
        }
        if (notification) {
            const row = await readNotificationChannelCatalogInTx(tx, { accountId: input.accountId });
            if (row.status !== 'present' || row.revision !== receiptValue(fence.account.settingsVersion).notificationChannelRevision
                || !isDeepStrictEqual(row.content, notification.content)) return current;
        }
        const resourcesReceipt = await proveSavedSecretPromotionResourcesInTx(tx, input);
        if (!resourcesReceipt.ok) return resourcesReceipt;
        if (remote && !await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
            references: remote.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)),
            savedSecretRevisions: remote.referencedSavedSecretRevisions.map(capture => ({ resourceId: capture.resourceId, expectedRevision: capture.revision })) })) return { ok: false, error: 'references_invalid' };
        if (notification && !await validateNotificationPromotionReferencesInTx(tx, input, notification)) return { ok: false, error: 'references_invalid' };
        for (const key of savedSecretCatalogMutationKeys) {
            const mutation = mutations[key];
            if (mutation && !await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId,
                authentication: input.authentication, references: mutation.referencedSavedSecretIds,
                savedSecretRevisions: mutation.savedSecretRevisions ?? [] })) return { ok: false, error: 'references_invalid' };
        }
        return { ok: true, value: receiptValue(fence.account.settingsVersion) };
    }
    if (!resourcesBound) return { ok: false, error: 'references_invalid' };
    if (!await validatePersonalPromotionSourcesInTx(tx, input)) return { ok: false, error: 'references_invalid' };
    await createSavedSecretPromotionResourcesInTx(tx, input);
    await mutateSavedSecretCatalogsInTx(tx, { accountId: input.accountId, authentication: input.authentication, mutations });
    if (remote) rejectSavedSecretCatalogMutation(await mutateRemoteHostCatalogRowInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...remote }));
    if (notification) rejectSavedSecretCatalogMutation(await mutateNotificationChannelCatalogInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...notification }));
    return { ok: true, value: receiptValue(fence.account.settingsVersion) };
}

function isPromotedMachineEnvironmentRewritable(value: Prisma.JsonValue, sourceIds: readonly string[]): boolean {
    const reached = sourceIds.filter(secretId => listSavedSecretReferenceCarrierPathsV1(value, { secretId }).length > 0);
    if (reached.length === 0) return true;
    const parsed = MachineEnvironmentV1ReadSchema.safeParse(value);
    return parsed.success && parsed.data.secretRefs !== undefined && reached.every(secretId =>
        listSavedSecretReferenceCarrierPathsV1(value, { secretId }).length === listSavedSecretReferenceCarrierPathsV1(parsed.data, { secretId }).length);
}

function rewritePromotedMachineEnvironment(value: Prisma.JsonValue, promotions: ReadonlyMap<string, Readonly<{ ref: string; revision: number }>>): Prisma.InputJsonObject | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const reached = [...promotions.keys()].filter(secretId => listSavedSecretReferenceCarrierPathsV1(value, { secretId }).length > 0);
    if (reached.length === 0) return null;
    const parsed = MachineEnvironmentV1ReadSchema.safeParse(value);
    if (!parsed.success || !parsed.data.secretRefs || !isPromotedMachineEnvironmentRewritable(value, reached)) {
        throw new SavedSecretResourceTransactionAbort('references_invalid');
    }
    const bindings = Object.fromEntries(Object.entries(parsed.data.secretRefs.bindings).map(([key, binding]) => {
        const promoted = promotions.get(binding.ref);
        return [key, promoted ? { ref: promoted.ref, revision: promoted.revision } : binding];
    }));
    return { ...value, secretRefs: { ...parsed.data.secretRefs, bindings } };
}

/** Personal ids are scoped to the controller/custodian Account, including Team-owned presets. */
async function rewritePromotedMachineReferencesInTx(tx: Tx, accountId: string,
    promotions: ReadonlyMap<string, Readonly<{ ref: string; revision: number }>>): Promise<void> {
    if (promotions.size === 0) return;
    const controllers = await tx.machine.findMany({ where: { accountId }, select: { id: true } });
    const presets = await tx.managedMachinePreset.findMany({ where: { controllerMachineId: { in: controllers.map(machine => machine.id) } } });
    for (const preset of presets) {
        const environment = rewritePromotedMachineEnvironment(preset.environment, promotions);
        if (!environment) continue;
        const changed = await tx.managedMachinePreset.updateMany({ where: { id: preset.id, revision: preset.revision },
            data: { environment, revision: { increment: 1 } } });
        if (changed.count !== 1) throw new SavedSecretResourceTransactionAbort('references_conflict');
        await invalidatePresetInTx(tx, await tx.managedMachinePreset.findUniqueOrThrow({ where: { id: preset.id } }));
    }
    const machines = await tx.managedMachine.findMany({ where: { custodianAccountId: accountId } });
    for (const machine of machines) {
        const setup = machine.environmentSetup;
        if (setup === null || typeof setup !== 'object' || Array.isArray(setup) || setup.environment === undefined) continue;
        const environment = rewritePromotedMachineEnvironment(setup.environment, promotions);
        if (!environment) continue;
        const changed = await tx.managedMachine.updateMany({ where: { id: machine.id, environmentSetup: { equals: setup } },
            data: { environmentSetup: { ...setup, environment } } });
        if (changed.count !== 1) throw new SavedSecretResourceTransactionAbort('references_conflict');
        await invalidateManagedMachineInTx(tx, await tx.managedMachine.findUniqueOrThrow({ where: { id: machine.id } }));
    }
}

/** Couples creation, private references and Settings in one rollback boundary. */
export async function promoteSavedSecretResourceInTx(
    tx: Tx,
    candidate: PromoteSavedSecretResourceInput,
): Promise<SavedSecretResourceServiceResult<{ resourceId: string; settingsVersion: number; remoteHostRevision?: number; notificationChannelRevision?: number; catalogRevisions?: Partial<SavedSecretCatalogRevisionsV1> }>> {
    const parsedPromotionCensus = SavedSecretPromoteReferenceCensusV1Schema.safeParse(candidate.referenceCensus);
    const parsedCatalogMutations = SavedSecretCatalogMutationsV1Schema.safeParse(candidate.catalogMutations ?? {});
    const parsedSources = SavedSecretPersonalPromotionsV1Schema.safeParse(candidate.personalSecretPromotions ?? []);
    const destinationIds = new Set(savedSecretPromotionResources(candidate).map(resource => resource.resourceId));
    if (!parsedSources.success || parsedSources.data.some(source => !destinationIds.has(source.resourceId))) return { ok: false, error: 'references_invalid' };
    const parsedRemote = candidate.remoteHostMutation ? RemoteHostCatalogRowMutationV1Schema.safeParse(candidate.remoteHostMutation) : null;
    if (parsedRemote && !parsedRemote.success) return { ok: false, error: 'references_invalid' };
    const parsedNotification = candidate.notificationChannelMutation ? NotificationChannelCatalogMutationV1Schema.safeParse(candidate.notificationChannelMutation) : null;
    if (parsedNotification && (!parsedNotification.success || parsedNotification.data.settingsMutation !== undefined)) return { ok: false, error: 'references_invalid' };
    if (!parsedPromotionCensus.success || !parsedCatalogMutations.success) return { ok: false, error: 'references_invalid' };
    if (!Array.isArray(candidate.profileMutations)) return { ok: false, error: 'references_invalid' };
    if ('scope' in parsedPromotionCensus.data) {
        return promoteCatalogOnlySavedSecretResourcesInTx(tx, { ...candidate,
            ...(parsedRemote?.success ? { remoteHostMutation: parsedRemote.data } : {}),
            ...(parsedNotification?.success ? { notificationChannelMutation: parsedNotification.data } : {}) }, parsedPromotionCensus.data, parsedCatalogMutations.data);
    }
    if (candidate.expectedSettingsVersion === undefined) return { ok: false, error: 'references_invalid' };
    const input = { ...candidate, expectedSettingsVersion: candidate.expectedSettingsVersion,
        referenceCensus: parsedPromotionCensus.data };
    if (parsedNotification?.success && input.referenceCensus.notificationChannels?.revision !== parsedNotification.data.expectedRevision)
        return { ok: false, error: 'references_invalid' };
    if (parsedNotification?.success && parsedNotification.data.expectedRevision === 'absent'
        && parsedNotification.data.sourceSettingsVersion !== input.expectedSettingsVersion) return { ok: false, error: 'settings_conflict' };
    if (input.nextSettings === null && input.profileMutations.length === 0 && (parsedRemote?.success || parsedNotification?.success)
        && savedSecretCatalogMutationKeys.every(key => !parsedCatalogMutations.data[key])) {
        const remote = parsedRemote?.success ? parsedRemote.data : undefined;
        const notification = parsedNotification?.success ? parsedNotification.data : undefined;
        if (remote && input.referenceCensus.remoteHosts?.revision !== remote.expectedRevision
            && !(input.referenceCensus.remoteHosts === undefined && remote.expectedRevision === 'absent')
            || notification && input.referenceCensus.notificationChannels?.revision !== notification.expectedRevision)
            return { ok: false, error: 'references_invalid' };
        const declaredRefs = new Set([
            ...(remote?.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)) ?? []),
            ...(notification?.savedSecretRevisions.map(capture => capture.resourceRef) ?? []),
        ]);
        const resources = savedSecretPromotionResources(input);
        if (new Set(resources.map(resource => resource.resourceId)).size !== resources.length
            || !resources.every(resource => declaredRefs.has(formatSharedSavedSecretRefV1(resource.resourceId)))) return { ok: false, error: 'references_invalid' };
        const remoteRow = remote ? await readRemoteHostCatalogRowInTx(tx, { accountId: input.accountId }) : null;
        const notificationRow = notification ? await readNotificationChannelCatalogInTx(tx, { accountId: input.accountId }) : null;
        const rowRevision = (row: typeof remoteRow | typeof notificationRow) => row?.status === 'absent' ? 'absent' : row && 'revision' in row ? row.revision : null;
        const remoteRevision = remote ? remote.expectedRevision === 'absent' ? 0 : remote.expectedRevision + 1 : undefined;
        const notificationRevision = notification ? notification.expectedRevision === 'absent' ? 0 : notification.expectedRevision + 1 : undefined;
        const receipt = { resourceId: input.resourceId, settingsVersion: input.expectedSettingsVersion,
            ...(remote ? { remoteHostRevision: remoteRevision } : {}),
            ...(notification ? { notificationChannelRevision: notificationRevision } : {}) };
        if (remote && rowRevision(remoteRow) !== remote.expectedRevision || notification && rowRevision(notificationRow) !== notification.expectedRevision) {
            if (remote && (remoteRow?.status !== 'present' || remoteRow.revision !== remoteRevision || !isDeepStrictEqual(remoteRow.content, remote.content))
                || notification && (notificationRow?.status !== 'present' || notificationRow.revision !== notificationRevision || !isDeepStrictEqual(notificationRow.content, notification.content))) return { ok: false, error: 'references_conflict' };
            const census = await readSavedSecretReferenceCensusInTx(tx, { ...input, referenceCensus: { ...input.referenceCensus,
                ...(remote && remoteRevision !== undefined ? { remoteHosts: { revision: remoteRevision, resourceRefs: remote.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)) } } : {}),
                ...(notification && notificationRevision !== undefined ? { notificationChannels: { revision: notificationRevision, resourceRefs: notification.savedSecretRevisions.map(capture => capture.resourceRef) } } : {}) } });
            if (!census.ok) return census;
            const resourcesReceipt = await proveSavedSecretPromotionResourcesInTx(tx, input);
            if (!resourcesReceipt.ok) return resourcesReceipt;
            if (remote && !await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
                references: remote.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)),
                savedSecretRevisions: remote.referencedSavedSecretRevisions.map(capture => ({ resourceId: capture.resourceId, expectedRevision: capture.revision })) })) return { ok: false, error: 'references_invalid' };
            if (notification && !await validateNotificationPromotionReferencesInTx(tx, input, notification)) return { ok: false, error: 'references_invalid' };
            return { ok: true, value: receipt };
        }
        const census = await readSavedSecretReferenceCensusInTx(tx, input);
        if (!census.ok) return census;
        if (!await validatePersonalPromotionSourcesInTx(tx, input)) return { ok: false, error: 'references_invalid' };
        await createSavedSecretPromotionResourcesInTx(tx, input);
        if (remote) rejectSavedSecretCatalogMutation(await mutateRemoteHostCatalogRowInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...remote }));
        if (notification) rejectSavedSecretCatalogMutation(await mutateNotificationChannelCatalogInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...notification }));
        return { ok: true, value: receipt };
    }
    const parsedCensus = SavedSecretReferenceCensusV1Schema.safeParse(input.referenceCensus);
    if (!parsedCensus.success) return { ok: false, error: 'references_invalid' };
    if (!Array.isArray(input.profileMutations)) return { ok: false, error: 'references_invalid' };
    const parsedMutations = input.profileMutations.map(mutation => ProfileRowMutationV1Schema.safeParse(mutation));
    if (parsedMutations.some(mutation => !mutation.success)) return { ok: false, error: 'references_invalid' };
    const capturedRows = new Map(parsedCensus.data.profiles.rows.map(row => [row.id, row.revision]));
    if (new Set(input.profileMutations.map(row => row.id)).size !== input.profileMutations.length
        || input.profileMutations.some(row => (row.operation !== 'update' && row.operation !== 'import')
            || row.content === null || row.settingsCleanup !== undefined || capturedRows.get(row.id) !== row.expectedRevision)) {
        return { ok: false, error: 'references_invalid' };
    }
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status !== 'ready') return { ok: false, error: 'settings_invalid' };
    if (fence.account.currentness.encryptionMode !== parsedCensus.data.accountMode) return { ok: false, error: 'references_conflict' };
    const unchangedSettings = input.nextSettings === null;
    const existingWithoutSettingsWrite = unchangedSettings
        ? await tx.savedSecretResource.findUnique({ where: { id: input.resourceId }, select: { id: true } }) : null;
    if (fence.account.settingsVersion !== input.expectedSettingsVersion || existingWithoutSettingsWrite) {
        // A lost-response retry must prove the exact committed resource,
        // Settings bytes AND complete post-write Profile census. Never create
        // a resource while testing whether a prior attempt committed.
        const existing = existingWithoutSettingsWrite
            ?? await tx.savedSecretResource.findUnique({ where: { id: input.resourceId }, select: { id: true } });
        if (!existing || fence.account.settingsVersion !== input.expectedSettingsVersion + (unchangedSettings ? 0 : 1)) throw new SavedSecretResourceTransactionAbort('settings_conflict');
        if (!unchangedSettings) {
            const current = await writeAccountSettingsInTx({ tx, accountId: input.accountId,
                expectedVersion: input.expectedSettingsVersion,
                expectedProfileTransferRevision: parsedCensus.data.profileTransferRevision ?? 'absent',
                next: { kind: 'v2', content: input.nextSettings } });
            if (current.status === 'profile_transfer_mismatch') throw new SavedSecretResourceTransactionAbort('references_conflict');
            if (current.status !== 'version_mismatch' || !isDeepStrictEqual(current.currentContent, input.nextSettings)) throw new SavedSecretResourceTransactionAbort('settings_conflict');
        }
        const resourcesReceipt = await proveSavedSecretPromotionResourcesInTx(tx, input);
        if (!resourcesReceipt.ok) return resourcesReceipt;
        const changedRows = new Map(input.profileMutations.map(row => [row.id, row]));
        const postCatalogs = parsedCensus.data.catalogs ? { ...parsedCensus.data.catalogs } : undefined;
        for (const key of savedSecretCatalogMutationKeys) if (postCatalogs && parsedCatalogMutations.data[key]) {
            const expected = parsedCatalogMutations.data[key]!.expectedRevision;
            postCatalogs[key] = expected === 'absent' ? 0 : expected + 1;
        }
        const remoteHostRevision = parsedRemote?.success ? (parsedRemote.data.expectedRevision === 'absent' ? 0 : parsedRemote.data.expectedRevision + 1) : undefined;
        const notificationChannelRevision = parsedNotification?.success ? (parsedNotification.data.expectedRevision === 'absent' ? 0 : parsedNotification.data.expectedRevision + 1) : undefined;
        const retryCensus = await readSavedSecretReferenceCensusInTx(tx, { ...input,
            expectedSettingsVersion: fence.account.settingsVersion,
            referenceCensus: { ...parsedCensus.data, catalogs: postCatalogs,
                ...(parsedNotification?.success ? { notificationChannels: { revision: notificationChannelRevision!, resourceRefs: parsedNotification.data.savedSecretRevisions.map(capture => capture.resourceRef) } } : {}),
                ...(parsedRemote?.success ? { remoteHosts: { revision: remoteHostRevision!, resourceRefs: parsedRemote.data.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)) } } : {}), profiles: {
                referenceGuardRevision: parsedCensus.data.profiles.referenceGuardRevision === 'absent' ? 0 : parsedCensus.data.profiles.referenceGuardRevision + 1,
                rows: parsedCensus.data.profiles.rows.map(row => ({ ...row, revision: row.revision + (changedRows.has(row.id) ? 1 : 0) })),
            } } });
        if (!retryCensus.ok) return retryCensus;
        if (retryCensus.value.rows.some(row => changedRows.has(row.id) && !isDeepStrictEqual(row.content, changedRows.get(row.id)!.content))) return { ok: false, error: 'references_conflict' };
        if (savedSecretCatalogMutationKeys.some(key => parsedCatalogMutations.data[key]
            && !isDeepStrictEqual(retryCensus.value.catalogContents[key]?.content, parsedCatalogMutations.data[key]!.content))) return { ok: false, error: 'references_conflict' };
        if (parsedRemote?.success) {
            const row = await readRemoteHostCatalogRowInTx(tx, { accountId: input.accountId });
            if (row.status !== 'present' || row.revision !== remoteHostRevision || !isDeepStrictEqual(row.content, parsedRemote.data.content)) return { ok: false, error: 'references_conflict' };
        }
        if (parsedNotification?.success) {
            const row = await readNotificationChannelCatalogInTx(tx, { accountId: input.accountId });
            if (row.status !== 'present' || row.revision !== notificationChannelRevision || !isDeepStrictEqual(row.content, parsedNotification.data.content)
                || !await validateNotificationPromotionReferencesInTx(tx, input, parsedNotification.data)) return { ok: false, error: 'references_conflict' };
        }
        return { ok: true, value: { resourceId: input.resourceId, settingsVersion: fence.account.settingsVersion,
            ...(notificationChannelRevision === undefined ? {} : { notificationChannelRevision }),
            ...(remoteHostRevision === undefined ? {} : { remoteHostRevision }) } };
    }
    const census = await readSavedSecretReferenceCensusInTx(tx, input);
    if (!census.ok) return census;
    const sourceCleanup = parsedCatalogMutations.data.acp?.settingsCleanup?.nextSettings;
    const proposedSettings = input.nextSettings?.t === 'plain' ? input.nextSettings.v : null;
    if (census.value.settingsContent?.t === 'plain' && sourceCleanup?.t === 'plain' && proposedSettings
        && Object.keys(census.value.settingsContent.v).some(key => !Object.hasOwn(sourceCleanup.v, key)
            && Object.hasOwn(proposedSettings, key))) return { ok: false, error: 'references_invalid' };
    if (!await validatePersonalPromotionSourcesInTx(tx, input, true)) return { ok: false, error: 'references_invalid' };
    const savedSecretRefs = new Map<string, string>();
    if (census.value.settingsContent?.t === 'plain' && Array.isArray(census.value.settingsContent.v.secrets)) {
        for (const secret of census.value.settingsContent.v.secrets) {
            if (secret === null || typeof secret !== 'object' || Array.isArray(secret) || !('id' in secret) || typeof secret.id !== 'string') continue;
            const destination = deriveSavedSecretImportResourceIdV1({ accountId: input.accountId,
                source: { kind: 'personal-saved-secret', secretId: secret.id } });
            if (savedSecretPromotionResources(input).some(resource => resource.resourceId === destination)) savedSecretRefs.set(secret.id, formatSharedSavedSecretRefV1(destination));
        }
    }
    for (const key of savedSecretCatalogMutationKeys) if (parsedCatalogMutations.data[key]
        && parsedCensus.data.catalogs?.[key] !== parsedCatalogMutations.data[key]!.expectedRevision) return { ok: false, error: 'references_invalid' };
    await createSavedSecretPromotionResourcesInTx(tx, input);
    await mutateSavedSecretCatalogsInTx(tx, { accountId: input.accountId, authentication: input.authentication,
        mutations: parsedCatalogMutations.data, savedSecretRefs });
    let remoteHostRevision: number | undefined;
    let notificationChannelRevision: number | undefined;
    if (parsedNotification?.success) {
        const result = await mutateNotificationChannelCatalogInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...parsedNotification.data });
        rejectSavedSecretCatalogMutation(result);
        if (result.status !== 'updated') throw new SavedSecretResourceTransactionAbort('references_invalid');
        notificationChannelRevision = result.revision;
    }
    if (parsedRemote?.success) {
        const result = await mutateRemoteHostCatalogRowInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...parsedRemote.data });
        rejectSavedSecretCatalogMutation(result);
        if (result.status !== 'updated') throw new SavedSecretResourceTransactionAbort('references_invalid');
        remoteHostRevision = result.revision;
    }
    if (input.profileMutations.length > 0) {
        const profiles = await mutateProfileRowsInTx(tx, { accountId: input.accountId,
            authentication: input.authentication, mutations: input.profileMutations,
            expectedReferenceGuardRevision: parsedCensus.data.profiles.referenceGuardRevision });
        if (profiles.status !== 'updated') throw new SavedSecretResourceTransactionAbort(
            profiles.status === 'conflict' ? 'references_conflict' : profiles.status === 'settings-conflict' ? 'settings_conflict' : 'references_invalid');
    } else {
        const guard = await advanceProfileReferenceGuardInTx(tx, { accountId: input.accountId,
            expectedRevision: parsedCensus.data.profiles.referenceGuardRevision });
        if (guard.status !== 'updated') throw new SavedSecretResourceTransactionAbort(guard.status === 'conflict' ? 'references_conflict' : 'references_invalid');
    }
    if (unchangedSettings) return { ok: true, value: { resourceId: input.resourceId, settingsVersion: input.expectedSettingsVersion,
        ...(notificationChannelRevision === undefined ? {} : { notificationChannelRevision }),
        ...(remoteHostRevision === undefined ? {} : { remoteHostRevision }) } };
    const settingsWrite = await writeAccountSettingsInTx({
        tx,
        accountId: input.accountId,
        expectedVersion: input.expectedSettingsVersion,
        expectedProfileTransferRevision: parsedCensus.data.profileTransferRevision ?? 'absent',
        next: { kind: "v2", content: input.nextSettings },
    });
    if (settingsWrite.status === "version_mismatch") {
        throw new SavedSecretResourceTransactionAbort("settings_conflict");
    }
    if (settingsWrite.status === 'profile_transfer_mismatch') throw new SavedSecretResourceTransactionAbort('references_conflict');
    if (settingsWrite.status !== "success") {
        throw new SavedSecretResourceTransactionAbort("settings_invalid");
    }
    return { ok: true, value: { resourceId: input.resourceId, settingsVersion: settingsWrite.version,
        ...(notificationChannelRevision === undefined ? {} : { notificationChannelRevision }),
        ...(remoteHostRevision === undefined ? {} : { remoteHostRevision }) } };
}
