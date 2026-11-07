import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { ConnectedServicesIndexAccount, ConnectedServicesIndexSheet } from '../model/buildConnectedServicesIndexModel';
import { presentConnectedServicesIndexAccount } from '../model/presentConnectedServicesIndexAccount';

export const connectedServicesColumnAdapter = defineSettingsCollectionAdapter(['service', 'status']);

/** Uses the same privacy presenter as the existing rail and All services rows. */
export function connectedAccountColumnFacts(input: Readonly<{
    sheet: ConnectedServicesIndexSheet;
    account: ConnectedServicesIndexAccount;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    present: ConnectedAccountIdentityPresenter;
}>): SettingsCollectionRowFacts<'service' | 'status'> {
    const { sheet, account } = input;
    const presentation = presentConnectedServicesIndexAccount(sheet, account, input.labelsByKey, input.present);
    const status = parseDisplayableCredentialHealthStatus(account.status);
    return {
        key: `${sheet.serviceKey}:${account.accountId}`, title: presentation.title,
        context: presentation.identityLabel, status,
        fields: { service: [sheet.serviceKey], status: status ? [status] : null },
    };
}
