import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { QualifiedConnectedAccountPresentationAccount } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { ConnectedAccountAccessMode } from './presentConnectedAccountAccessMode';
import { resolveConnectedAccountAccessMode } from './resolveConnectedAccountAccessMode';

import type {
    ConnectedServicesIndexAccount,
    ConnectedServicesIndexPool,
    ConnectedServicesIndexSheet,
} from './buildConnectedServicesIndexModel';

export type ConnectedServicesIndexAccountPresentation = Readonly<{
    /** The account's name (the label someone gave it, else its identity). */
    title: string;
    /** Human identity or a short disambiguator beside the name. */
    identityLabel: string | null;
    /** Raw provider account id, for the detail header. */
    accountIdLabel: string | null;
    /**
     * A Credentials row's title: a subscription's email (as the privacy presenter shows it), so every
     * account of every service reads the same way; a key, or an account without an email, keeps `title`.
     */
    listTitle: string;
    /** The name someone gave an account whose row leads with its email, said beside its plan; else null. */
    listName: string | null;
    /** The producing account's mode; usage readers may fill unknown subscriptions. */
    accessMode: ConnectedAccountAccessMode | null;
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
    const accountLabelsByAccountId: Record<string, string> = {};
    // Naming considers all accounts together; adapt every released profile's
    // personal label so a named sibling is not counted as an unnamed account.
    for (const candidate of sheet.accounts) {
        if (candidate.kind !== 'legacy') continue;
        const label = resolveConnectedServiceProfileLabel({
            labelsByKey,
            serviceId: candidate.legacyServiceId,
            profileId: candidate.accountId,
        });
        if (label) accountLabelsByAccountId[candidate.accountId] = label;
    }
    // Released V2 is an input adapter to the same identity owner, not a second
    // rule for whether provider/internal ids may become a name.
    const profile: QualifiedConnectedAccountPresentationAccount = account.kind === 'qualified' ? account.profile : {
        ref: { service: sheet.service, accountId: account.accountId },
        providerIdentity: {
            email: account.identityLabelKind === 'email' ? account.identityLabel : null,
            accountId: account.identityLabelKind === 'accountId' ? account.identityLabel : null,
        },
    };
    const presentation = presentQualifiedConnectedAccountTarget({
        target: { kind: 'account', account: profile.ref },
        accounts: sheet.accounts.map((candidate): QualifiedConnectedAccountPresentationAccount => candidate.kind === 'qualified' ? candidate.profile : {
            ref: { service: sheet.service, accountId: candidate.accountId },
            providerIdentity: {
                email: candidate.identityLabelKind === 'email' ? candidate.identityLabel : null,
                accountId: candidate.identityLabelKind === 'accountId' ? candidate.identityLabel : null,
            },
        }),
        groups: [],
        labelsByKey,
        accountLabelsByAccountId,
        serviceTitle: sheet.label,
        presentIdentity: present,
    });
    const providerAccountId = profile.providerIdentity?.accountId?.trim() || null;
    const providerEmail = profile.providerIdentity?.email?.trim() || null;
    const shown = present({ accountId: providerAccountId, email: providerEmail });
    const title = presentation.primaryLabel;
    const identityLabel = presentation.identityLabel ?? null;
    const accessMode = account.kind === 'qualified' ? resolveConnectedAccountAccessMode(account.profile) : null;
    const isKey = accessMode?.kind === 'apiKey';
    // The naming owner already put the shown email beside a name; a row turns that pair around.
    const leadsWithEmail = !isKey && shown.email !== null && identityLabel === shown.email;
    return {
        title,
        identityLabel,
        accountIdLabel: account.kind === 'qualified' ? shown.accountId : null,
        listTitle: leadsWithEmail ? identityLabel : title,
        listName: leadsWithEmail ? title : null,
        accessMode,
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
