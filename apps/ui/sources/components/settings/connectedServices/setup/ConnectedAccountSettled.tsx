import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useQualifiedConnectedAccountGroups } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import type { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { selectConnectedAccountSettleOffer, type ConnectedAccountSettleOffer } from './selectConnectedAccountSettleOffer';
import { suggestAgentDefaultForNewAccount } from './suggestAgentDefaultForNewAccount';

type AgentEntries = ReturnType<typeof useConnectedServicesIndex>['agentEntries'];

function sameService(left: Readonly<{ pluginId: string; localId: string }>, right: Readonly<{ pluginId: string; localId: string }>): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/** Server-backed pools (V4) are reachable without a machine; the pool owner lists and writes them. */
const V4_POOLS_PEER = { status: 'ready' as const, transport: { protocol: 'v4' as const }, errorCode: null };

/**
 * Where a connect settles (lab `csvc` A5), under the new account's row: who it connected as (through
 * the one identity presenter, so the privacy setting holds) and the next step — join the pool an
 * agent signs in through ("so Codex moves to it when Personal runs out"), or, where the service has
 * no pool, become an agent's default. Dismissing changes nothing.
 */
export function ConnectedAccountSettled(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    model: ConnectedServicesIndexModel;
    agents: AgentEntries;
    machineId?: string;
    onDismiss: () => void;
    testID?: string;
}>) {
    const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
    const { catalog: purposeCatalog, legacySettings, mutateDefaults } = useConnectedAccountPurposeDefaults();
    const { present } = useConnectedAccountIdentityPrivacy();
    const { account, onDismiss } = props;
    const sheet = props.model.sheets.find((candidate) => sameService(candidate.service, account.service)) ?? null;
    const profiles = sheet?.accounts.flatMap((candidate) => candidate.kind === 'qualified' ? [candidate.profile] : []) ?? [];
    const profile = profiles.find((candidate) => candidate.ref.accountId === account.accountId) ?? null;

    const labelFor = (accountId: string): string | null => {
        const match = profiles.find((candidate) => candidate.ref.accountId === accountId);
        if (!match || !sheet) return null;
        const presented = presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: match.ref },
            accounts: [match],
            groups: [],
            labelsByKey,
            serviceTitle: sheet.label,
        });
        return present({ label: presented.primaryLabel, labelKind: presented.primaryLabelKind }).label;
    };
    const identity = profile
        ? (() => {
            const shown = present({
                label: profile.displayName ?? null,
                email: profile.providerIdentity?.email ?? null,
                accountId: profile.providerIdentity?.accountId ?? null,
            });
            return shown.email ?? shown.label ?? shown.accountId;
        })()
        : null;

    const agentDefault = purposeCatalog.status === 'ready' && !purposeCatalog.stale && purposeCatalog.value ? suggestAgentDefaultForNewAccount({
        agents: props.agents,
        settings: legacySettings,
        purposeBindings: purposeCatalog.value,
        account,
    }) : null;
    const offer = selectConnectedAccountSettleOffer({
        account,
        pools: sheet?.pools ?? [],
        agentDefault,
        labelFor,
    });

    const primaryAction = offer?.kind === 'pool' ? (
        <AddToPoolButton account={account} offer={offer} onDone={onDismiss} />
    ) : offer?.kind === 'agentDefault' ? (
        <RoundButton
            testID="connected-services-settle:use"
            size="small"
            title={t('connectedServicesSettings.settleUseForAction', { agent: offer.agentTitle })}
            onPress={async () => {
                try {
                    const written = await mutateDefaults({ kind: 'service', input: {
                        agentId: offer.agentId, service: account.service,
                        ...(props.machineId ? { machineId: props.machineId } : {}),
                        selection: { source: 'connected', selection: 'profile', profileId: account.accountId }, onlyIfUnset: true,
                    } });
                    if (written) onDismiss();
                } catch {
                    Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable'));
                }
            }}
        />
    ) : null;
    return <ConnectedAccountSettledView identity={identity} offer={offer} primaryAction={primaryAction} onDismiss={onDismiss} testID={props.testID} />;
}

/** The shared settle presentation; specimens provide their own simulated action, never live pools. */
export function ConnectedAccountSettledView(props: Readonly<{
    identity: string | null;
    offer: ConnectedAccountSettleOffer | null;
    primaryAction: React.ReactNode;
    onDismiss: () => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const { identity, offer, onDismiss } = props;
    return (
        <View
            testID={props.testID ?? 'connected-services-settle'}
            style={styles.row}
            accessibilityRole="summary"
            accessibilityLiveRegion="polite"
        >
            <Icon name="check-circle" size={15} color={theme.colors.state.success.foreground} />
            <Text style={styles.text}>
                <Text style={styles.strong}>
                    {identity
                        ? t('connectedServicesSettings.settleConnectedAs', { identity })
                        : t('connectedServicesSettings.settleConnected')}
                </Text>
                {offer ? ` ${describeOffer(offer)}` : ''}
            </Text>
            <View style={styles.actions}>
                {offer ? (
                    <RoundButton
                        testID="connected-services-settle:not-now"
                        size="small"
                        display="secondary"
                        title={t('connectedServicesSettings.notNow')}
                        onPress={onDismiss}
                    />
                ) : (
                    <RoundButton
                        testID="connected-services-settle:done"
                        size="small"
                        display="secondary"
                        title={t('common.done')}
                        onPress={onDismiss}
                    />
                )}
                {props.primaryAction}
            </View>
        </View>
    );
}

function describeOffer(offer: ConnectedAccountSettleOffer): string {
    if (offer.kind === 'agentDefault') return t('connectedServicesSettings.settleUseFor', { agent: offer.agentTitle });
    return offer.agentTitle && offer.activeLabel
        ? t('connectedServicesSetup.settleAddToPoolWhy', { pool: offer.poolName, agent: offer.agentTitle, active: offer.activeLabel })
        : t('connectedServicesSetup.settleAddToPoolShort', { pool: offer.poolName });
}

/** Adds the account to the pool through the pool owner; mounted only while a pool is offered. */
function AddToPoolButton(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    offer: Extract<ConnectedAccountSettleOffer, { kind: 'pool' }>;
    onDone: () => void;
}>) {
    const scope = useActiveServerAccountScope();
    const pools = useQualifiedConnectedAccountGroups({
        serverId: scope?.serverId ?? '',
        service: props.account.service,
        peer: V4_POOLS_PEER,
    });
    const group = pools.groups.find((candidate) => candidate.ref.groupId === props.offer.groupId) ?? null;
    const [failed, setFailed] = React.useState(false);
    return (
        <RoundButton
            testID="connected-services-settle:add-to-pool"
            size="small"
            title={failed && pools.error ? pools.error : t('connectedServicesSetup.settleAddToPool', { pool: props.offer.poolName })}
            loading={pools.mutating || pools.status === 'loading'}
            disabled={!group || pools.mutating}
            onPress={async () => {
                if (!group) return;
                const next = await pools.addMember({ group, account: props.account });
                if (next) props.onDone();
                else setFailed(true);
            }}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 10,
        paddingVertical: 10,
        paddingRight: 14,
        paddingLeft: 32,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.state.success.background,
    },
    text: {
        ...Typography.default(),
        flex: 1,
        minWidth: 200,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    strong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
