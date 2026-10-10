import type { TeamIdentityConnectionStateV1, TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';

import {
    signInConnectionStatusLabel,
    type SignInConnectionStatus,
} from '@/components/settings/identity/signInConnectionStatus';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type IdentityConnectionMode = 'sign_in_only' | 'sign_in_time_groups';
export type IdentityConnectionTestStatus = 'required' | 'stale' | 'current';

export function identityProviderKindLabel(kind: TeamIdentityConnectionV1['provider']['kind']): string {
    switch (kind) {
        case 'oidc': return t('identityAdministration.providerOidc');
        case 'workos_sso': return t('identityAdministration.providerWorkosSso');
        case 'github_app_identity': return t('identityAdministration.providerGitHub');
    }
}

/** WorkOS owns these wire strings and may add values independently. */
export function workosConnectionStrategyLabel(strategy: string): string {
    switch (strategy.trim().toLowerCase()) {
        case 'saml': return t('identityAdministration.workosStrategySaml');
        case 'oidc': return t('identityAdministration.workosStrategyOidc');
        default: return t('identityAdministration.workosStrategyOther');
    }
}

/**
 * A Team connection's projected state in the shared sign-in connection vocabulary. The Home decides
 * the state; this only renames the one value whose wire name differs from the shared word.
 */
export function teamIdentityConnectionStatus(state: TeamIdentityConnectionStateV1): SignInConnectionStatus {
    return state === 'connected' ? 'active' : state;
}

/** A Team connection's state in words, through the one status vocabulary. */
export function connectionStateLabel(state: TeamIdentityConnectionStateV1): string {
    return signInConnectionStatusLabel(teamIdentityConnectionStatus(state));
}

/** The glyph that stands for a provider kind where a row names a connection (no brand marks exist yet). */
export function identityProviderKindIconName(kind: TeamIdentityConnectionV1['provider']['kind']): IconName {
    switch (kind) {
        case 'oidc': return 'key';
        case 'workos_sso': return 'shield-check';
        case 'github_app_identity': return 'github-logo';
    }
}

/** WorkOS's own status for one of its connections; the words it shares with ours come from the shared vocabulary. */
export function workosConnectionStatusLabel(status: string): string {
    switch (status.trim().toLowerCase()) {
        case 'active': return signInConnectionStatusLabel('active');
        case 'inactive':
        case 'disabled': return signInConnectionStatusLabel('disabled');
        case 'draft': return t('identityAdministration.githubDraft');
        default: return t('identityAdministration.workosStatusUnknown');
    }
}

/**
 * Keeps the overview stable under status and health changes. A status update
 * must not move the row currently under a pointer or keyboard focus.
 */
export function sortIdentityConnectionsForAdministration<TConnection extends Pick<TeamIdentityConnectionV1, 'id' | 'provider'>>(
    connections: readonly TConnection[],
): readonly TConnection[] {
    return Object.freeze([...connections].sort((left, right) => {
        const byName = left.provider.displayName.localeCompare(right.provider.displayName);
        return byName !== 0 ? byName : left.id.localeCompare(right.id);
    }));
}

/**
 * OIDC Group claims are refreshed only during sign-in. Calling that directory
 * management would overstate offboarding and background synchronization.
 */
export function identityConnectionMode(connection: Pick<TeamIdentityConnectionV1, 'settings'>): IdentityConnectionMode {
    if (
        connection.settings.kind === 'oidc'
        && (connection.settings.groupsAny.length > 0 || connection.settings.groupsAll.length > 0)
    ) {
        return 'sign_in_time_groups';
    }
    return 'sign_in_only';
}

/**
 * The exact connection, when its provider name alone does not identify it.
 *
 * Two connections may legitimately carry the same provider display name — two
 * WorkOS organizations, two GitHub installations — and a policy checkbox that
 * shows only that name would ask the administrator to choose blind. The
 * discriminator is taken from the connection projection already on screen; no
 * second identity read is introduced, and the opaque connection id is the
 * fallback because it is always exact.
 */
export function identityConnectionDiscriminator(connection: Pick<TeamIdentityConnectionV1, 'id' | 'externalReference'>): string {
    const reference = connection.externalReference;
    if (reference.kind === 'workos_sso' && reference.organizationId !== null) return reference.organizationId;
    if (reference.kind === 'github_app_identity') return reference.installationId;
    return connection.id;
}

export function identityConnectionTestStatus(
    connection: Pick<TeamIdentityConnectionV1, 'lastSuccessfulTest'>,
): IdentityConnectionTestStatus {
    if (!connection.lastSuccessfulTest) return 'required';
    return connection.lastSuccessfulTest.current ? 'current' : 'stale';
}

export type WorkosSetupStepId = 'portal' | 'choose' | 'test' | 'enable';
export type WorkosSetupStep = Readonly<{ id: WorkosSetupStepId; state: 'done' | 'current' | 'upcoming' }>;

/**
 * The visible WorkOS setup path (① Admin Portal → ② choose the connection →
 * ③ test → ④ turn on), read only from facts the connection projection already
 * carries. It is a presentation of that projection, not a second lifecycle: the
 * first unfinished fact is the one current step, everything before it is done
 * and everything after it waits. An enabled connection has finished setup, and
 * no other provider kind has these steps, so both answer `null`.
 */
export function workosSetupSteps(connection: Pick<TeamIdentityConnectionV1, 'provider' | 'externalReference' | 'enabled' | 'lastSuccessfulTest'>): readonly WorkosSetupStep[] | null {
    const reference = connection.externalReference;
    if (connection.provider.kind !== 'workos_sso' || reference.kind !== 'workos_sso' || connection.enabled) return null;
    const done: Readonly<Record<WorkosSetupStepId, boolean>> = {
        portal: reference.organizationId !== null,
        choose: reference.connectionId !== null,
        test: identityConnectionTestStatus(connection) === 'current',
        enable: false,
    };
    const order: readonly WorkosSetupStepId[] = ['portal', 'choose', 'test', 'enable'];
    const current = order.find((id) => !done[id]) ?? 'enable';
    const currentIndex = order.indexOf(current);
    return order.map((id, index) => ({
        id,
        state: index < currentIndex ? 'done' as const : index === currentIndex ? 'current' as const : 'upcoming' as const,
    }));
}

/**
 * What comes next for a connection that is still being set up, in the words its own page uses for
 * that step; `null` once setup is finished or for a kind without steps.
 */
export function identityConnectionNextStepLabel(connection: Parameters<typeof workosSetupSteps>[0]): string | null {
    const current = workosSetupSteps(connection)?.find((step) => step.state === 'current');
    switch (current?.id) {
        case 'portal': return t('identityAdministration.workosSetupSso');
        case 'choose': return t('identityAdministration.workosChooseConnection');
        case 'test': return t('identityAdministration.test');
        case 'enable': return t('identityAdministration.workosStepEnable');
        default: return null;
    }
}
