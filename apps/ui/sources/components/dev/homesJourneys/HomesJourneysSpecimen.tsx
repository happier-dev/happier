import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
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
import { useJourneyAccountService, type JourneyAccountService } from '@/components/homes/journeys/useJourneyAccountService';
import type { AccountDirectoryAuthMethodDiscovery } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useIsTablet } from '@/utils/platform/responsive';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { t } from '@/text';
import { AccountServiceContinuation } from '@/components/account/auth/AccountServiceContinuation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import type { AccountPostAuthInput, AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import type { OpenedAccountDirectoryHomeEntryV1 as AccountDirectoryHomeEntryV1 } from '@happier-dev/protocol/auth/openedAccountDirectoryHome';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

/**
 * Dev-only specimen of the Homes journeys (lab `hjourneys`), rendered through the real components
 * so each frame can be compared side by side with the lab on a stack where the journey is not
 * reachable (a browser is never offered "Already use Happier?", which needs a computer that can run a
 * Personal Home). The service is this device's real sign-in service; the Homes in J2 are this
 * device's real saved Homes. J6 uses an illustrative miss count for this visual specimen.
 * `?only=<frame>` renders one frame. The six `continuation-*` frames are intentionally excluded
 * from the all-frames board: only the selected card may own the current UI command.
 */
const VISUAL_FRAMES = ['label', 'K1', 'K1a', 'K1b', 'K1c', 'K1p', 'J2', 'J3', 'J4', 'J6'] as const;
const CONTINUATION_FRAMES = [
    'continuation-choose',
    'continuation-retry',
    'continuation-refresh',
    'continuation-stop-waiting',
    'continuation-relink',
    'continuation-open',
] as const;
const FRAMES = [...VISUAL_FRAMES, ...CONTINUATION_FRAMES] as const;
type Frame = typeof FRAMES[number];
type ContinuationFrame = typeof CONTINUATION_FRAMES[number];

const noop = () => {};
const IMMEDIATE_ADMISSION: WelcomeActionAdmission = { pendingActionId: null, run: async (_id, action) => { await action(); } };

export function HomesJourneysSpecimen(props: Readonly<{ only: string | null }>) {
    const frames = props.only
        ? FRAMES.filter((frame) => props.only === frame)
        : VISUAL_FRAMES;
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
                        <PhoneWelcomeDoorway canScanQr onScan={noop} onConnectDirectly={noop} />
                    </WelcomeActionList>
                </View>
            );
        case 'J2':
            return profiles.length > 0 ? (
                <ModalCardFrame
                    leading={<HeaderLogo size={32} />}
                    title={t(phone ? 'homesJourneys.phone.reconcileTitle' : 'homesJourneys.reconcileTitle')}
                    subtitle={phone ? t('homesJourneys.phone.reconcileLead') : t('homesJourneys.reconcileLead', { count: Math.min(profiles.length, 2) })}
                    dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide }}
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
                    dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide }}
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
        case 'continuation-choose':
        case 'continuation-retry':
        case 'continuation-refresh':
        case 'continuation-stop-waiting':
        case 'continuation-relink':
        case 'continuation-open':
            return <AccountServiceContinuationSpecimen frame={props.frame} service={service} />;
    }
}

const inertController = new AbortController();
inertController.abort();
const INERT_FIXTURE_SIGNAL = inertController.signal;
const FIXTURE_CREDENTIAL_TOKEN_DIGEST = 'fixture-account-credential-binding';
const FIXTURE_ACCOUNT_SERVICE_IDENTITY = 'srv_continuation_fixture';
const FIXTURE_ACCOUNT_DIRECTORY_CAPABILITY = {
    version: 1 as const,
    homeDirectory: true,
    homeEnrollment: true,
    homeLoginAssertion: {
        keyId: 'a'.repeat(64),
        publicKeyBase64Url: 'A'.repeat(43),
    },
};

function resolveContinuationFixtureService(service: JourneyAccountService): AccountDirectoryAuthMethodDiscovery {
    if (service.discovery) return service.discovery;
    const serverIdentityId = service.entry.endpoint.serverIdentityId ?? FIXTURE_ACCOUNT_SERVICE_IDENTITY;
    const endpointUrl = service.entry.endpoint.url || 'https://continuation.example.test';
    return {
        endpointUrl,
        serverIdentityId,
        canonicalServerUrl: endpointUrl,
        capability: FIXTURE_ACCOUNT_DIRECTORY_CAPABILITY,
        keyLoginAvailable: false,
        oauthProviderIds: [],
        preferredProvisionProviderId: null,
        authenticationCatalog: { provenance: 'legacy', methods: [] },
        authenticationActions: [],
        accountServiceDisplayName: service.entry.endpoint.displayName ?? null,
        snapshot: {
            status: 'ready',
            serverIdentityId,
            features: createRootLayoutFeaturesResponse({ capabilities: {
                serverIdentity: { serverIdentityId },
                server: { canonicalServerUrl: endpointUrl },
                accountDirectory: FIXTURE_ACCOUNT_DIRECTORY_CAPABILITY,
            } }),
        },
    };
}

