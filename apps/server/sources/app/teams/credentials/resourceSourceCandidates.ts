import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { projectConnectedPoolSourceResolution } from './sourceResolution';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { TeamCredentialSourceCandidateV1Schema, teamCredentialSourceCandidateIdV1, type TeamCredentialSourceCandidateV1 } from '@happier-dev/protocol/teams';

import type { Tx } from "@/storage/inTx";
import { listQualifiedConnectedAccountSourceOffersInTx } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { readQualifiedConnectedAccountGroupSourceSnapshotInTx } from "@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";

/**
 * The source families this Home can actually offer today.
 *
 * A Provider connection lives in the owner's Account Settings, which the Home
 * stores opaquely and may not read at all when the Account is end-to-end
 * encrypted. Home therefore cannot enumerate it or produce its security
 * fingerprint. The authenticated custodian client may compose those candidates
 * from its canonical local Provider registry and return the selected strict
 * binding through create; `supportedKinds` advertises that consumed path, not
 * Home-side Provider authority.
 *
 * Connected Accounts are projected by their canonical repository, which pairs
 * safe current presentation with the immutable credential-row lifetime. This
 * adapter never parses stored credential metadata or invents a label from the
 * qualified routing identity.
 */
const SUPPORTED_KINDS = ["connected_account", "connected_pool", "provider_connection"] as const;

export type ListTeamCredentialSourceCandidatesResult =
    | Readonly<{
        ok: true;
        candidates: readonly TeamCredentialSourceCandidateV1[];
        supportedKinds: readonly ("connected_account" | "connected_pool" | "provider_connection")[];
    }>
    | Readonly<{ ok: false; error: "not_found_or_not_visible" | "forbidden" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

/**
 * Every source the authenticated Account may offer to one Team, each carrying
 * the exact lifetime a resource would pin.
 *
 * The pin is the point. A resource stores the owning credential row for an
 * Account and the persisted incarnation for a Pool so that deleting and
 * recreating either one does not silently retarget the Team's resource at
 * different upstream material. Neither identity appears in the Connected Account
 * read projections a client holds, so a client assembling its own binding would
 * have to invent or omit the pin — which is how a stale choice becomes a
 * successful offer. The Home reads both here, beside the offer decision it
 * already owns, and the chooser sends the binding back unchanged.
 *
 * Nothing about the credential itself crosses this boundary: no token, expiry,
 * refresh lease, configuration or scope. Every row is already this Account's
 * own, because only a source's custodian may offer it.
 */
export async function listTeamCredentialSourceCandidatesInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; teamId: string; authentication: TeamOperationAuthenticationContext }>,
): Promise<ListTeamCredentialSourceCandidatesResult> {
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    if (!actor) return { ok: false, error: "not_found_or_not_visible" };
    // Offering is its own capability: a Team manager administers other people's
    // resources but does not thereby gain the right to offer a source, and a
    // suspended membership or archived Team withdraws the right entirely.
    if (!resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).offerOwnCredential) {
        return { ok: false, error: "forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;

    // Unpaged on purpose: these are the actor's own hand-created Pools and this
    // Team's own resources, both authored one at a time in Settings, so the
    // answer is the size of what one person made rather than of the Home. The
    // condition that would invalidate that is a Pool source that some automation
    // creates in bulk; a chooser cursor belongs with that producer, not ahead of
    // it.
    const [accounts, pools, existing] = await Promise.all([
        listQualifiedConnectedAccountSourceOffersInTx(tx, {
            accountId: input.actorAccountId,
        }),
        tx.connectedServiceAuthGroup.findMany({
            where: { accountId: input.actorAccountId },
            select: {
                id: true,
                servicePluginId: true,
                serviceLocalId: true,
                groupId: true,
                displayName: true,
                members: { select: { enabled: true } },
            },
            orderBy: [{ servicePluginId: "asc" }, { serviceLocalId: "asc" }, { groupId: "asc" }],
        }),
        tx.teamCredentialResource.findMany({
            where: { teamId: input.teamId },
            select: { id: true, sourceBindingJson: true },
        }),
    ]);

    // Which candidate each existing resource already occupies, keyed by the same
    // pinned identity the chooser uses. Offering one source twice would give the
    // Team two policies over one credential with no rule for which wins.
    const offeredByCandidateId = new Map<string, string>();
    for (const resource of existing) {
        const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!source.success) continue;
        const candidateId = teamCredentialSourceCandidateIdV1(source.data);
        if (!offeredByCandidateId.has(candidateId)) offeredByCandidateId.set(candidateId, resource.id);
    }

    const candidates: TeamCredentialSourceCandidateV1[] = [];
    for (const account of accounts) {
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1,
            kind: "connected_account",
            target: {
                kind: "account",
                account: account.ref,
            },
            credentialIncarnation: account.credentialIncarnation,
        });
        const candidateId = teamCredentialSourceCandidateIdV1(source);
        candidates.push(TeamCredentialSourceCandidateV1Schema.parse({
            source,
            candidateId,
            label: account.label,
            memberCount: null,
            directExportSupport: account.directExportSupport,
            ...(account.directExportFailure ? { directExportFailure: account.directExportFailure } : {}),
            offeredByResourceId: offeredByCandidateId.get(candidateId) ?? null,
        }));
    }
    for (const pool of pools) {
        const source = TeamCredentialSourceBindingV1Schema.safeParse({
            v: 1,
            kind: "connected_pool",
            target: {
                kind: "group",
                service: { pluginId: pool.servicePluginId, localId: pool.serviceLocalId },
                groupId: pool.groupId,
            },
            poolIncarnation: pool.id,
        });
        if (!source.success) continue;
        if (source.data.kind !== "connected_pool") continue;
        const snapshot = await readQualifiedConnectedAccountGroupSourceSnapshotInTx(tx, {
            accountId: input.actorAccountId,
            service: source.data.target.service,
            groupId: source.data.target.groupId,
        });
        if (!snapshot || snapshot.incarnation !== source.data.poolIncarnation) continue;
        const resolution = projectConnectedPoolSourceResolution(source.data, snapshot);
        if (resolution.status !== 'current') continue;
        const candidateId = teamCredentialSourceCandidateIdV1(source.data);
        candidates.push(TeamCredentialSourceCandidateV1Schema.parse({
            source: source.data,
            candidateId,
            label: pool.displayName ?? pool.groupId,
            // Enabled members only. A Pool whose members are all switched off
            // has nothing to select from, and reporting its full roster would
            // read as capacity the source owner has deliberately withdrawn.
            memberCount: pool.members.filter((member) => member.enabled).length,
            directExportSupport: resolution.directExportSupport,
            ...(resolution.directExportFailure ? { directExportFailure: resolution.directExportFailure } : {}),
            offeredByResourceId: offeredByCandidateId.get(candidateId) ?? null,
        }));
    }

    return { ok: true, candidates, supportedKinds: SUPPORTED_KINDS };
}
