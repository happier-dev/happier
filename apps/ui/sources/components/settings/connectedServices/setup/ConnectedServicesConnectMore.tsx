import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SetupBlockGrid, type SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { homeConnectServiceStepId } from '../home/selectHomeConnectInvitations';
import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { ConnectedServiceCatalogBlock } from './ConnectedServiceCatalogBlock';
import {
    CONNECT_MORE_BROWSE_ID,
    resolveConnectMoreBlockForRequest,
    selectConnectMoreOffer,
    signsInWithAnAccount,
    buildConnectedServiceSetupRoute,
} from './connectMoreBlocks';
import {
    ConnectedServiceSetupPanel,
    type ConnectedServiceSetupCatalogEntry,
    type ConnectedServiceSetupPanelProps,
    type ConnectedServiceSetupTarget,
} from './ConnectedServiceSetupPanel';

const CONNECTED_SERVICES_DOCS_URL = 'https://docs.happier.dev/accounts/connected-services';
/** First-run marks: the subscriptions most people already pay for (built-in brand marks). */
const FIRST_RUN_MARK_SERVICE_IDS = ['claude-subscription', 'openai-codex', 'gemini'] as const;

export type ConnectedServicesConnectMoreProps = Readonly<{
    model: ConnectedServicesIndexModel;
    /** `section`: "Connect more" after the services. `firstRun` (P0): the promise, then the blocks. */
    layout: 'section' | 'firstRun';
    /** The rail's "+" (catalog), a service's "Add account" (its flow), a row's "Sign in again" (reconnect). */
    request: ConnectedServiceSetupTarget | null;
    onRequestHandled: () => void;
    /** The panel has closed on a new or re-signed account: its row settles (A5). */
    onConnected: (account: QualifiedConnectedAccountRef, serviceKey: string) => void;
    /** A panel is open: rows step their own fix down to secondary. */
    onOpenChange?: (open: boolean) => void;
    /** First run only: services are still arriving. */
    loading?: boolean;
    /** Preview only: the fixture frames draw a flow without a machine. */
    renderServiceFlow?: ConnectedServiceSetupPanelProps['renderServiceFlow'];
    targetSelection?: ConnectedServiceSetupPanelProps['targetSelection'];
    testID?: string;
}>;

/**
 * Connect more (lab `csvc` A1–A4, P0): a row of set-up blocks for what the agents on your machines
 * accept but you haven't connected, and "More services" to browse everything. A block grows in place
 * into the set-up panel (a service's flow, or the catalog, whose own blocks grow again into theirs);
 * when an account connects the panel closes and its row settles (A5, `ConnectedAccountSettled`).
 * The page's rail "+", "Add account" and "Sign in again" arrive as a `request` and open here.
 * "Not now" is the Home set-up dismissal (`connect:<service>`), so the page and Home agree.
 */
