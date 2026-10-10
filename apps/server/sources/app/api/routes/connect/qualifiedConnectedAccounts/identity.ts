import { createHash } from "node:crypto";

import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceIdSchema,
    PluginContributionLocalIdSchema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
    type ConnectedServiceId,
    type BuiltInLegacyConnectedServiceId,
    type QualifiedConnectedAccountGroupRef,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedAccountServiceRef,
} from "@happier-dev/protocol";

function createQualifiedIdentityDigest(
    kind: "account" | "group",
    service: Readonly<{ pluginId: string; localId: string }>,
    localIdentity: string,
): string {
    return createHash("sha256")
        .update(JSON.stringify([kind, service.pluginId, service.localId, localIdentity]))
        .digest("hex");
}

export function createQualifiedConnectedAccountServiceDigest(
    service: QualifiedConnectedAccountServiceRef,
): string {
    const canonicalService =
        QualifiedConnectedAccountServiceRefSchema.parse(service);
    return createHash("sha256")
        .update(JSON.stringify([
            "service",
            canonicalService.pluginId,
            canonicalService.localId,
        ]))
        .digest("hex");
}

export function createQualifiedConnectedAccountIdentityDigest(
    ref: QualifiedConnectedAccountRef,
): string {
    const canonicalRef = QualifiedConnectedAccountRefSchema.parse(ref);
    return createQualifiedIdentityDigest(
        "account",
        canonicalRef.service,
        canonicalRef.accountId,
    );
}

export type StoredQualifiedConnectedAccountIdentity = Readonly<{
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    connectedAccountId: string;
    qualifiedIdentityDigest: string;
}>;

/**
 * Parses the canonical qualified identity duplicated on a stored account row
 * and verifies that both derived digests agree with the full structured tuple.
 */
export function parseStoredQualifiedConnectedAccountRef(
    row: StoredQualifiedConnectedAccountIdentity,
): QualifiedConnectedAccountRef {
    const service = QualifiedConnectedAccountServiceRefSchema.parse({
        pluginId: row.servicePluginId,
        localId: row.serviceLocalId,
    });
    const ref = QualifiedConnectedAccountRefSchema.parse({
        service,
        accountId: row.connectedAccountId,
    });
    if (
        row.qualifiedServiceDigest
            !== createQualifiedConnectedAccountServiceDigest(service)
        || row.qualifiedIdentityDigest
            !== createQualifiedConnectedAccountIdentityDigest(ref)
    ) {
        throw new Error(
            "Qualified Connected Account stored identity digest mismatch",
        );
    }
    return ref;
}

export type StoredQualifiedConnectedAccountGroupIdentity = Readonly<{
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    qualifiedGroupDigest: string;
    groupId: string;
}>;

/**
 * Parses the canonical qualified identity duplicated on a stored group row
 * and verifies that both derived digests agree with the full structured tuple.
 */
export function parseStoredQualifiedConnectedAccountGroupRef(
    row: StoredQualifiedConnectedAccountGroupIdentity,
): QualifiedConnectedAccountGroupRef {
    const service = QualifiedConnectedAccountServiceRefSchema.parse({
        pluginId: row.servicePluginId,
        localId: row.serviceLocalId,
    });
    const ref = QualifiedConnectedAccountGroupRefSchema.parse({
        service,
        groupId: row.groupId,
    });
    if (
        row.qualifiedServiceDigest
            !== createQualifiedConnectedAccountServiceDigest(service)
        || row.qualifiedGroupDigest
            !== createQualifiedConnectedAccountGroupDigest(ref)
    ) {
        throw new Error(
            "Qualified Connected Account stored group identity digest mismatch",
        );
    }
    return ref;
}

export type ServiceAccountTokenIdentityFields = Readonly<{
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    connectedAccountId: string;
    qualifiedIdentityDigest: string;
    authenticationModeId: string;
}>;

type LegacyCredentialKind = "oauth" | "token";

function readLegacyAuthenticationModeForCredentialKind(
    modes: Readonly<Partial<Record<LegacyCredentialKind, string>>>,
    credentialKind: LegacyCredentialKind,
): string | undefined {
    const modeId = modes[credentialKind];
    return typeof modeId === "string" ? modeId : undefined;
}

/**
 * Canonical qualified identity fields for every ServiceAccountToken create.
 * Legacy adapters resolve their released service/profile identity first, then
 * delegate here so legacy and qualified writers cannot assign different keys.
 */
