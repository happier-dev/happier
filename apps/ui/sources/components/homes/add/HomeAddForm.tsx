import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SetupPathPanel, type SetupPath } from '@/components/ui/setupBlocks/SetupPathPanel';
import { canSetUpServerHomeHere } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { DirectHomePathPane } from '../journeys/alreadyUse/DirectHomePathPane';
import { HomeSignInPane } from '../journeys/alreadyUse/HomeSignInPane';
import { OtherServicePathPane } from '../journeys/alreadyUse/OtherServicePathPane';
import { ServicePathPane } from '../journeys/alreadyUse/ServicePathPane';
import { UseServiceAsHomeBody } from '../journeys/serviceHome/UseServiceAsHomeSheet';
import { PaneLink } from '../journeys/alreadyUse/journeyPaneKit';
import { useJourneyAccountService, type JourneyAccountService } from '../journeys/useJourneyAccountService';
import { addHomePathOfPane, type AddHomePath } from './addHomeFlowModel';
import { ConnectedHomePane } from './ConnectedHomePane';
import { ServerHomePane } from './ServerHomePane';
import { useAddHomeFlow } from './useAddHomeFlow';

/**
 * `page`: Settings → Homes' draft (every path as a card). `panel`: Home's "Already use Happier?" block
 * (the three ways into Homes you already use, plus "have one hosted" as a quiet link). `sheet`: one path's
 * pane on its own, for the phone doorway whose buttons are the paths.
 */
export type HomeAddFormLayout = 'page' | 'panel' | 'sheet';

/** The paths of "Already use Happier?": ways into Homes someone already has. */
const ALREADY_USE_PATHS: ReadonlySet<AddHomePath> = new Set(['service', 'other_service', 'direct']);

function pathPresentation(service: JourneyAccountService, path: AddHomePath, color: string): Omit<SetupPath<AddHomePath>, 'id'> {
    const serviceUrl = service.discovery?.endpointUrl ?? service.entry.endpoint.url;
    switch (path) {
        case 'service':
            return {
                glyph: <AccountServiceMark url={serviceUrl} size={17} />,
                title: t('homesJourneys.pathServiceTitle', { service: service.name }),
                subtitle: t('homesJourneys.pathServiceSubtitle'),
            };
        case 'other_service':
            return {
                glyph: <Icon name="globe" size={17} color={color} />,
                title: t('homesJourneys.pathOtherServiceTitle'),
                subtitle: t('homesJourneys.pathOtherServiceSubtitle'),
            };
        case 'direct':
            return {
                glyph: <Icon name="hard-drives" size={17} color={color} />,
                title: t('homesJourneys.pathDirectTitle'),
                subtitle: t('homesJourneys.pathDirectSubtitle'),
            };
        case 'use_service_as_home':
            return {
                glyph: <AccountServiceMark url={serviceUrl} size={17} />,
                title: t('homesJourneys.useServiceAsAHome', { service: service.name }),
                subtitle: t('homesJourneys.addServiceAsHomeSubtitle'),
            };
        case 'server_home':
            return {
                glyph: <Icon name="desktop" size={17} color={color} />,
                title: t('homesJourneys.addServerHome'),
                subtitle: t('homesJourneys.addServerHomeSubtitle'),
            };
    }
}

/**
 * Add a Home: the one form, in two frames. `panel` is Home's opened "Already use Happier?" block
 * (paths in a column, or chips when narrow); `page` is Settings → Homes' draft (paths as cards above
 * the pane). One path model (`useAddHomeFlow`) decides which paths this device can take, the
 * hand-overs between them and, once a Home is connected, whether this device switches to it.
 */
