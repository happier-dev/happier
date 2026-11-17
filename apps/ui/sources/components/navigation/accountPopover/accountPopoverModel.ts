import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AccountServiceSignIn } from '@/components/account/auth/useAccountServiceSignedInName';
import type { HomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import type { MachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';
import { t } from '@/text';

/**
 * The account/Home popover's facts in its own words: one health line per Home and the one fix that
 * applies, who the person is to the account service, and whether the current Home can be linked.
 * Every input comes from the canonical owners (connection health, Home target summary, machine
 * summary, account-service entry); this module only chooses how the popover says it and decides
 * nothing about auth, the Directory, linking, persistence or selection.
 */

/** How a Home's line is marked: a dot for `ok`/`pending`/`off`/`neutral`, a warning glyph for `attention`. */
export type AccountPopoverHealthTone = 'ok' | 'pending' | 'attention' | 'off' | 'neutral';

/** The inline fix a Home row offers: reconnect, re-authenticate this Home, or sign in to another Home. */
export type AccountPopoverHomeFix = 'retry' | 'restore' | 'sign_in' | null;

export type AccountPopoverHomeHealth = Readonly<{
    tone: AccountPopoverHealthTone;
    label: string;
    fix: AccountPopoverHomeFix;
}>;

function resolveUnhealthy(summary: HomeConnectionSummary): AccountPopoverHomeHealth | null {
    switch (summary.kind) {
        case 'reconnecting':
            return { tone: 'pending', label: t(summary.statusLabelKey), fix: null };
        case 'unavailable':
            return { tone: 'attention', label: t('accountPopover.cantReach'), fix: null };
        case 'sign_in':
            return { tone: 'attention', label: t('accountPopover.signedOut'), fix: null };
        case 'unknown':
            return { tone: 'neutral', label: t(summary.statusLabelKey), fix: null };
        case 'connected':
            return null;
    }
}

/** The Home this device is in: its reachability, else how many of its machines are online. */
export function resolveCurrentHomeHealth(
    summary: HomeConnectionSummary,
    machines: MachineConnectionSummary,
): AccountPopoverHomeHealth {
    // The fix is the summary owner's action, whatever the line says: a connected Home whose last
    // sync failed still offers its retry (or its recovery when the failure was auth).
    const fix: AccountPopoverHomeFix = summary.action === 'retry' ? 'retry' : summary.action === 'restore' ? 'restore' : null;
    const unhealthy = resolveUnhealthy(summary);
    if (unhealthy) return { ...unhealthy, fix };
    return { ...resolveMachinesLine(summary, machines), fix };
}

function resolveMachinesLine(
    summary: HomeConnectionSummary,
    machines: MachineConnectionSummary,
): Omit<AccountPopoverHomeHealth, 'fix'> {
    switch (machines.kind) {
        case 'none':
            return { tone: 'neutral', label: t('accountPopover.noMachines') };
        // Connected but no machine online: the dot must not say "fine" beside a line that says nothing is.
        case 'single':
            return machines.online
                ? { tone: 'ok', label: t('accountPopover.machinesOnline', { online: 1, total: 1 }) }
                : { tone: 'neutral', label: t('accountPopover.connectedNoMachinesOnline') };
        case 'multiple':
            if (machines.onlineCount === 0) {
                return { tone: 'neutral', label: t('accountPopover.connectedNoMachinesOnline') };
            }
            return {
                tone: 'ok',
                label: t('accountPopover.machinesOnline', {
                    online: machines.onlineCount,
                    total: machines.onlineCount + machines.offlineCount,
                }),
            };
        case 'unknown':
            return { tone: 'ok', label: t(summary.statusLabelKey) };
    }
}

/** Any other saved Home: only what its own auth and projection prove, and Sign in when it needs it. */
export function resolveOtherHomeHealth(summary: HomeConnectionSummary): AccountPopoverHomeHealth {
    if (summary.kind === 'sign_in') {
        return { tone: 'off', label: t('accountPopover.signedOut'), fix: 'sign_in' };
    }
    return resolveUnhealthy(summary) ?? { tone: 'ok', label: t(summary.statusLabelKey), fix: null };
}

export type AccountServiceIdentity =
    /** The Home offers no sign-in service: the person in it is signed in to it, nothing more. */
    | Readonly<{ kind: 'no_service'; canOpenAccount: false }>
    /** The Home's sign-in policy is not read yet. */
    | Readonly<{ kind: 'pending'; canOpenAccount: false }>
    /** The sign-in status cannot be read now (policy or device credential storage is unavailable). */
    | Readonly<{ kind: 'status_unavailable'; canOpenAccount: false }>
    | Readonly<{
        /** `self`: the Home is its own sign-in service, so the person in it is signed in to it. */
        kind: 'self' | 'signed_in' | 'not_linked' | 'loading' | 'unavailable' | 'unsupported';
        serviceName: string;
        /** Whether the service's own actions (find, linked Homes, sign out) can be opened. */
        canOpenAccount: boolean;
    }>;

/** Who the person is to the account service this Home points at, named by the service's name owner. */
export function resolveAccountServiceIdentity(input: Readonly<{
    entryStatus: AccountServiceEntryOptions['status'];
    credentialReadKind: AccountServiceSignIn['credentialReadKind'];
    serviceName: string | null;
    /** The Home is its own sign-in service (`effectiveSignInService.kind === 'self'`). */
    selfService: boolean;
    /** Whether the Home's sign-in policy has been read; until then "not offered" means "not known". */
    policyReady: boolean;
    /** The policy read failed or the Home's reachability owner judges it unreachable. */
    policyUnavailable?: boolean;
}>): AccountServiceIdentity {
    if (input.entryStatus === 'not_offered') {
        if (input.policyReady) return { kind: 'no_service', canOpenAccount: false };
        return { kind: input.policyUnavailable ? 'status_unavailable' : 'pending', canOpenAccount: false };
    }
    const serviceName = input.serviceName ?? t('welcome.yourSignInService');
    if (input.selfService) return { kind: 'self', serviceName, canOpenAccount: input.entryStatus === 'ready' };
    switch (input.entryStatus) {
        case 'ready':
            switch (input.credentialReadKind) {
                case 'valid':
                    return { kind: 'signed_in', serviceName, canOpenAccount: true };
                case 'absent':
                    return { kind: 'not_linked', serviceName, canOpenAccount: true };
                case 'corrupt':
                case 'unavailable':
                    return { kind: 'status_unavailable', canOpenAccount: false };
                case null:
                    return { kind: 'pending', canOpenAccount: false };
            }
        case 'loading':
            return { kind: 'loading', serviceName, canOpenAccount: false };
        case 'unsupported':
            return { kind: 'unsupported', serviceName, canOpenAccount: false };
        default:
            return { kind: 'unavailable', serviceName, canOpenAccount: false };
    }
}

/**
 * Where the person stands with the Home's account service, in one line: the account popover's
 * identity row and the Settings Overview header both say it from here, so they cannot disagree.
 * `signedInAs: 'name'` names the service alone (the popover shows its mark beside it); `'sentence'`
 * says "Signed in to …" where no mark stands beside it.
 */
export function describeAccountServiceIdentity(identity: AccountServiceIdentity, signedInAs: 'name' | 'sentence'): string {
    switch (identity.kind) {
        case 'pending':
            return t('accountPopover.checkingSignIn');
        case 'status_unavailable':
            return t('accountPopover.signInStatusUnavailable');
        case 'no_service':
        case 'self':
            return t('accountPopover.signedInToThisHome');
        case 'not_linked':
            return t('accountPopover.notLinkedTo', { service: identity.serviceName });
        case 'unavailable':
            return t('accountPopover.serviceUnavailable', { service: identity.serviceName });
        case 'unsupported':
            return t('welcome.signInServiceUnsupportedTitle');
        case 'signed_in':
            return signedInAs === 'sentence'
                ? t('settingsOverview.accountServiceSignedIn', { service: identity.serviceName })
                : identity.serviceName;
        case 'loading':
            return identity.serviceName;
    }
}

export type LinkCurrentHomeOffer = Readonly<{
    /** `link_service` while not signed in to the service; `make_available` once signed in. */
    kind: 'link_service' | 'make_available';
    homeServerIdentityId: string;
}>;

/**
 * Whether the exact current Home can be linked to the service (Lane 02's `link` intent). Offered
 * until the signed-in Directory shows the Home as linked.
 */
export function resolveLinkCurrentHomeOffer(input: Readonly<{
    serviceReady: boolean;
    /** Linking a Home to itself does not apply. */
    selfService: boolean;
    currentHomeServerIdentityId: string | null;
    signedIn: boolean;
    directoryReady: boolean;
    currentHomeIsLinked: boolean;
}>): LinkCurrentHomeOffer | null {
    if (!input.serviceReady || input.selfService || !input.currentHomeServerIdentityId) return null;
    if (input.signedIn && input.directoryReady && input.currentHomeIsLinked) return null;
    return {
        kind: input.signedIn ? 'make_available' : 'link_service',
        homeServerIdentityId: input.currentHomeServerIdentityId,
    };
}
