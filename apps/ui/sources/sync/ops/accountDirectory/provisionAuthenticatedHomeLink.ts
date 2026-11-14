import type { AccountDirectoryCapabilities } from '@happier-dev/protocol/features/payload/capabilities/accountDirectoryCapabilities';
import { publishAccountServiceHomeLink } from '@happier-dev/cli-common/accountService';
import {
    deleteHomeDirectoryLink,
    isAccountDirectoryRelinkConflict,
    putHomeDirectoryLink,
} from '@/sync/api/accountDirectory/accountDirectoryClient';
import type { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import {
    buildHomeConnectionDescriptorForProfile,
    resolveServerProfileForPortableIdentity,
} from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';

export type AuthenticatedHomeLinkProvisionResult =
    | Readonly<{ kind: 'linked'; homeServerIdentityId: string }>
    | Readonly<{ kind: 'relink_required'; homeServerIdentityId: string }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'home_profile_unavailable'
            | 'home_credentials_unavailable'
            | 'home_transport_unavailable';
    }>
    | Readonly<{ kind: 'failed'; error?: unknown }>;

export type ProvisionAuthenticatedHomeLinkInput = Readonly<{
    session: AccountDirectorySession;
    /** Stable identity of the Home captured when the explicit link intent began. */
    homeServerIdentityId: string;
    /** Stable identity of the selected Account Service, verified by the caller. */
    issuerServerIdentityId: string;
    /** Observed Account Directory capability carrying the advertised assertion signing key. */
    capability: AccountDirectoryCapabilities;
    /** Explicit user-approved replacement of the Home's pinned Account Service trust facts. */
    relink?: boolean;
    shouldCancel?: () => boolean;
}>;

class HomeLinkTransportUnavailableError extends Error {}

type HomeLinkUnavailableReason = Extract<AuthenticatedHomeLinkProvisionResult, { kind: 'unavailable' }>['reason'];

export type AuthenticatedHomeLinkRevocationResult =
    | Readonly<{ kind: 'unlinked'; homeServerIdentityId: string }>
    | Readonly<{ kind: 'unavailable'; reason: HomeLinkUnavailableReason }>
    | Readonly<{ kind: 'failed'; error?: unknown }>;

/**
 * Resolves the captured stable Home identity through the canonical profile registry and composes
 * its canonical descriptor. Focus is never consulted; a missing profile or a descriptor that does
 * not name the captured identity resolves to null so callers fail closed.
 */
function resolveLinkedHomeProfile(homeServerIdentityId: string) {
    const resolved = resolveServerProfileForPortableIdentity(homeServerIdentityId);
    if (resolved.kind !== 'resolved') return null;
    const descriptor = buildHomeConnectionDescriptorForProfile(resolved.profile);
    if (!descriptor || descriptor.homeServerIdentityId !== homeServerIdentityId) return null;
    return { profile: resolved.profile, descriptor };
}

/**
 * Revokes the Home's pinned trust in the selected Account Service with that Home's own full
 * credential. From then on the Home refuses delegated sign-in assertions from that issuer; Home
 * credentials it already issued stay valid until revoked on the Home, and the Account Service
 * directory row is left untouched. Every lookup binds to the captured identity, never focus.
 */
export async function revokeAuthenticatedHomeLink(input: Readonly<{
    homeServerIdentityId: string;
    issuerServerIdentityId: string;
    shouldCancel?: () => boolean;
}>): Promise<AuthenticatedHomeLinkRevocationResult> {
    const homeServerIdentityId = input.homeServerIdentityId.trim();
    const issuerServerIdentityId = input.issuerServerIdentityId.trim();
    if (!homeServerIdentityId || !issuerServerIdentityId) {
        return { kind: 'unavailable', reason: 'home_profile_unavailable' };
    }
    const linked = resolveLinkedHomeProfile(homeServerIdentityId);
    if (!linked) return { kind: 'unavailable', reason: 'home_profile_unavailable' };
    const credential = await TokenStorage.getCredentialsForServerUrl(
        linked.profile.serverUrl,
        { serverId: homeServerIdentityId },
    ).catch(() => null);
    if (!credential) return { kind: 'unavailable', reason: 'home_credentials_unavailable' };
    if (input.shouldCancel?.() === true) return { kind: 'failed' };
    const resolvedTransport = await resolveHomeEnrollmentTransport(linked.descriptor, {
        verification: { kind: 'authenticated', token: credential.token },
    });
    if (!resolvedTransport.ok) return { kind: 'unavailable', reason: 'home_transport_unavailable' };
    try {
        if (input.shouldCancel?.() === true) return { kind: 'failed' };
        await deleteHomeDirectoryLink(resolvedTransport.transport, issuerServerIdentityId, { credentials: credential });
        return { kind: 'unlinked', homeServerIdentityId };
    } catch (error) {
        return { kind: 'failed', error };
    } finally {
        await resolvedTransport.transport.close().catch(() => {});
    }
}

