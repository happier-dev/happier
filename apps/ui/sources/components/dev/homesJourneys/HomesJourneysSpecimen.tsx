import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AlreadyUseHappierTile } from '@/components/homes/journeys/alreadyUse/AlreadyUseHappierTile';
import type { AlreadyUsePath } from '@/components/homes/journeys/alreadyUse/alreadyUsePaths';
import { HomeWhereLine } from '@/components/homes/journeys/label/HomeWhereLine';
import { LaptopHomeNudgeTile } from '@/components/homes/journeys/nudge/LaptopHomeNudgeTile';
import { ReconcileHomesContent } from '@/components/homes/journeys/reconcile/ReconcileHomesSheet';
import { UseServiceAsHomeSheet } from '@/components/homes/journeys/serviceHome/UseServiceAsHomeSheet';
import { HomeAddForm } from '@/components/homes/add/HomeAddForm';
import { PhoneWelcomeDoorway } from '@/components/homes/journeys/phone/PhoneWelcomeDoorway';
import { WelcomeActionList, type WelcomeActionAdmission } from '@/components/onboarding/preAuth/WelcomeActionList';
import { useJourneyAccountService } from '@/components/homes/journeys/useJourneyAccountService';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useIsTablet } from '@/utils/platform/responsive';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { t } from '@/text';

/**
 * Dev-only specimen of the Homes journeys (lab `hjourneys`), rendered through the real components
 * so each frame can be compared side by side with the lab on a stack where the journey is not
 * reachable (a browser is never offered "Already use Happier?", which needs a computer that can run a
 * Personal Home). The service is this device's real sign-in service; the Homes in J2 are this
 * device's real saved Homes. J6 uses an illustrative miss count for this visual specimen.
 * `?only=K1|K1a|K1b|K1c|K1p|J2|J3|J4|J6|label` renders one frame.
 */
const FRAMES = ['label', 'K1', 'K1a', 'K1b', 'K1c', 'K1p', 'J2', 'J3', 'J4', 'J6'] as const;
type Frame = typeof FRAMES[number];

const noop = () => {};
const IMMEDIATE_ADMISSION: WelcomeActionAdmission = { pendingActionId: null, run: async (_id, action) => { await action(); } };

export function HomesJourneysSpecimen(props: Readonly<{ only: string | null }>) {
    const frames = FRAMES.filter((frame) => !props.only || props.only === frame);
    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            {frames.map((frame) => (
                <View key={frame} style={styles.block} testID={`homes-journeys-specimen.${frame}`}>
                    {props.only ? null : <Text style={styles.caption}>{frame}</Text>}
                    <FrameBody frame={frame} />
                </View>
            ))}
        </ScrollView>
    );
}

function FrameBody(props: Readonly<{ frame: Frame }>) {
    const phone = !useIsTablet();
    const service = useJourneyAccountService();
    const generation = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [generation]);
    const panel = (path: AlreadyUsePath) => (
        <View style={styles.panelFrame}>
            <HomeAddForm layout={phone ? 'sheet' : 'panel'} testID="specimen.already-use" initialPath={path} onClose={noop} />
        </View>
    );
    switch (props.frame) {
        case 'label':
            return <HomeWhereLine />;
        case 'K1':
            return (
                <View style={styles.tiles}>
                    <View style={styles.span2}>
                        <AlreadyUseHappierTile service={service} onOpenPath={noop} onUseServiceAsHome={noop} onDismiss={noop} />
                    </View>
                    {/* The third column of Get set up's grid (lab: Add your phone), left empty here. */}
                    <View style={styles.span1} />
                </View>
            );
        case 'K1a':
            return panel('service');
        case 'K1b':
            return panel('other_service');
        case 'K1c':
            return panel('direct');
        case 'K1p':
            return (
                <View style={styles.phoneDoorway}>
                    <WelcomeActionList admission={IMMEDIATE_ADMISSION}>
                        <PhoneWelcomeDoorway canScanQr onScan={noop} />
                    </WelcomeActionList>
                </View>
            );
        case 'J2':
            return profiles.length > 0 ? (
                <ModalCardFrame
                    leading={<HeaderLogo size={32} />}
                    title={t(phone ? 'homesJourneys.phone.reconcileTitle' : 'homesJourneys.reconcileTitle')}
                    subtitle={phone ? t('homesJourneys.phone.reconcileLead') : t('homesJourneys.reconcileLead', { count: Math.min(profiles.length, 2) })}
                    dimensions={{ width: 560 }}
                    presentation={phone ? 'sheet' : 'card'}
                    onClose={noop}
                >
                    <ReconcileHomesContent found={profiles.slice(0, 2)} personal={null} settle={noop} onClose={noop} />
                </ModalCardFrame>
            ) : <Text style={styles.caption}>No saved Homes on this device.</Text>;
        case 'J3':
            return (
                <ModalCardFrame
                    leading={<AccountServiceMark url={service.discovery?.endpointUrl ?? service.entry.endpoint.url} size={36} />}
                    title={t('homesJourneys.serviceAsHomeTitle', { service: service.name })}
                    subtitle={t(phone ? 'homesJourneys.phone.serviceAsHomeLead' : 'homesJourneys.serviceAsHomeLead', { service: service.name })}
                    dimensions={{ width: 560 }}
                    presentation={phone ? 'sheet' : 'card'}
                    onClose={noop}
                >
                    <UseServiceAsHomeSheet onClose={noop} />
                </ModalCardFrame>
            );
        case 'J4':
            return <View style={styles.sheetFrame}><HomeAddForm layout="page" testID="specimen.add-home" onClose={noop} /></View>;
        case 'J6':
            return (
                <LaptopHomeNudgeTile
                    facts={{ homeServerId: 'personal', homeIdentityId: 'srv_personal', missedReachesThisWeek: 3 }}
                    serviceName={service.name}
                    onMoveHome={noop}
                    onUseService={noop}
                    onDismiss={noop}
                />
            );
    }
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    content: { padding: 24, gap: 28, maxWidth: 1048, width: '100%', alignSelf: 'center' },
    // Home's column (lab: the S1 page column, 1000 px).
    block: { gap: 12 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.secondary },
    tiles: { flexDirection: 'row', gap: 10 },
    span2: { flex: 2, minWidth: 0 },
    span1: { flex: 1 },
    phoneDoorway: { width: 358, maxWidth: '100%', alignSelf: 'center', gap: 12 },
    panelFrame: {
        overflow: 'hidden',
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    sheetFrame: {
        width: 560,
        maxWidth: '100%',
        alignSelf: 'center',
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingTop: 12,
    },
}));