export function createServiceAccountTokenIdentityFields(params: Readonly<{
    ref: QualifiedConnectedAccountRef;
    authenticationModeId: string;
}>): ServiceAccountTokenIdentityFields {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const authenticationModeId =
        PluginContributionLocalIdSchema.parse(params.authenticationModeId);
    return {
        servicePluginId: ref.service.pluginId,
        serviceLocalId: ref.service.localId,
        qualifiedServiceDigest:
            createQualifiedConnectedAccountServiceDigest(ref.service),
        connectedAccountId: ref.accountId,
        qualifiedIdentityDigest:
            createQualifiedConnectedAccountIdentityDigest(ref),
        authenticationModeId,
    };
}

function readLegacyConnectedAccountStorageCompatibility(serviceId: string) {
    // Stored predecessor identities include services that closed peer APIs never admitted.
    if (!Object.hasOwn(BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID, serviceId)) {
        throw new Error(`Unknown historical Connected Account service '${serviceId}'`);
    }
    return BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[serviceId as BuiltInLegacyConnectedServiceId];
}

export function resolveLegacyServiceAccountTokenIdentityFields(
    params: Readonly<{
        serviceId: string;
        profileId: string;
        credentialKind?: "oauth" | "token" | null;
    }>,
): ServiceAccountTokenIdentityFields {
    const compatibility = readLegacyConnectedAccountStorageCompatibility(params.serviceId);
    const byKind = compatibility.authenticationModeByCredentialKind;
    const unsupportedByKind =
        compatibility.unsupportedAuthenticationModeByCredentialKind;
    const authenticationModeId = params.credentialKind === "oauth"
        ? (
            readLegacyAuthenticationModeForCredentialKind(
                byKind,
                "oauth",
            )
            ?? readLegacyAuthenticationModeForCredentialKind(
                unsupportedByKind,
                "oauth",
            )
        )
        : params.credentialKind === "token"
            ? (
                readLegacyAuthenticationModeForCredentialKind(
                    byKind,
                    "token",
                )
                ?? readLegacyAuthenticationModeForCredentialKind(
                    unsupportedByKind,
                    "token",
                )
            )
            : compatibility.defaultAuthenticationModeId;
    if (!authenticationModeId) {
        throw new Error(
            `Legacy Connected Account credential kind '${String(params.credentialKind)}' is unsupported for '${params.serviceId}'`,
        );
    }
    return createServiceAccountTokenIdentityFields({
        ref: {
            service: compatibility.service,
            accountId: params.profileId,
        },
        authenticationModeId,
    });
}

export type QualifiedConnectedAccountLegacyIdentity = Readonly<{
    serviceId: BuiltInLegacyConnectedServiceId;
    profileId: string;
}>;

export function resolveLegacyQualifiedConnectedAccountService(
    serviceIdInput: string,
): QualifiedConnectedAccountServiceRef {
    return QualifiedConnectedAccountServiceRefSchema.parse(
        readLegacyConnectedAccountStorageCompatibility(serviceIdInput).service,
    );
}

export function resolveLegacyServiceIdForQualifiedConnectedAccountService(
    serviceInput: QualifiedConnectedAccountServiceRef,
): ConnectedServiceId | null {
    const service =
        QualifiedConnectedAccountServiceRefSchema.parse(serviceInput);
    for (const serviceId of ConnectedServiceIdSchema.options) {
        const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[serviceId];
        if (
            compatibility.service.pluginId === service.pluginId
            && compatibility.service.localId === service.localId
        ) {
            return serviceId;
        }
    }
    return null;
}

export function resolveQualifiedConnectedAccountLegacyIdentity(
    params: Readonly<{
        ref: QualifiedConnectedAccountRef;
        authenticationModeId: string;
    }>,
): QualifiedConnectedAccountLegacyIdentity | null {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const authenticationModeId =
        PluginContributionLocalIdSchema.parse(params.authenticationModeId);
    for (const [serviceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ) as Array<[
        BuiltInLegacyConnectedServiceId,
        typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[BuiltInLegacyConnectedServiceId],
    ]>) {
        if (
            compatibility.service.pluginId !== ref.service.pluginId
            || compatibility.service.localId !== ref.service.localId
        ) {
            continue;
        }
        const supportedModeIds = new Set<string>([
            compatibility.defaultAuthenticationModeId,
            ...Object.values(
                compatibility.authenticationModeByCredentialKind,
            ),
            ...Object.values(
                compatibility.unsupportedAuthenticationModeByCredentialKind,
            ),
        ]);
        if (!supportedModeIds.has(authenticationModeId)) return null;
        return {
            serviceId,
            profileId: ref.accountId,
        };
    }
    return null;
}