function createFixtureHome(
    homeServerIdentityId: string,
    label: string,
    canonicalServerUrl: string,
    preferred: boolean,
): AccountDirectoryHomeEntryV1 {
    return {
        v: 1,
        homeServerIdentityId,
        canonicalServerUrl,
        label,
        preferred,
        createdAtMs: 1,
        updatedAtMs: 1,
        connectionDescriptor: {
            v: 1,
            homeServerIdentityId,
            canonicalServerUrl,
            revision: 1,
            endpoints: [{ kind: 'https', url: canonicalServerUrl }],
        },
    };
}

function createContinuationResult(
    frame: ContinuationFrame,
    openHomeServerIdentityId: string,
): AccountPostAuthResult {
    switch (frame) {
        case 'continuation-choose':
            return { kind: 'choose_home', homes: [
                createFixtureHome('fixture-studio-home', 'Studio Home', 'https://studio-home.invalid', true),
                createFixtureHome('fixture-travel-home', 'Travel Home', 'https://travel-home.invalid', false),
            ] };
        case 'continuation-retry':
            return { kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'account-disabled' },
                recovery: 'retry_stage', accountCredentialCommitted: true, homeCredentialCommitted: false };
        case 'continuation-refresh':
            return { kind: 'account_connected_no_homes' };
        case 'continuation-stop-waiting':
            return { kind: 'approval_required', homeServerIdentityId: 'fixture-awaiting-home', expiresAtMs: Date.now() + 300_000 };
        case 'continuation-relink':
            return { kind: 'failure', stage: 'link', code: { source: 'local', code: 'link_failed' },
                recovery: 'relink_home', accountCredentialCommitted: true, homeCredentialCommitted: false,
                targetHomeServerIdentityId: 'fixture-relink-home' };
        case 'continuation-open':
            return { kind: 'home_enrolled', homeServerIdentityId: openHomeServerIdentityId };
    }
}

/**
 * Authenticated fixture. It injects a synthetic post-auth service/result pair while borrowing every
 * Account, approval and current-context provider from the signed-in app shell. A selected Account
 * Service is intentionally not required: PAR-07 starts from an already-authenticated Home Account.
 * Mutating operations retain an already-aborted signal, so an approved request settles before it can
 * reach Account/Home state. Stop-waiting remains live: without a matching pending enrollment it
 * changes only this card.
 */
function AccountServiceContinuationSpecimen(props: Readonly<{
    frame: ContinuationFrame;
    service: JourneyAccountService;
}>) {
    const generation = useServerProfilesGeneration();
    const activeHome = useActiveServerSnapshot();
    const discovery = React.useMemo(() => resolveContinuationFixtureService(props.service), [
        props.service.discovery,
        props.service.entry.endpoint.displayName,
        props.service.entry.endpoint.serverIdentityId,
        props.service.entry.endpoint.url,
    ]);
    const profile = React.useMemo(() => listServerProfiles().find(
        (candidate) => resolveServerProfileScopeId(candidate) === activeHome.serverId,
    ) ?? null, [activeHome.serverId, generation]);
    const openHomeServerIdentityId = profile?.serverIdentityId ?? null;
    const session = React.useMemo(() => discovery ? new AccountDirectorySession({
        endpoint: discovery.endpointUrl,
        serverIdentityId: discovery.serverIdentityId,
    }, { capability: discovery.capability }) : null, [
        discovery?.endpointUrl,
        discovery?.serverIdentityId,
        discovery?.capability,
    ]);
    const initialResult = React.useMemo(() => openHomeServerIdentityId
        ? createContinuationResult(props.frame, openHomeServerIdentityId)
        : null, [openHomeServerIdentityId, props.frame]);
    const [result, setResult] = React.useState<AccountPostAuthResult | null>(initialResult);
    React.useEffect(() => setResult(initialResult), [initialResult]);
    const input = React.useMemo<AccountPostAuthInput | null>(() => discovery && session && openHomeServerIdentityId ? {
        service: discovery,
        session,
        credentialTokenDigest: FIXTURE_CREDENTIAL_TOKEN_DIGEST,
        intent: props.frame === 'continuation-refresh' || props.frame === 'continuation-retry' || props.frame === 'continuation-choose'
            ? { kind: 'enter', target: { kind: 'automatic' } }
            : { kind: 'enroll', homeServerIdentityId: openHomeServerIdentityId },
        ...(props.frame === 'continuation-stop-waiting' ? {} : { signal: INERT_FIXTURE_SIGNAL }),
    } : null, [discovery, openHomeServerIdentityId, props.frame, session]);
    if (!input || !result) {
        return <Text style={styles.caption}>The current Home is required for this frame.</Text>;
    }
    return (
        <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
            <AccountServiceContinuation
                input={input}
                result={result}
                onResult={(next) => { setResult(next); }}
                onBack={noop}
            />
        </PluginSurfaceFocusEligibilityProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    content: { padding: theme.space.s24, gap: 28, maxWidth: 1048, width: '100%', alignSelf: 'center' },
    // Home's column (lab: the S1 page column, 1000 px).
    block: { gap: theme.space.s12 },
    caption: {  ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary },
    tiles: { flexDirection: 'row', gap: theme.space.s10 },
    span2: { flex: 2, minWidth: 0 },
    span1: { flex: 1 },
    phoneDoorway: { width: 358, maxWidth: '100%', alignSelf: 'center', gap: theme.space.s12 },
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
        paddingTop: theme.space.s12,
    },
}));
