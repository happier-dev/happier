import {
    ConnectedServiceCredentialRevisionV1Schema,
    type ConnectedAccountPurposeDeclarationV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedAccountPurposeBindingV1,
    type QualifiedConnectedAccountPurposeV1,
    type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountRequestAuthResolvedBinding,
} from './ConnectedAccountRequestAuthService';
import {
    resolveFirstPartyLegacyAgentConnectedAccountServiceId,
    resolveFirstPartyLegacyRequestAuthServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type {
    QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import {
    parseHttpHeadersRequestAuthBearer,
} from './parseHttpHeadersRequestAuthBearer';

/**
 * The sole compatibility map from the released service-keyed Connected Services namespace to the
 * qualified Connected Account namespace. New purpose bindings carry the qualified ref and this
 * adapter only translates at the legacy credential/projection boundary. It never selects or writes
 * a binding. Remove each entry after the corresponding service-keyed Agent/session producers,
 * rollback readers, and persisted inputs leave the supported release frontier.
 */
export function resolveFirstPartyConnectedAccountServiceId(
    service: QualifiedConnectedAccountRef['service'],
): ConnectedServiceId | null {
    return resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
}

/**
 * The released Agent/session shape is service-keyed. During the compatibility window, translate
 * that already-selected intent into the manifest-declared qualified purpose namespace exactly
 * once. This is deliberately one-way: request-time consumers and binding persistence never write
 * the legacy shape, and native/missing/unsupported services mint no request-auth authority.
 */
export function projectLegacyConnectedServiceBindingsToQualifiedPurposeBindings(input: Readonly<{
    consumer: PluginContributionIdentityV1;
    declarations: readonly ConnectedAccountPurposeDeclarationV1[];
    bindings: ConnectedServiceBindingsV1;
}>): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    return projectLegacyConnectedServiceBindingsToQualifiedPurposeBindingSnapshot(input).bindings;
}

export function projectLegacyConnectedServiceBindingsToQualifiedPurposeBindingSnapshot(input: Readonly<{
    consumer: PluginContributionIdentityV1;
    declarations: readonly ConnectedAccountPurposeDeclarationV1[];
    bindings: ConnectedServiceBindingsV1;
}>): Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
}> {
    const purposes: QualifiedConnectedAccountPurposeV1[] = [];
    const projected: QualifiedConnectedAccountPurposeBindingV1[] = [];
    for (const declaration of input.declarations) {
        const qualifiedService = typeof declaration.service === 'string'
            ? Object.freeze({
                pluginId: input.consumer.pluginId,
                localId: declaration.service,
            })
            : declaration.service;
        const serviceId = resolveFirstPartyConnectedAccountServiceId(qualifiedService);
        if (!serviceId) continue;
        const purpose = Object.freeze({
            consumer: Object.freeze({ ...input.consumer }),
            purpose: declaration.purpose,
        });
        purposes.push(purpose);
        const legacyBinding = input.bindings.bindingsByServiceId[serviceId];
        if (!legacyBinding || legacyBinding.source !== 'connected') continue;

        projected.push(Object.freeze({
            purpose,
            target: legacyBinding.selection === 'group'
                ? Object.freeze({
                    kind: 'group' as const,
                    service: Object.freeze({ ...qualifiedService }),
                    groupId: legacyBinding.groupId,
                })
                : Object.freeze({
                    kind: 'account' as const,
                    account: Object.freeze({
                        service: Object.freeze({ ...qualifiedService }),
                        accountId: legacyBinding.profileId,
                    }),
                }),
        }));
    }
    return Object.freeze({
        purposes: Object.freeze(purposes),
        bindings: Object.freeze(projected),
    });
}

type FirstPartyRequestAuthProjection = Readonly<{
    groups: readonly Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string | null;
        generation: number;
    }>[];
    resolveCredentialRevision: (
        serviceId: ConnectedServiceId,
        profileId: string,
    ) => string | null;
}>;

