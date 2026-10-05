import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
    useConnectedAccountIdentityPrivacy,
    type ConnectedAccountIdentityPresenter,
} from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountPresentationAccount,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';

const TEST_ID = 'connected-services-pool-draft';

/** An account the new pool can switch between, as the page already names it. */
export type QualifiedPoolDraftAccount = Readonly<{
    accountId: string;
    name: string;
    nameKind?: QualifiedConnectedAccountTargetPresentation['primaryLabelKind'];
    email: string | null;
}>;

/**
 * A new pool before it exists (lab `csvc` rail Pools "+", `COLLECTION-REQUIREMENTS.md` §2.2): the
 * page a saved pool has, reduced to what creating one needs — its name (the title follows the typing)
 * and the accounts it switches between. Nothing is written until Create; Discard leaves.
 */
export const QualifiedPoolDraftView = React.memo(function QualifiedPoolDraftView(props: Readonly<{
    serviceLabel: string;
    accounts: readonly QualifiedPoolDraftAccount[];
    presentIdentity: ConnectedAccountIdentityPresenter;
    creating: boolean;
    onCreate: (input: Readonly<{ displayName: string; accountIds: readonly string[] }>) => void;
    onDiscard: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [name, setName] = React.useState('');
    const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
    const trimmed = name.trim();
    const toggle = React.useCallback((accountId: string) => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(accountId)) next.delete(accountId);
            else next.add(accountId);
            return next;
        });
    }, []);

    return (
        <ItemList testID={TEST_ID}>
            <SettingsPageHeader
                title={trimmed || t('connectedServicesPool.newPoolTitle')}
                alwaysShowTitle
                description={t('connectedServicesPool.newPoolDescription', { service: props.serviceLabel })}
                leading={(
                    <PageHeaderMarkSlot>
                        <Icon name="stack" size={26} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
            />
            <ItemGroup>
                <FieldValueItem
                    testID={`${TEST_ID}:name`}
                    fieldTestID={`${TEST_ID}:name:field`}
                    title={t('connectedServicesPool.nameTitle')}
                    placeholder={t('connectedServicesPool.namePlaceholder')}
                    value={name}
                    allowEmpty
                    autoFocus
                    onDraftChange={setName}
                    onCommit={(draft) => { setName(draft); }}
                />
            </ItemGroup>
            <ItemGroup
                title={t('connectedServicesPool.membersTitle')}
                description={t('connectedServicesPool.draftMembersDescription')}
            >
                {props.accounts.map((account) => {
                    const checked = selected.has(account.accountId);
                    const shown = props.presentIdentity({ label: account.name, labelKind: account.nameKind, email: account.email });
                    return (
                        <Item
                            key={account.accountId}
                            testID={`${TEST_ID}:member:${account.accountId}`}
                            title={shown.label ?? account.name}
                            subtitle={shown.email ?? undefined}
                            leftElement={(
                                <Icon
                                    name={checked ? 'check-square' : 'square'}
                                    size={20}
                                    weight={checked ? 'fill' : 'regular'}
                                    color={checked ? theme.colors.text.primary : theme.colors.text.tertiary}
                                />
                            )}
                            accessibilityRole="checkbox"
                            selected={checked}
                            onPress={() => toggle(account.accountId)}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>
            <ItemGroup surface="none">
                <View style={styles.actions}>
                    <RoundButton
                        testID={`${TEST_ID}:create`}
                        size="small"
                        title={t('connectedServicesPool.create')}
                        disabled={trimmed.length === 0 || props.creating}
                        loading={props.creating}
                        onPress={() => props.onCreate({
                            displayName: trimmed,
                            accountIds: props.accounts.map((account) => account.accountId).filter((id) => selected.has(id)),
                        })}
                    />
                    <RoundButton
                        testID={`${TEST_ID}:discard`}
                        size="small"
                        display="secondary"
                        title={t('connectedServicesPool.discard')}
                        onPress={props.onDiscard}
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
});

const stylesheet = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
}));

/**
 * The live new-pool draft: names this service's accounts through the canonical presenter and renders
 * identities through the one privacy presenter.
 */
export const QualifiedPoolDraft = React.memo(function QualifiedPoolDraft(props: Readonly<{
    serviceLabel: string;
    accounts: ReadonlyArray<QualifiedConnectedAccountPresentationAccount>;
    accountLabels: Readonly<Record<string, string | undefined>>;
    creating: boolean;
    onCreate: (input: Readonly<{ displayName: string; accountIds: readonly string[] }>) => void;
    onDiscard: () => void;
}>) {
    const { present } = useConnectedAccountIdentityPrivacy();
    const { accounts, accountLabels, serviceLabel } = props;
    const draftAccounts = React.useMemo(() => accounts.map((account) => {
        const presentation = presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: account.ref },
            accounts,
            groups: [],
            labelsByKey: {},
            accountLabel: accountLabels[account.ref.accountId],
            serviceTitle: serviceLabel,
        });
        const name = presentation.primaryLabel;
        const email = account.providerIdentity?.email?.trim() || null;
        return { accountId: account.ref.accountId, name, nameKind: presentation.primaryLabelKind, email: email && email !== name ? email : null };
    }), [accountLabels, accounts, serviceLabel]);
    return (
        <QualifiedPoolDraftView
            serviceLabel={serviceLabel}
            accounts={draftAccounts}
            presentIdentity={present}
            creating={props.creating}
            onCreate={props.onCreate}
            onDiscard={props.onDiscard}
        />
    );
});