export function HomeAddForm(props: Readonly<{
    layout: HomeAddFormLayout;
    testID: string;
    initialPath?: AddHomePath;
    /** An address to start with; the explicit path wins, otherwise it opens Direct. */
    initialAddress?: string;
    /** The form is finished or abandoned (the block folds, the draft is discarded). */
    onClose: () => void;
    /** Whether the device switched to the Home it just connected (then the form has nothing left to show). */
    onFocusedHome?: () => void;
    /** "Show All Homes" after a Home joined an existing set. */
    onShowAllHomes?: () => void;
    /** The address typed into "Connect to a Home directly" (the Settings draft row shows it). */
    onAddressChange?: (address: string) => void;
}>) {
    const { theme } = useUnistyles();
    const phone = useViewportClass() === 'compact';
    const service = useJourneyAccountService();
    const flow = useAddHomeFlow({
        serviceStatus: service.entry.status,
        serviceHostsHome: service.hostsHome,
        canSetUpServerHome: canSetUpServerHomeHere(),
        initialPath: props.initialPath ?? (props.initialAddress ? 'direct' : 'service'),
        initialAddress: props.initialAddress,
    });
    const { onClose, onFocusedHome, onShowAllHomes } = props;

    const paths = React.useMemo(() => flow.paths.map((availability): SetupPath<AddHomePath> => ({
        id: availability.id,
        ...pathPresentation(service, availability.id, theme.colors.text.secondary),
    })), [flow.paths, service, theme.colors.text.secondary]);
    const active = addHomePathOfPane(flow.pane.pane);
    const phonePaths = phone && props.layout === 'page' ? (
        <ListPresentationProvider value="page">
            <View accessibilityRole="radiogroup">
                <ItemGroup>
                    {paths.map((path) => (
                        <Item key={path.id} testID={`${props.testID}.path.${path.id}`} title={path.title}
                            subtitle={path.subtitle} subtitleLines={0} icon={path.glyph}
                            accessibilityRole="radio" webRole="radio" selected={active === path.id}
                            onPress={() => flow.choosePath(path.id)} />
                    ))}
                </ItemGroup>
            </View>
        </ListPresentationProvider>
    ) : null;

    const signedIn = React.useCallback(async () => {
        if (flow.pane.pane !== 'home_sign_in') return onClose();
        const result = await flow.onConnected(flow.pane.profile);
        if (result.kind === 'focused') (onFocusedHome ?? onClose)();
    }, [flow, onClose, onFocusedHome]);

    let pane: React.ReactNode;
    if (flow.completion?.kind === 'connected') {
        pane = (
            <ConnectedHomePane
                profile={flow.completion.profile}
                onOpen={() => flow.openConnectedHome(flow.completion!.profile)}
                onOpened={onFocusedHome ?? onClose}
                onShowAllHomes={async () => {
                    await flow.showAllHomes();
                    (onShowAllHomes ?? onClose)();
                }}
            />
        );
    } else {
        switch (flow.pane.pane) {
            case 'service':
                pane = <ServicePathPane service={service} shouldFocusNewHome={flow.shouldFocusNewHome} onChangeService={() => flow.choosePath('other_service')} onDone={onClose} />;
                break;
            case 'other_service':
                pane = <OtherServicePathPane initialAddress={flow.pane.initialAddress} onUseService={() => flow.choosePath('service')} onConnectAsHome={flow.connectAsHome} />;
                break;
            case 'direct':
                pane = <DirectHomePathPane
                    initialAddress={flow.pane.initialAddress}
                    onHomeConnected={flow.homeConnected}
                    onAddressChange={props.onAddressChange}
                    onLeave={onClose}
                />;
                break;
            case 'home_sign_in':
                pane = <HomeSignInPane profile={flow.pane.profile} onBack={flow.back} onDone={() => { void signedIn(); }} />;
                break;
            case 'use_service_as_home':
                pane = <UseServiceAsHomeBody shouldFocusNewHome={flow.shouldFocusNewHome} onDone={onClose} />;
                break;
            case 'server_home':
                pane = <ServerHomePane testID={`${props.testID}.serverHome`} onHomeReady={flow.connectAsHome} />;
                break;
        }
    }

    if (props.layout === 'sheet') {
        return <View testID={`${props.testID}.${flow.pane.pane}`} style={styles.sheet}>{pane}</View>;
    }

    if (props.layout === 'panel') {
        const offersHosted = flow.paths.some((path) => path.id === 'use_service_as_home');
        return (
            <SetupPathPanel
                testID={props.testID}
                title={t('homesJourneys.alreadyUseTitle')}
                paths={paths.filter((path) => ALREADY_USE_PATHS.has(path.id))}
                active={active}
                onChoose={flow.choosePath}
                pane={pane}
                foot={offersHosted ? (
                    <View style={styles.foot}>
                        <Text style={styles.footText}>{t('homesJourneys.hostedPrompt')}</Text>
                        <PaneLink
                            testID={`${props.testID}.use-service-as-home`}
                            label={t('homesJourneys.useServiceAsAHome', { service: service.name })}
                            onPress={() => flow.choosePath('use_service_as_home')}
                        />
                    </View>
                ) : null}
                onClose={onClose}
            />
        );
    }

    return (
        <View testID={props.testID} style={styles.page}>
            {phone ? phonePaths : <SelectionTiles<AddHomePath>
                testIdPrefix={`${props.testID}.path`}
                accessibilityLabel={t('addFlows.addHome')}
                density="compact"
                minimumColumns={2}
                options={paths.map((path) => ({ id: path.id, title: path.title, subtitle: path.subtitle, mark: path.glyph }))}
                value={active}
                onChange={(next) => { if (next) flow.choosePath(next); }}
            />}
            <View style={styles.pane}>{pane}</View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        gap: 20,
    },
    sheet: {
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 20,
    },
    foot: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 4,
    },
    footText: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    pane: {
        minWidth: 0,
    },
}));
