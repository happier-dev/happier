import { TEAM_LOGO_MAX_SOURCE_PIXELS_V1, TEAM_LOGO_PUBLISHED_EDGE_V1, decodeTeamLogoSourceV1, type TeamLogoSourceV1 } from '@happier-dev/protocol/teams/logo';
import { type TeamSummaryV1 } from '@happier-dev/protocol/teams/projections';

import { deletePublicFile, writePublicFile } from "@/storage/blob/files";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { tryProcessImage } from "@/storage/blob/processImage";
import { inTx, type Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx } from "./memberships/sessionAccessEffects";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { randomKey } from "@/utils/keys/randomKey";

import { projectForActorInTx } from "./lifecycle";
import { TEAM_PROJECTION_SELECT, readStoredTeamLogo, type StoredTeamLogo } from "./projections";
import { publishTeamChangedInTx } from "./teamChanges";
import {
    acquireTeamMutationLockInTx,
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "./actorContext";
import { toTeamViewer } from "./viewer";

/**
 * Team-owned branding.
 *
 * The logo reuses the existing image processing and public-blob mechanics, but
 * its custody is the Team's: the object lives under a Team-qualified prefix and
 * its metadata is a column on `Team`, not a row owned by whoever uploaded it.
 * That is the whole reason this is not `uploadImage` — an Account-owned
 * `UploadedFile` row is deleted with its uploader during Account erasure, which
 * would silently strip a company's branding when an employee leaves.
 *
 * There is no blob-cleanup queue. A replacement deletes exactly the reference it
 * displaced, read inside the committing transaction, and a failed commit deletes
 * only the candidate it just uploaded.
 */

export type TeamLogoError =
    | "team_not_found"
    | "team_forbidden"
    | "team_archived"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "invalid_team_input"
    | "teams_unavailable";

export type TeamLogoResult =
    | Readonly<{ ok: true; team: TeamSummaryV1 }>
    | Readonly<{ ok: false; error: TeamLogoError }>;

/**
 * The Team-qualified object prefix. The path is derived here from the
 * authenticated Team, never accepted from a caller, and this predicate is what
 * lets deletion refuse to touch anything that did not come from this writer.
 */
export function teamLogoObjectPrefix(teamId: string): string {
    return `public/teams/${teamId}/logo/`;
}

export function isTeamLogoObjectPath(teamId: string, path: string): boolean {
    return path.startsWith(teamLogoObjectPrefix(teamId));
}

type LogoCommit =
    | Readonly<{ ok: true; team: TeamSummaryV1; displacedPath: string | null }>
    | Readonly<{ ok: false; error: TeamLogoError }>;

/**
 * Publishes new Team branding.
 *
 * Byte admission happens at the media boundary before any authority is spent,
 * and the reference is committed under a re-checked capability afterwards. The
 * order matters: bytes are validated and published outside the transaction
 * because decoding and blob writes are not transactional work, and the decision
 * that they may become this Team's logo is made again inside it.
 */
export async function setTeamLogo(input: Readonly<{
    actorAccountId: string;
    teamId: string;
    image: TeamLogoSourceV1;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<TeamLogoResult> {
    const authorized = await inTx(async (tx) => authorizeLogoMutationInTx(tx, input));
    if (authorized !== null) return { ok: false, error: authorized };

    const decoded = decodeTeamLogoSourceV1(input.image);
    if (decoded.status !== "ok") return { ok: false, error: "invalid_team_input" };

    const processed = await tryProcessImage(Buffer.from(decoded.bytes), {
        // One deterministic server-side square fit, previewed by the client before
        // confirmation, in place of an interactive crop editor.
        fit: "cover",
        maxEdge: TEAM_LOGO_PUBLISHED_EDGE_V1,
        maxInputPixels: TEAM_LOGO_MAX_SOURCE_PIXELS_V1,
        expectedSourceMimeType: decoded.mimeType,
    });
    if (!processed.ok) return { ok: false, error: "invalid_team_input" };
    // `tryProcessImage` owns the canonical output format: opaque images are
    // published as JPEG and images with alpha as PNG. The source decoder has
    // already validated the declared input MIME, so comparing it with the
    // normalized output would reject valid PNG/JPEG inputs based only on alpha.

    const path = `${teamLogoObjectPrefix(input.teamId)}${randomKey("logo")}.${processed.image.extension}`;
    await writePublicFile(path, processed.image.bytes);

    const logo: StoredTeamLogo = {
        path,
        width: processed.image.width,
        height: processed.image.height,
        thumbhash: processed.image.thumbhash,
    };

    let committed: LogoCommit;
    try {
        committed = await inTx(async (tx): Promise<LogoCommit> => {
            const denial = await authorizeLogoMutationInTx(tx, input);
            if (denial !== null) return { ok: false, error: denial };
            return await commitTeamLogoInTx(tx, {
                teamId: input.teamId,
                actorAccountId: input.actorAccountId,
                logo,
                storedSizeBytes: BigInt(processed.image.bytes.byteLength),
                authentication: input.authentication,
            });
        }, { isolationLevel: "ReadCommitted" /* The Team guard precedes fresh authority and displaced-logo capture. */ });
    } catch (error) {
        await deleteTeamLogoObject(input.teamId, path);
        throw error;
    }

    if (!committed.ok) {
        // Nothing was displaced, so the only object to remove is the candidate
        // this call uploaded. The current logo is untouched.
        await deleteTeamLogoObject(input.teamId, path);
        return committed;
    }

    // Committed first, deleted after: the displaced object was read inside the
    // transaction that replaced it, so a concurrent replacement can only ever
    // delete the reference it actually superseded, never the winning one.
    if (committed.displacedPath !== null && committed.displacedPath !== path) {
        await deleteTeamLogoObject(input.teamId, committed.displacedPath);
    }
    return { ok: true, team: committed.team };
}

/** Removes Team branding, deleting only this Team's displaced object. */
export async function removeTeamLogo(input: Readonly<{
    actorAccountId: string;
    teamId: string;
    env?: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<TeamLogoResult> {
    const committed = await inTx(async (tx): Promise<LogoCommit> => {
        const denial = await authorizeLogoMutationInTx(tx, input);
        if (denial !== null) return { ok: false, error: denial };
        return await commitTeamLogoInTx(tx, {
            teamId: input.teamId,
            actorAccountId: input.actorAccountId,
            logo: null,
            storedSizeBytes: null,
            authentication: input.authentication,
        });
    }, { isolationLevel: "ReadCommitted" /* The Team guard precedes fresh authority and displaced-logo capture. */ });
    if (!committed.ok) return committed;

    if (committed.displacedPath !== null) {
        await deleteTeamLogoObject(input.teamId, committed.displacedPath);
    }
    return { ok: true, team: committed.team };
}

/**
 * The one branding authorization. `manageSettings` covers Team metadata and
 * branding through a single decision, and an archived Team accepts no branding
 * change except restore.
 */
async function authorizeLogoMutationInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        env?: NodeJS.ProcessEnv;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamLogoError | null> {
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId] });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    await recheckAdmission();
    if (!await isServerFeatureEnabledForHome("teams", { tx, env: input.env })) return "teams_unavailable";
    const context = await resolveTeamActorContextInTx(tx, input);
    const viewer = toTeamViewer(context);
    if (viewer === null) return "team_not_found";
    if (viewer.capabilities.manageSettings) {
        if (context!.homeAuthority.manageAllTeams) return null;
        const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            context: context!,
            ...input.authentication,
        });
        return qualification.ok ? null : qualification.error;
    }
    // `restoreTeam` is exactly the set that would hold `manageSettings` if the
    // Team were active, so only they are told the archive is the reason.
    const archived = viewer.team.archivedAt !== null;
    return archived && viewer.capabilities.restoreTeam ? "team_archived" : "team_forbidden";
}

