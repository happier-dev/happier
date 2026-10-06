import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

import type {
    ConnectedServicesIndexAccount,
    ConnectedServicesIndexPool,
    ConnectedServicesIndexSheet,
} from './buildConnectedServicesIndexModel';

export type ConnectedServicesIndexAccountPresentation = Readonly<{
    /** The account's name (the label someone gave it, else its identity). */
    title: string;
    /** Who it is beside the name (email or provider account id), when that is not the name itself. */
    identityLabel: string | null;
    /** Raw provider account id, for the detail header. */
    accountIdLabel: string | null;
}>;

/**
 * An account on the Connected services collection (rail, index rows and cards): its name and who it is,
 * inside its service (the service name is already said). Identities go through the one privacy
 * presenter, so "Hide account emails and IDs" applies wherever this is shown.
 */
export function presentConnectedServicesIndexAccount(
    sheet: ConnectedServicesIndexSheet,
    account: ConnectedServicesIndexAccount,
    labelsByKey: Readonly<Record<string, string | undefined>>,
    present: ConnectedAccountIdentityPresenter,
): ConnectedServicesIndexAccountPresentation {
    if (account.kind === 'legacy') {
        const label = resolveConnectedServiceProfileLabel({
            labelsByKey,
            serviceId: account.legacyServiceId,
            profileId: account.accountId,
        });
        // Preserve the released producer field rather than guessing from how its text looks.
        const shown = present({
            label,
            email: account.identityLabelKind === 'email' ? account.identityLabel : null,
            accountId: account.identityLabelKind === 'accountId' ? account.identityLabel
                : account.identityLabelKind === null ? account.accountId : null,
        });
        return {
            title: shown.label ?? shown.email ?? shown.accountId ?? sheet.label,
            identityLabel: label && account.identityLabel ? shown.email ?? shown.accountId : null,
            accountIdLabel: null,
        };
    }
    const profiles = sheet.accounts.flatMap((candidate) => candidate.kind === 'qualified' ? [candidate.profile] : []);
    const presentation = presentQualifiedConnectedAccountTarget({
        target: { kind: 'account', account: account.profile.ref },
        accounts: profiles,
        groups: [],
        labelsByKey,
        legacyServiceId: sheet.legacyServiceId,
        serviceTitle: sheet.label,
    });
    const email = account.profile.providerIdentity?.email?.trim() || null;
    const providerAccountId = account.profile.providerIdentity?.accountId?.trim() || null;
    const shown = present({ label: presentation.primaryLabel, labelKind: presentation.primaryLabelKind, email, accountId: providerAccountId });
    const identity = email
        ? email !== presentation.primaryLabel ? shown.email : null
        : providerAccountId && providerAccountId !== presentation.primaryLabel ? shown.accountId : null;
    return {
        title: shown.label ?? presentation.primaryLabel,
        identityLabel: identity,
        accountIdLabel: shown.accountId,
    };
}

/** A pool's name, through the one qualified-target presenter. */
export function presentConnectedServicesIndexPool(
    sheet: ConnectedServicesIndexSheet,
    pool: ConnectedServicesIndexPool,
    labelsByKey: Readonly<Record<string, string | undefined>>,
): string {
    const profiles = sheet.accounts.flatMap((candidate) => candidate.kind === 'qualified' ? [candidate.profile] : []);
    return presentQualifiedConnectedAccountTarget({
        target: { kind: 'group', service: sheet.service, groupId: pool.ref.groupId },
        accounts: profiles,
        groups: [pool],
        labelsByKey,
        serviceTitle: sheet.label,
    }).primaryLabel;
}