export function resolveFirstPartyConnectedAccountBinding(
    binding: QualifiedConnectedAccountPurposeBindingV1,
    projection: FirstPartyRequestAuthProjection,
): ConnectedAccountRequestAuthResolvedBinding | null {
    const service = binding.target.kind === 'account'
        ? binding.target.account.service
        : binding.target.service;
    const serviceId = resolveFirstPartyLegacyRequestAuthServiceId(service);
    if (!serviceId) return null;

    if (binding.target.kind === 'account') {
        const credentialRevision = projection.resolveCredentialRevision(
            serviceId,
            binding.target.account.accountId,
        );
        const parsedRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(credentialRevision);
        if (!parsedRevision.success) return null;
        return Object.freeze({
            account: Object.freeze({
                service: Object.freeze({ ...binding.target.account.service }),
                accountId: binding.target.account.accountId,
            }),
            credentialRevision: parsedRevision.data,
        });
    }

    const groupTarget = binding.target;
    const group = projection.groups.find((candidate) => (
        candidate.serviceId === serviceId
        && candidate.groupId === groupTarget.groupId
    ));
    if (!group?.activeProfileId) return null;
    const credentialRevision = projection.resolveCredentialRevision(
        serviceId,
        group.activeProfileId,
    );
    const parsedRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(credentialRevision);
    if (!parsedRevision.success) return null;
    return Object.freeze({
        account: Object.freeze({
            service: Object.freeze({ ...groupTarget.service }),
            accountId: group.activeProfileId,
        }),
        credentialRevision: parsedRevision.data,
        group: Object.freeze({
            groupId: group.groupId,
            generation: group.generation,
        }),
    });
}

type FirstPartyCredentialResolution = Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    revisionSemantics: 'revisioned';
}>;

type ConnectedAccountRequestAuthEstablishedMaterializer = Readonly<{
    invokeWithReceipt(input: Readonly<{
        account: QualifiedConnectedAccountRef;
        operation: Readonly<{
            kind: 'materialize';
            request: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
        }>;
        signal?: AbortSignal;
    }>): Promise<Readonly<{
        result: unknown;
        basis: Readonly<{
            credentialRevision: string;
            isCurrent(): boolean;
        }>;
    }>>;
}>;

export async function materializeFirstPartyConnectedAccountBearer(input: Readonly<{
    resolved: ConnectedAccountRequestAuthResolvedBinding;
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
    transport: QualifiedConnectedAccountPeerOperationTransport;
    signal?: AbortSignal;
    establishedRuntimeOwner?: ConnectedAccountRequestAuthEstablishedMaterializer;
    resolveCredential: (input: Readonly<{
        serviceId: ConnectedServiceId;
        profileId: string;
        signal?: AbortSignal;
    }>) => Promise<FirstPartyCredentialResolution | null>;
}>): Promise<Readonly<{
    accessToken: string;
    requiredHeaders?: Readonly<Record<string, string>>;
    expiresAt?: number;
}>> {
    input.signal?.throwIfAborted();
    if (input.transport.kind === 'v4') {
        if (!input.establishedRuntimeOwner) {
            throw new Error('request_auth_established_runtime_unavailable');
        }
        const invocation = await input.establishedRuntimeOwner.invokeWithReceipt({
            account: input.resolved.account,
            operation: Object.freeze({
                kind: 'materialize' as const,
                request: input.materialization,
            }),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        input.signal?.throwIfAborted();
        if (
            invocation.basis.credentialRevision
                !== input.resolved.credentialRevision
            || !invocation.basis.isCurrent()
        ) {
            throw new Error('request_auth_credential_superseded');
        }
        return parseHttpHeadersRequestAuthBearer(
            input.materialization,
            invocation.result,
        );
    }
    if (input.transport.peerClass !== 'revisioned_v2_v3') {
        throw new Error('request_auth_revision_fence_required');
    }

    const serviceId = resolveFirstPartyLegacyRequestAuthServiceId(input.resolved.account.service);
    if (!serviceId || serviceId !== input.transport.serviceId) {
        throw new Error('request_auth_service_unsupported');
    }
    const resolution = await input.resolveCredential({
        serviceId,
        profileId: input.resolved.account.accountId,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    if (!resolution) throw new Error('request_auth_credential_unavailable');
    if (resolution.credentialRevision !== input.resolved.credentialRevision) {
        throw new Error('request_auth_credential_superseded');
    }
    if (resolution.record.kind !== 'oauth') {
        throw new Error('request_auth_oauth_bearer_required');
    }

    const providerAccountId = resolution.record.oauth.providerAccountId?.trim() || null;
    const headers: Record<string, string> = {
        authorization: `Bearer ${resolution.record.oauth.accessToken}`,
    };
    for (const headerName of input.materialization.headerNames) {
        if (headerName === 'authorization') continue;
        if (headerName === 'chatgpt-account-id' && providerAccountId) {
            headers[headerName] = providerAccountId;
        }
    }
    const materialized = parseHttpHeadersRequestAuthBearer(
        input.materialization,
        { kind: 'httpHeaders', headers },
    );
    return Object.freeze({
        ...materialized,
        ...(resolution.record.expiresAt === null
            ? {}
            : { expiresAt: resolution.record.expiresAt }),
    });
}
