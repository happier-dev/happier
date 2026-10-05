import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { t } from '@/text';

import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog } from '../setup/buildConnectedServiceSetupCatalog';
import type { ConnectedServicesIndexConnectable } from '../model/buildConnectedServicesIndexModel';
import {
    ConnectedServiceSetupPanel,
    type ConnectedServiceSetupCatalogEntry,
    type ConnectedServiceSetupPanelProps,
    type ConnectedServiceSetupTarget,
} from '../setup/ConnectedServiceSetupPanel';
import {
    HOME_CONNECT_INVITATION_STEP_ID,
    homeConnectServiceStepId,
    selectHomeConnectInvitations,
    type HomeConnectInvitations,
} from './selectHomeConnectInvitations';

/**
 * Home's Get set up block for connected services (lab `csvc` H2): "Connect Claude or ChatGPT", their
 * marks, the promise, Connect — which grows the setup panel in place through the set-up block morph
 * (the catalog when several services are offered, the one service's sign-in otherwise). What is
 * offered is `selectHomeConnectInvitations` over the index this launch already holds (a hub never asks
 * a machine); its ✕ keeps the invitation's own dismissal ids on the Account's Home layout. Null when
 * there is nothing to offer.
 */
export function useConnectServicesSetupItem(input: Readonly<{ layout: 'card' | 'row' }>): SetupBlockItem | null {
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached' });
    const { hidden, dismiss } = useHomeSetupDismissals();
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget | null>(null);
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(indexModel), [indexModel]);
    const hasAccounts = indexModel.sheets.some((sheet) => sheet.accounts.length > 0);
    const offer = selectHomeConnectInvitations({ connectable: indexModel.connectable, hidden, hasAccounts });
    return buildConnectServicesSetupItem({ offer, catalog, layout: input.layout, target, setTarget, dismiss });
}

/**
 * The block itself, from what is offered (the hook above; the dev frames pass fixtures). `next` names
 * one service and the agents that would use it (lab H2b); `invite` names the first two (H2).
 */
export function buildConnectServicesSetupItem(input: Readonly<{
    offer: HomeConnectInvitations<ConnectedServicesIndexConnectable>;
    catalog: readonly ConnectedServiceSetupCatalogEntry[];
    layout: 'card' | 'row';
    target: ConnectedServiceSetupTarget | null;
    setTarget: (target: ConnectedServiceSetupTarget | null) => void;
    dismiss: (stepId: string) => void;
    renderServiceFlow?: ConnectedServiceSetupPanelProps['renderServiceFlow'];
    targetSelection?: ConnectedServiceSetupPanelProps['targetSelection'];
}>): SetupBlockItem | null {
    const { offer, layout, target, setTarget, dismiss } = input;
    const services = offer.kind === 'none' ? [] : offer.kind === 'next' ? [offer.service] : offer.services;
    if (services.length === 0) return null;
    const offeredKeys = new Set(services.map((service) => service.serviceKey));
    // Home offers only what the block names (the subscriptions your agents accept, lab H2c).
    const catalog = input.catalog.filter((entry) => offeredKeys.has(entry.serviceKey));
    const [first, second] = services;
    const title = t('homeSetup.connectServicesTitle', { first: first!.label, second: second?.label ?? null });
    const dismissId = offer.kind === 'next' ? homeConnectServiceStepId(first!.serviceKey) : HOME_CONNECT_INVITATION_STEP_ID;
    const startTarget: ConnectedServiceSetupTarget = services.length > 1
        ? { kind: 'catalog' }
        : { kind: 'service', serviceKey: first!.serviceKey };
    return {
        id: HOME_CONNECT_INVITATION_STEP_ID,
        renderTile: ({ open }) => (
            <SetupBlockTile
                testID="hub-setup.connectServices"
                layout={layout}
                glyph={(
                    <View style={styles.marks}>
                        {services.slice(0, 2).map((service) => (
                            <ConnectedServiceMark key={service.serviceKey} legacyServiceId={service.entry.legacyServiceId} size="inline" />
                        ))}
                    </View>
                )}
                title={title}
                subtitle={offer.kind === 'next' && first!.usedBy.length > 0
                    ? t('connectedServicesSetup.homeNextSubtitle', { agents: formatAgentNames(first!.usedBy) })
                    : t('homeSetup.connectServicesSubtitle')}
                action={{
                    label: t('connectedServicesSettings.connect'),
                    testID: 'hub-setup.connectServices.action',
                    onPress: () => {
                        setTarget(startTarget);
                        open();
                    },
                }}
                dismiss={{
                    label: t('homeSetup.dismiss', { title }),
                    tooltip: t('homeSetup.dismissTooltip'),
                    onPress: () => dismiss(dismissId),
                }}
            />
        ),
        renderPanel: ({ close }) => {
            const finish = () => {
                setTarget(null);
                close();
            };
            return (
                <ConnectedServiceSetupPanel
                    testID="hub-setup.connectServices:setup"
                    scope="home"
                    target={target ?? startTarget}
                    catalog={catalog}
                    onTargetChange={setTarget}
                    onClose={finish}
                    onConnected={finish}
                    renderServiceFlow={input.renderServiceFlow}
                    targetSelection={input.targetSelection}
                />
            );
        },
    };
}

const styles = StyleSheet.create(() => ({
    marks: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));
