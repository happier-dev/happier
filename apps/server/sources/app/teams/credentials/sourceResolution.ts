import type { ConnectedAccountDirectExportProjectionV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import type { QualifiedConnectedAccountSourceIdentity } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import type { QualifiedConnectedAccountGroupSourceSnapshot } from '@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository';

type DirectExportSupport = "supported" | "mixed" | "unsupported";

export type TeamCredentialResourceSourceCurrentness =
    | Readonly<{
        kind: "provider_connection";
        connectionId: string;
        connectionSecurityFingerprint: string;
        credentialSlotId: string;
    }>
    | Readonly<{
        kind: "connected_account";
        identity: QualifiedConnectedAccountSourceIdentity;
    }>
    | Readonly<{
        kind: "connected_pool";
        snapshot: QualifiedConnectedAccountGroupSourceSnapshot;
    }>;

export type TeamCredentialResourceSourceResolution =
    | Readonly<{
        status: "current";
        /** Authentication is independent of source lifetime and Direct-material currentness. */
        authenticationFailure?: typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
        /** Opaque member attribution only when this source binding itself proves one exact member. */
        usageSourceMemberKey: string | null;
        directExportSupport: DirectExportSupport;
        directExportFailure?: ConnectedAccountDirectExportProjectionV1['directExportFailure'];
        requestPolicyCurrentness: TeamCredentialResourceSourceCurrentness;
        metadata:
            | Readonly<{
                kind: "connected_account" | "connected_pool";
                service: QualifiedConnectedAccountServiceRef;
            }>
            | Readonly<{
                kind: "provider_connection";
                connectionId: string;
                connectionSecurityFingerprint: string;
                credentialSlotId: string;
            }>;
    }>
    | Readonly<{
        status: "unavailable";
        reason: "invalid_source_binding" | "source_missing" | "source_changed";
    }>;

type TeamCredentialSourceBinding = ReturnType<
    typeof TeamCredentialSourceBindingV1Schema.parse
>;
type ConnectedAccountSourceBinding = Extract<
    TeamCredentialSourceBinding,
    { kind: "connected_account" }
>;
type ConnectedPoolSourceBinding = Extract<
    TeamCredentialSourceBinding,
    { kind: "connected_pool" }
>;

export function projectConnectedAccountSourceResolution(
    source: ConnectedAccountSourceBinding,
    current: QualifiedConnectedAccountSourceIdentity | null,
): TeamCredentialResourceSourceResolution {
    if (!current) return { status: "unavailable", reason: "source_missing" };
    if (current.incarnation !== source.credentialIncarnation) {
        return { status: "unavailable", reason: "source_changed" };
    }
    return {
        status: "current",
        ...(current.status === "needs_reauth" ? { authenticationFailure: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired } : {}),
        directExportSupport: current.directExportContract === null
            || current.contributionContractVersion === null
            ? "unsupported"
            : "supported",
        ...(current.directExportFailure ? { directExportFailure: current.directExportFailure } : {}),
        requestPolicyCurrentness: { kind: "connected_account", identity: current },
        usageSourceMemberKey: computeTeamCredentialSourceMemberKeyV1({
            kind: "connected_account",
            service: source.target.account.service,
            connectedAccountId: source.target.account.accountId,
        }),
        metadata: {
            kind: source.kind,
            service: source.target.account.service,
        },
    };
}

export function projectConnectedPoolSourceResolution(
    source: ConnectedPoolSourceBinding,
    current: QualifiedConnectedAccountGroupSourceSnapshot | null,
): TeamCredentialResourceSourceResolution {
    // Health-triggered rotation commits at the daemon's switch coordinator.
    // Project the actual active member until that commit; readers never pick a backup.
    if (!current) return { status: "unavailable", reason: "source_missing" };
    if (current.incarnation !== source.poolIncarnation) {
        return { status: "unavailable", reason: "source_changed" };
    }
    const enabled = current.members.filter(member => member.enabled);
    const exporting = enabled.filter(member => (
        member.credentialRevision !== null
        && member.directExportContract !== null
        && member.contributionContractVersion !== null
    ));
    const supported = exporting.length;
    const directExportSupport: DirectExportSupport = supported === 0
        ? "unsupported"
        : supported === enabled.length ? "supported" : "mixed";
    return {
        status: "current",
        ...(current.members.some(member => member.enabled && member.account.accountId === current.activeConnectedAccountId && member.status === "needs_reauth")
            ? { authenticationFailure: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired } : {}),
        directExportSupport,
        ...(exporting.length > 0 && exporting.every(member => member.directExportFailure !== undefined)
            ? { directExportFailure: exporting[0]!.directExportFailure } : {}),
        requestPolicyCurrentness: { kind: "connected_pool", snapshot: current },
        usageSourceMemberKey: null,
        metadata: {
            kind: source.kind,
            service: source.target.service,
        },
    };
}

export function projectProviderConnectionSourceResolution(
    source: Extract<TeamCredentialSourceBinding, { kind: "provider_connection" }>,
): TeamCredentialResourceSourceResolution {
    // Provider Settings may be E2EE, so the Home deliberately retains only
    // the source owner's opaque currentness snapshot. The canonical Provider
    // owner on the exact broker Machine re-resolves private material.
    return {
        status: "current",
        directExportSupport: "supported",
        requestPolicyCurrentness: {
            kind: "provider_connection",
            connectionId: source.connectionId,
            connectionSecurityFingerprint: source.connectionSecurityFingerprint,
            credentialSlotId: source.credentialSlotId,
        },
        usageSourceMemberKey: computeTeamCredentialSourceMemberKeyV1({
            kind: "provider_credential_slot",
            connectionId: source.connectionId,
            credentialSlotId: source.credentialSlotId,
        }),
        metadata: {
            kind: source.kind,
            connectionId: source.connectionId,
            connectionSecurityFingerprint: source.connectionSecurityFingerprint,
            credentialSlotId: source.credentialSlotId,
        },
    };
}
