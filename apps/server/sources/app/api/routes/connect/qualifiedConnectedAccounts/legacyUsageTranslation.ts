import {
    ConnectedServiceQuotaSnapshotV1Schema,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    projectBuiltInLegacyConnectedServiceQuotaSnapshotV1,
    QualifiedConnectedServiceUsageSourceV4Schema,
    type ConnectedServiceUsageSourceV1,
    type QualifiedConnectedServiceUsageSourceV4,
} from "@happier-dev/protocol";

import {
    resolveLegacyQualifiedConnectedAccountService,
    resolveLegacyServiceIdForQualifiedConnectedAccountService,
} from "./identity";

function projectUsageSource(source: string) {
    switch (source) {
        case "runtimeSignal":
            return "in_band_provider_snapshot";
        case "providerHttp":
            return "provider_api";
        case "proxy":
            return "background_fetch";
        case "connectedServiceProbe":
            return "user_probe";
        case "cached":
            return "cached";
        case "manual":
            return "manual_refresh";
        default:
            return "unknown";
    }
}

function projectUsageConfidence(confidence: string) {
    if (confidence === "confirmed") return "exact";
    if (confidence === "estimated") return "estimated";
    return "unknown";
}

export function projectProviderAccountUsageSnapshotToLegacyQuota(
    params: Readonly<{
        serviceId: string;
        profileId: string;
        snapshot: unknown;
    }>,
) {
    const snapshot =
        ProviderAccountUsageSnapshotV1Schema.parse(params.snapshot);
    return projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(
        ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: params.serviceId,
            profileId: params.profileId,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            planLabel: snapshot.planLabel ?? null,
            accountLabel: snapshot.accountLabel ?? null,
            providerId: snapshot.providerId,
            activeAccountId:
                snapshot.recordKey.accountSubjectId,
            fetchedAtMs: snapshot.fetchedAtMs,
            staleAtMs:
                snapshot.fetchedAtMs + snapshot.staleAfterMs,
            source: projectUsageSource(snapshot.source),
            confidence:
                projectUsageConfidence(snapshot.confidence),
            ...(snapshot.recoveryCredits
                ? { recoveryCredits: snapshot.recoveryCredits }
                : {}),
            meters: snapshot.meters,
        }),
    );
}

export function translateLegacyConnectedServiceUsageSource(
    sourceInput: ConnectedServiceUsageSourceV1,
): QualifiedConnectedServiceUsageSourceV4 {
    const source = ConnectedServiceUsageSourceV1Schema.parse(sourceInput);
    const ref = {
        service:
            resolveLegacyQualifiedConnectedAccountService(
                source.serviceId,
            ),
        accountId: source.profileId,
    };
    return QualifiedConnectedServiceUsageSourceV4Schema.parse(
        source.bindingKind === "group_member"
            ? {
                ref,
                bindingKind: "group_member",
                groupId: source.groupId,
                ...(source.groupGeneration !== undefined
                    ? {
                        groupGeneration:
                            source.groupGeneration,
                    }
                    : {}),
            }
            : { ref, bindingKind: "account" },
    );
}

export function projectQualifiedConnectedServiceUsageSourceToLegacy(
    sourceInput: QualifiedConnectedServiceUsageSourceV4,
): ConnectedServiceUsageSourceV1 | null {
    const source =
        QualifiedConnectedServiceUsageSourceV4Schema.parse(
            sourceInput,
        );
    const serviceId =
        resolveLegacyServiceIdForQualifiedConnectedAccountService(
            source.ref.service,
        );
    if (!serviceId) return null;
    return ConnectedServiceUsageSourceV1Schema.parse(
        source.bindingKind === "group_member"
            ? {
                serviceId,
                profileId: source.ref.accountId,
                bindingKind: "group_member",
                groupId: source.groupId,
                ...(source.groupGeneration !== undefined
                    ? {
                        groupGeneration:
                            source.groupGeneration,
                    }
                    : {}),
            }
            : {
                serviceId,
                profileId: source.ref.accountId,
                bindingKind: "profile",
            },
    );
}
