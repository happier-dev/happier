import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PluginSecretSourceFieldV1 } from '@happier-dev/protocol/plugins/contributions/public-types';

import {
    SavedSecretVaultFields,
    SavedSecretVaultItemsField,
    type SavedSecretVaultChoice,
    type SavedSecretVaultItemSelection,
} from '@/components/secrets/vault/SavedSecretVaultFields';
import { SavedSecretVaultExportResults } from '@/components/secrets/vault/SavedSecretVaultExportSheet';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';

/**
 * Dev-only specimen of the vault flows (CRED-VAULT-BULK) at static props: a listed 1Password account
 * with two vaults, the item checklist, and an export's per-secret results. No vault is read.
 */
const PROVIDER = '1Password';
const NOOP = () => undefined;
const field = (vault: [string, string], item: [string, string], fieldId: string, title: string): PluginSecretSourceFieldV1 => ({
    account: 'maya@example.com', reference: `op://${vault[1]}/${item[1]}/${fieldId}`,
    vault: { id: vault[0], name: vault[1] }, item: { id: item[0], title: item[1] }, field: { id: fieldId, title, kind: 'concealed' },
});
const PRIVATE: [string, string] = ['v1', 'Private'];
const WORK: [string, string] = ['v2', 'Work'];
const FIELDS: readonly PluginSecretSourceFieldV1[] = [
    field(WORK, ['i1', 'GitHub'], 'token', 'token'),
    field(WORK, ['i2', 'OpenAI'], 'credential', 'API key'),
    field(WORK, ['i3', 'Sentry'], 'dsn', 'DSN'),
    field(WORK, ['i3', 'Sentry'], 'auth', 'auth token'),
    field(WORK, ['i4', 'Stripe test'], 'secret', 'secret key'),
    field(PRIVATE, ['i5', 'Home Assistant'], 'token', 'token'),
];

function useStaticChoice(): SavedSecretVaultChoice {
    const [vaultId, setVaultId] = React.useState<string | null>('v2');
    const vaults = [{ id: 'v1', name: 'Private' }, { id: 'v2', name: 'Work' }];
    const vault = vaults.find(candidate => candidate.id === vaultId) ?? vaults[0]!;
    const items = [...new Map(FIELDS.filter(entry => entry.vault.id === vault.id).map(entry => [entry.item.id, {
        id: entry.item.id, title: entry.item.title, fieldCount: FIELDS.filter(other => other.item.id === entry.item.id).length,
    }])).values()];
    return { account: 'maya@example.com', setAccount: NOOP, commit: NOOP, current: true, state: { status: 'ready', fields: FIELDS },
        reload: NOOP, vaults, vault, setVaultId, items, dirty: true,
        target: { contribution: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' }, account: 'maya@example.com', vaultId: vault.id } };
}

export function SecretVaultSpecimen() {
    const choice = useStaticChoice();
    const [selection, setSelection] = React.useState<SavedSecretVaultItemSelection>(() => new Set(['i1', 'i3']));
    const names: Record<string, string> = { 'secret:a': 'OpenAI API key', 'secret:b': 'Sentry DSN', 'secret:c': 'Linear token' };
    return (
        <ItemList>
            <ItemGroup title="Link existing items" description="Create editor, 1Password origin, vault read.">
                <SectionContentRow>
                    <View style={styles.fields}>
                        <SavedSecretVaultFields choice={choice} provider={PROVIDER} testID="specimen-vault" />
                        {choice.vault ? <SavedSecretVaultItemsField vault={choice.vault} items={choice.items} selection={selection}
                            onChange={setSelection} testID="specimen-vault-items" /> : null}
                        <View style={styles.actions}>
                            <RoundButton display="secondary" title={t('common.cancel')} onPress={NOOP} />
                            <RoundButton title={selection === 'all' ? t('secretsSettings.vaultLinkAll', { vault: choice.vault?.name ?? '' })
                                : t('secretsSettings.vaultLinkCount', { count: selection.size })} onPress={NOOP} />
                        </View>
                    </View>
                </SectionContentRow>
            </ItemGroup>
            <SavedSecretVaultExportResults provider={PROVIDER} vault="Work" nameOf={(ref) => names[ref] ?? ref} results={[
                { secretId: 'a', secretRef: 'secret:a', status: 'exported', updatedAt: 4 },
                { secretId: 'b', secretRef: 'secret:b', status: 'exported', updatedAt: 2 },
                { secretId: 'c', secretRef: 'secret:c', status: 'failed', code: 'authentication_required', repair: 'unlock' },
            ]} />
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    fields: { gap: theme.space.s12, width: '100%', paddingVertical: theme.space.s8 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s8 },
}));