export function ConnectedServicesConnectMore(props: ConnectedServicesConnectMoreProps) {
    const phone = useDeviceType() === 'phone';
    const router = useRouter();
    const { hidden, dismiss } = useHomeSetupDismissals();
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(props.model), [props.model]);
    const addable = catalog.filter((entry) => entry.canAdd);
    const connectableKeys = React.useMemo(
        () => new Set(props.model.connectable.map((service) => service.serviceKey)),
        [props.model.connectable],
    );
    const tools = addable.filter((entry) => entry.section === 'tools');
    const { offered, browse: hasBrowse } = selectConnectMoreOffer({ layout: props.layout, addable, connectableKeys, hidden });

    const [openId, setOpenId] = React.useState<string | null>(null);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget>({ kind: 'catalog' });
    const rootRef = React.useRef<View>(null);
    const { onOpenChange, onRequestHandled, onConnected, request } = props;

    React.useEffect(() => {
        onOpenChange?.(openId !== null);
    }, [onOpenChange, openId]);

    // Read by the request below without re-running it on every render.
    const placesRef = React.useRef({ offered, hasBrowse });
    placesRef.current = { offered, hasBrowse };
    React.useEffect(() => {
        if (!request) return;
        if (phone && !props.renderServiceFlow) {
            router.push(buildConnectedServiceSetupRoute(request));
            onRequestHandled();
            return;
        }
        const places = placesRef.current;
        setTarget(request);
        setOpenId((current) => resolveConnectMoreBlockForRequest({
            request,
            offered: places.offered,
            browse: places.hasBrowse,
            openId: current,
        }));
        // Where the request came from may be far above: bring the panel into view (web).
        const node = rootRef.current as unknown as { scrollIntoView?: (options: Readonly<{ block: string; behavior: string }>) => void } | null;
        node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        onRequestHandled();
    }, [onRequestHandled, phone, props.renderServiceFlow, request, router]);

    const settle = React.useCallback((account: QualifiedConnectedAccountRef, serviceKey: string) => {
        setOpenId(null);
        onConnected(account, serviceKey);
    }, [onConnected]);

    const renderPanel = ({ close }: Readonly<{ close: () => void }>) => (
        <ConnectedServiceSetupPanel
            testID="connected-services-connect-more:setup"
            target={target}
            catalog={catalog}
            onTargetChange={setTarget}
            onClose={close}
            onConnected={settle}
            renderServiceFlow={props.renderServiceFlow}
            targetSelection={props.targetSelection}
            chrome="frame"
        />
    );

    const items: SetupBlockItem[] = offered.map((entry) => ({
        id: entry.serviceKey,
        renderTile: ({ open }) => {
            const start = () => {
                if (phone && !props.renderServiceFlow) {
                    router.push(buildConnectedServiceSetupRoute({ kind: 'service', serviceKey: entry.serviceKey }));
                    return;
                }
                setTarget({ kind: 'service', serviceKey: entry.serviceKey });
                open();
            };
            if (props.layout === 'firstRun') {
                return <ConnectedServiceCatalogBlock entry={entry} layout={phone ? 'row' : 'card'} showCount={false} onConnect={start} />;
            }
            const agents = formatAgentNames(entry.usedBy);
            return (
                <SetupBlockTile
                    testID={`connected-services-connect-more:${entry.serviceKey}`}
                    layout={phone ? 'row' : 'card'}
                    glyph={<ConnectedServiceMark legacyServiceId={entry.legacyServiceId} size="inline" />}
                    title={entry.label}
                    subtitle={signsInWithAnAccount(entry)
                        ? t('connectedServicesSetup.serviceSignInInstead', { agents })
                        : t('connectedServicesSetup.serviceCanUse', { agents })}
                    action={{
                        label: t('connectedServicesSettings.connect'),
                        testID: `connected-services-connect-more:${entry.serviceKey}.action`,
                        onPress: start,
                    }}
                    dismiss={{
                        label: t('connectedServicesSetup.notNow', { service: entry.label }),
                        tooltip: t('connectedServicesSetup.notNowTooltip'),
                        onPress: () => dismiss(homeConnectServiceStepId(entry.serviceKey)),
                    }}
                />
            );
        },
        renderPanel,
    }));
    if (hasBrowse) {
        const rest = addable.filter((entry) => !offered.includes(entry));
        const marked = (props.layout === 'firstRun' ? rest : tools.length > 0 ? tools : rest).slice(0, 3);
        const browse = (open: () => void) => () => {
            if (phone && !props.renderServiceFlow) {
                router.push(buildConnectedServiceSetupRoute({ kind: 'catalog' }));
                return;
            }
            setTarget({ kind: 'catalog' });
            open();
        };
        items.push(props.layout === 'firstRun' ? {
            id: CONNECT_MORE_BROWSE_ID,
            span: 'row',
            renderTile: ({ open }) => (
                <Pressable
                    testID="connected-services-connect-more:browse.action"
                    accessibilityRole="button"
                    onPress={browse(open)}
                >
                    {({ pressed }) => (
                        <SetupBlockPaper testID="connected-services-connect-more:browse" layout="wide">
                            <Text style={styles.moreTitle}>{t('connectedServicesSetup.firstRunMore')}</Text>
                            <View style={styles.marks}>
                                {marked.map((entry) => (
                                    <ConnectedServiceMark key={entry.serviceKey} legacyServiceId={entry.legacyServiceId} size="inline" />
                                ))}
                            </View>
                            <View style={styles.grow} />
                            <View style={pressed ? styles.pressed : null}>
                                <BrowseCaret />
                            </View>
                        </SetupBlockPaper>
                    )}
                </Pressable>
            ),
            renderPanel,
        } : {
            id: CONNECT_MORE_BROWSE_ID,
            renderTile: ({ open }) => (
                <SetupBlockTile
                    testID="connected-services-connect-more:browse"
                    layout={phone ? 'row' : 'card'}
                    glyph={(
                        <View style={styles.marks}>
                            {marked.map((entry) => (
                                <ConnectedServiceMark key={entry.serviceKey} legacyServiceId={entry.legacyServiceId} size="inline" />
                            ))}
                        </View>
                    )}
                    title={t('connectedServicesSetup.moreServicesTitle')}
                    subtitle={tools.length > 0
                        ? t('connectedServicesSetup.moreServicesTools', { names: formatAgentNames(tools.slice(0, 3).map((entry) => entry.label)) })
                        : t('connectedServicesSetup.moreServicesAll')}
                    action={{
                        label: t('connectedServicesSetup.browse'),
                        testID: 'connected-services-connect-more:browse.action',
                        onPress: browse(open),
                    }}
                />
            ),
            renderPanel,
        });
    }

    const grid = items.length > 0 ? (
        <SetupBlockGrid
            testID={`${props.testID ?? 'connected-services-connect-more'}.grid`}
            columns={phone ? 1 : 3}
            items={items}
            openId={openId}
            onOpenChange={setOpenId}
        />
    ) : null;

    // A flow opened inline keeps its grid ancestry across resize; new phone opens still push
    // the dedicated connect route above. Moving an existing flow into that page loses its draft.
    if (props.layout === 'firstRun') {
        return (
            <View ref={rootRef} testID={props.testID ?? 'connected-services-connect-more'} style={styles.firstRun}>
                <SurfaceStateCard
                    testID="connected-services-first-run"
                    kind="empty"
                    size="pane"
                    icon={(
                        <View style={styles.firstRunMarks}>
                            {FIRST_RUN_MARK_SERVICE_IDS.map((serviceId) => (
                                <ConnectedServiceMark key={serviceId} legacyServiceId={serviceId} size="page" />
                            ))}
                        </View>
                    )}
                    title={t('connectedServicesSettings.firstRunTitle')}
                    reason={t('connectedServicesSettings.firstRunPromise')}
                    live={props.loading ? { text: t('connectedServicesSettings.loadingServices'), busy: true } : undefined}
                    note={t('connectedServicesSettings.firstRunMeanwhile')}
                    learnMore={{
                        label: t('surfaceState.howItWorks'),
                        onPress: () => void openExternalUrl(CONNECTED_SERVICES_DOCS_URL),
                    }}
                />
                {grid}
            </View>
        );
    }
    if (!grid) return null;
    return (
        <View ref={rootRef} testID={props.testID ?? 'connected-services-connect-more'}>
            <ItemGroup
                surface="none"
                title={t('connectedServicesSetup.connectMoreTitle')}
                description={offered.length > 0
                    ? t('connectedServicesSetup.connectMoreDescription')
                    : t('connectedServicesSetup.connectMoreNothingNew')}
            >
                {grid}
            </ItemGroup>
        </View>
    );
}

function BrowseCaret() {
    const { theme } = useUnistyles();
    return <Icon name="caret-down" size={14} color={theme.colors.text.tertiary} />;
}

const styles = StyleSheet.create((theme) => ({
    firstRun: {
        gap: 22,
    },
    firstRunMarks: {
        flexDirection: 'row',
        gap: 10,
    },
    marks: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    grow: {
        flex: 1,
    },
    moreTitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    pressed: {
        opacity: 0.6,
    },
}));
