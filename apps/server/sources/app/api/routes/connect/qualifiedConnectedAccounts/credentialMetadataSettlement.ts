import type {
    QualifiedConnectedAccountCredentialMetadataV4,
} from "@happier-dev/protocol";

type ProviderIdentity =
    QualifiedConnectedAccountCredentialMetadataV4["providerIdentity"];

function hasOwn(
    value: object,
    key: "accountId" | "email",
): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function settlesChangedEstablishedIdentity(params: Readonly<{
    current: ProviderIdentity;
    incoming: ProviderIdentity;
}>): boolean {
    if (!params.current || !params.incoming) return false;
    return (["accountId", "email"] as const).some((key) =>
        params.current?.[key] !== undefined
        && hasOwn(params.incoming ?? {}, key)
        && params.incoming?.[key] !== params.current[key],
    );
}

function mergeProviderIdentity(
    current: ProviderIdentity,
    incoming: ProviderIdentity,
): ProviderIdentity {
    if (!current) return incoming;
    if (!incoming) return current;
    const accountId = hasOwn(incoming, "accountId")
        ? incoming.accountId
        : current.accountId;
    const email = hasOwn(incoming, "email")
        ? incoming.email
        : current.email;
    return {
        ...(accountId !== undefined ? { accountId } : {}),
        ...(email !== undefined ? { email } : {}),
    };
}

export function settleQualifiedConnectedAccountCredentialMetadata(
    params: Readonly<{
        current:
            | QualifiedConnectedAccountCredentialMetadataV4
            | null
            | undefined;
        incoming: QualifiedConnectedAccountCredentialMetadataV4;
        allowProviderIdentityChange: boolean;
    }>,
):
    | Readonly<{
        status: "settled";
        metadata: QualifiedConnectedAccountCredentialMetadataV4;
    }>
    | Readonly<{ status: "provider_identity_mismatch" }> {
    if (
        !params.allowProviderIdentityChange
        && settlesChangedEstablishedIdentity({
            current: params.current?.providerIdentity,
            incoming: params.incoming.providerIdentity,
        })
    ) {
        return { status: "provider_identity_mismatch" };
    }
    const providerIdentity = mergeProviderIdentity(
        params.current?.providerIdentity,
        params.incoming.providerIdentity,
    );
    return {
        status: "settled",
        metadata: {
            ...params.incoming,
            ...(providerIdentity ? { providerIdentity } : {}),
        },
    };
}