export function assertQualifiedConnectedAccountLegacyIdentityMatches(
    params: Readonly<{
        ref: QualifiedConnectedAccountRef;
        authenticationModeId: string;
        legacyIdentity: Readonly<{
            serviceId: string;
            profileId: string;
        }>;
    }>,
): QualifiedConnectedAccountLegacyIdentity {
    const expected = resolveQualifiedConnectedAccountLegacyIdentity(params);
    if (
        !expected
        || expected.serviceId !== params.legacyIdentity.serviceId
        || expected.profileId !== params.legacyIdentity.profileId
    ) {
        throw new Error(
            "Legacy Connected Account identity mismatch with qualified reference",
        );
    }
    return expected;
}

export function resolveLegacyCredentialKindForAuthenticationMode(
    params: Readonly<{
        serviceId: string;
        authenticationModeId: string;
    }>,
): "oauth" | "token" | null {
    const compatibility = readLegacyConnectedAccountStorageCompatibility(params.serviceId);
    const classified = classifyLegacyAuthenticationMode({
        compatibility,
        authenticationModeId: params.authenticationModeId,
    });
    return classified?.support === "supported"
        ? classified.credentialKind
        : null;
}

export type LegacyAuthenticationModeClassification = Readonly<{
    credentialKind: "oauth" | "token";
    support: "supported" | "unsupported";
}>;

function classifyLegacyAuthenticationMode(params: Readonly<{
    compatibility:
        typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            BuiltInLegacyConnectedServiceId
        ];
    authenticationModeId: string;
}>): LegacyAuthenticationModeClassification | null {
    for (const credentialKind of ["oauth", "token"] as const) {
        if (
            readLegacyAuthenticationModeForCredentialKind(
                params.compatibility
                    .authenticationModeByCredentialKind,
                credentialKind,
            ) === params.authenticationModeId
        ) {
            return { credentialKind, support: "supported" };
        }
        if (
            readLegacyAuthenticationModeForCredentialKind(
                params.compatibility
                    .unsupportedAuthenticationModeByCredentialKind,
                credentialKind,
            ) === params.authenticationModeId
        ) {
            return { credentialKind, support: "unsupported" };
        }
    }
    return null;
}

export function classifyQualifiedConnectedAccountLegacyAuthenticationMode(
    params: Readonly<{
        service: QualifiedConnectedAccountServiceRef;
        authenticationModeId: string;
    }>,
): LegacyAuthenticationModeClassification | null {
    const service = QualifiedConnectedAccountServiceRefSchema.parse(params.service);
    const authenticationModeId = PluginContributionLocalIdSchema.parse(params.authenticationModeId);
    const compatibility = Object.values(BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID)
        .find((entry) => entry.service.pluginId === service.pluginId && entry.service.localId === service.localId);
    return compatibility ? classifyLegacyAuthenticationMode({ compatibility, authenticationModeId }) : null;
}

/**
 * Projects the stored authentication mode at public read boundaries. Historical
 * unsupported modes remain available to migration and legacy reverse projection,
 * but public clients receive only the bounded "mode unavailable" null semantic.
 */
export function projectQualifiedConnectedAccountPublicAuthenticationModeId(
    params: Readonly<{
        service: QualifiedConnectedAccountServiceRef;
        authenticationModeId: string;
    }>,
): string | null {
    const authenticationModeId =
        PluginContributionLocalIdSchema.parse(params.authenticationModeId);
    const classification =
        classifyQualifiedConnectedAccountLegacyAuthenticationMode({
            service: params.service,
            authenticationModeId,
        });
    return classification?.support === "unsupported"
        ? null
        : authenticationModeId;
}

export function createQualifiedConnectedAccountGroupDigest(
    ref: QualifiedConnectedAccountGroupRef,
): string {
    const canonicalRef = QualifiedConnectedAccountGroupRefSchema.parse(ref);
    return createQualifiedIdentityDigest(
        "group",
        canonicalRef.service,
        canonicalRef.groupId,
    );
}