async function commitTeamLogoInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        logo: StoredTeamLogo | null;
        storedSizeBytes: bigint | null;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<LogoCommit> {
    const current = await tx.team.findUnique({
        where: { id: input.teamId },
        select: { logo: true },
    });
    if (!current) return { ok: false, error: "team_not_found" };
    const displaced = readStoredTeamLogo(current.logo, input.teamId);

    const updated = await tx.team.update({
        where: { id: input.teamId },
        data: { logo: input.logo === null ? getActivePrismaRuntime().DbNull : input.logo,
            logoStoredSizeBytes: input.storedSizeBytes },
        select: TEAM_PROJECTION_SELECT,
    });
    await publishTeamChangedInTx(tx, { teamId: input.teamId });

    return {
        ok: true,
        team: await projectForActorInTx(tx, updated, input.actorAccountId, input.authentication),
        displacedPath: displaced?.path ?? null,
    };
}

/**
 * Blob deletion is best effort and idempotent: a missing object is already the
 * intended state, and a storage hiccup must not fail a mutation that has
 * committed. It refuses any path outside this Team's prefix, so a reference that
 * did not come from this writer can never be used to delete someone else's
 * object.
 */
async function deleteTeamLogoObject(teamId: string, path: string): Promise<void> {
    if (!isTeamLogoObjectPath(teamId, path)) return;
    try {
        await deletePublicFile(path);
    } catch {
        // Intentionally ignored: an orphaned public object is a storage cost, not
        // a correctness or disclosure problem, and no cleanup queue is warranted.
    }
}