/**
 * Automatic current-Home relationship provisioning for the authenticated-Home login intent.
 * Resolves the captured stable identity through the canonical profile registry, composes the
 * canonical descriptor, and provisions Home trust first (authenticated with that Home's own
 * full credential through the canonical Home transport), then publishes the Home into the
 * Account Service directory. Both PUTs are idempotent; a partial failure is retried only by
 * repeating this explicit linking action, never by ordinary Directory refresh or rollback
 * machinery. Every lookup is bound to the
 * captured identity — focus is never consulted, and missing profile, credentials, or an
 * approved transport fail closed without publishing an untrusted directory row. Pure-Iroh
 * descriptors acquire the shared verified Lane06 origin through HomeEnrollmentTransport.
 */
/**
 * Whether a Home this device knows can be linked: linking publishes its connection descriptor,
 * so a Home that publishes none (no address other devices can reach) cannot be. The same check
 * the link itself fails closed on, so a surface never offers a link that cannot succeed.
 */
export function canPublishAuthenticatedHomeLink(homeServerIdentityId: string): boolean {
    const identity = homeServerIdentityId.trim();
    return identity ? resolveLinkedHomeProfile(identity) !== null : false;
}

export async function provisionAuthenticatedHomeLink(
    input: ProvisionAuthenticatedHomeLinkInput,
): Promise<AuthenticatedHomeLinkProvisionResult> {
    const isCurrent = input.session.captureLifecycle();
    const shouldCancel = () => !isCurrent() || input.shouldCancel?.() === true;
    const homeServerIdentityId = input.homeServerIdentityId.trim();
    const issuerServerIdentityId = input.issuerServerIdentityId.trim();
    if (!homeServerIdentityId || !issuerServerIdentityId) {
        return { kind: 'unavailable', reason: 'home_profile_unavailable' };
    }
    if (shouldCancel()) return { kind: 'failed' };
    const linked = resolveLinkedHomeProfile(homeServerIdentityId);
    if (!linked) return { kind: 'unavailable', reason: 'home_profile_unavailable' };
    const { profile, descriptor } = linked;
    const directoryHome = {
        homeServerIdentityId: descriptor.homeServerIdentityId,
        canonicalServerUrl: descriptor.canonicalServerUrl,
        label: profile.name,
        connectionDescriptor: descriptor,
    };
    const selectedIssuerIdentity = input.session.serviceKey.slice(
        input.session.serviceKey.lastIndexOf('\u0000') + 1,
    );
    const result = await publishAccountServiceHomeLink({
        home: directoryHome,
        issuerServerIdentityId,
        issuerSigningKeyId: input.capability.homeLoginAssertion.keyId,
        issuerSigningPublicKeyBase64Url: input.capability.homeLoginAssertion.publicKeyBase64Url,
        ...(input.relink !== undefined ? { relink: input.relink } : {}),
        shouldCancel,
        adapters: {
            readHomeCredential: async () => await TokenStorage.getCredentialsForServerUrl(
                profile.serverUrl,
                { serverId: homeServerIdentityId },
            ).catch(() => null),
            readAccountServiceCredential: async (identity) =>
                identity === selectedIssuerIdentity ? input.session : null,
            readAccountSubject: async (session) => {
                const { accountId, encryptionMode } = await session.readAccountSummary();
                return { accountId, encryptionMode };
            },
            publishLinkToHome: async ({ credential, issuerSubjectId, relink }) => {
                const resolvedTransport = await resolveHomeEnrollmentTransport(descriptor, {
                    verification: { kind: 'authenticated', token: credential.token },
                });
                if (!resolvedTransport.ok) throw new HomeLinkTransportUnavailableError();
                try {
                    if (shouldCancel()) throw new Error('Account Service credential custody superseded');
                    await putHomeDirectoryLink(
                        resolvedTransport.transport,
                        {
                            issuerServerIdentityId,
                            issuerSubjectId,
                            issuerSigningKeyId: input.capability.homeLoginAssertion.keyId,
                            issuerSigningPublicKeyBase64Url: input.capability.homeLoginAssertion.publicKeyBase64Url,
                        },
                        { credentials: credential, relink },
                    );
                } finally {
                    await resolvedTransport.transport.close().catch(() => {});
                }
            },
            publishHomeToAccountService: async ({ home, credential: session }) => {
                await session.putHome({
                    homeServerIdentityId: home.homeServerIdentityId,
                    label: home.label,
                    connectionDescriptor: home.connectionDescriptor,
                });
            },
        },
    });
    if (result.kind === 'linked') return result;
    if (result.kind === 'cancelled') return { kind: 'failed' };
    if (result.kind === 'unavailable') {
        return result.reason === 'home_credentials_unavailable'
            ? { kind: 'unavailable', reason: 'home_credentials_unavailable' }
            : { kind: 'failed' };
    }
    if (result.error instanceof HomeLinkTransportUnavailableError) {
        return { kind: 'unavailable', reason: 'home_transport_unavailable' };
    }
    if (input.relink !== true && isAccountDirectoryRelinkConflict(result.error)) {
        return { kind: 'relink_required', homeServerIdentityId };
    }
    return { kind: 'failed', error: result.error };
}
