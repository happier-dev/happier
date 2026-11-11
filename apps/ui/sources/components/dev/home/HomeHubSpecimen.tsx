import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { getWidgetSizeFootprintV1, resolveWidgetRowOfThreeSizeV1, resolveWidgetRowOwnerSizeV1, WIDGET_SIZE_POLICY_V1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import type { HappierSceneId } from '@happier-dev/plugin-ui/presentation';

import { HubAttentionList, type AttentionItem } from '@/components/hub/HubAttentionSection';
import { HomeHubReadingColumn, HomeHubSectionList, resolveHomeHubFirstRunLeadId, type HomeHubSectionPlacement } from '@/components/hub/HomeHubSectionList';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { LARGE_PICKER_LAYOUT } from '@/components/sessions/new/hooks/screenModel/useNewSessionInputPopovers';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { HomeWhereLine } from '@/components/homes/journeys/label/HomeWhereLine';
import { AlreadyUseHappierTile } from '@/components/homes/journeys/alreadyUse/AlreadyUseHappierTile';
import { useJourneyAccountService } from '@/components/homes/journeys/useJourneyAccountService';
import { HubSetupGridView } from '@/components/hub/HubSetupSection';
import { VOICE_SETUP_STEP_ID } from '@/voice/settings/setup/useVoiceSetupItem';
import { buildVoiceSetupFixtureItem, LAB_BRIEF, type VoiceSetupFixtureFrame } from './voiceSetupFixtures';
import { VoiceBriefButtonView, VoiceBriefList } from '@/components/voice/brief/VoiceBrief';
import { View } from 'react-native';
import { HubUsageCardGrid } from '@/components/hub/usage/HubUsageCardGrid';
import { HubCustomizeButton } from '@/components/hub/header/HubCustomizeButton';
import { HubStatusLineView } from '@/components/hub/header/HubStatusLine';
import { HOME_HUB_BUILTIN_SECTIONS } from '@/components/hub/homeHubSections';
import { getHomeHubDefaultLayoutV1, resolveHomeHubLayout, setHomeHubSectionHidden } from '@/components/hub/layout/homeHubLayout';
import type { UsageSummaryEntry } from '@/components/hub/usage/useUsageSummary';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HubComposerSection } from '@/components/hub/composer/HubComposerSection';
import { MachineAddWays } from '@/components/machines/add/MachineAddWays';
import { LatestRunRow, latestRunsEmptyBody } from '@/components/automations/home/AutomationsLatestRunsSection';
import { LocalServicesGlanceView } from '@/components/sessions/companion/glances/LocalServicesGlance';
import { automationRunTone, type LatestAutomationRunRow } from '@/components/automations/home/latestAutomationRuns';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { buildNewSessionManagedProgressBadge } from '@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

/**
 * Dev-only fixture of the app Home (lab `hindex` I1/I3) for layout and fidelity checks without
 * touching an Account: the real page composition (`HomeHubSectionList`, the real default order from
 * the layout owner) and the real section views at static lab data. Nothing here reads or writes the
 * Account's Home layout; Customize is drawn closed and never opens. The composer is the real one
 * (it reads this device's drafts and machines, and writes nothing until someone types).
 * `?machines=1` turns Machines on (I3); Machines has no static view, so its slot shows the grid owner
 * only on the live Home.
 *
 * `?showcase=1&firstRun=1` is the zero-Machine, zero-Session Account (58d AF1, lab `af-first`): nothing
 * running, nothing needing you, the composer with no machine yet (the real composer input at those props:
 * "Run on…" opening the real picker with no machine groups, no folder chip) and only the starter
 * suggestions, Machines leading the cards through the page owner, and no widget naming a computer.
 * Nothing from the signed-in Account's sessions or machines is drawn.
 */
const NEVER_OPENS = () => {};
const renderHomeLine = (detail: 'full' | 'name') => <HomeWhereLine detail={detail} separated />;
const NOW = Date.UTC(2026, 8, 29, 14, 42);

const LAB_WIDGET: WidgetCandidate = {
    sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
    surface: { pluginId: 'happier.triage', localId: 'latest' },
    key: 'happier.triage/latest',
    title: 'New for you',
    pluginName: 'PRs & Issues',
    sharedPluginName: false,
    icon: 'git-pull-request',
    homeDefault: 'shown',
    target: 'app',
};

const LAB_USAGE: readonly UsageSummaryEntry[] = [
    usage('claude/work', 'Claude subscription', 'claude-subscription', 'Work', 'Max', [42, 64]),
    usage('codex/personal', 'ChatGPT subscription', 'openai-codex', 'Personal', 'Pro', [8, 31]),
    usage('claude/personal', 'Claude subscription', 'claude-subscription', 'Personal', 'Pro', [88, 71]),
];

function usage(key: string, serviceLabel: string, legacyServiceId: string, profile: string, plan: string, left: readonly [number, number]): UsageSummaryEntry {
    return {
        key,
        fetchedAt: NOW,
        serviceLabel,
        legacyServiceId,
        profileLabel: profile,
        planLabel: plan,
        meters: [
            { meterId: '5h', label: '5-hour', remainingPct: left[0], resetsAt: NOW + 2 * 3_600_000 },
            { meterId: 'week', label: 'Weekly', remainingPct: left[1], resetsAt: NOW + 3 * 86_400_000 },
        ],
    };
}

/** Lab runs through the real run row (its status glyphs and tones). Only the fields the row reads are set. */
function labRun(id: string, name: string, state: AutomationDefinitionRun['state'], at: number): LatestAutomationRunRow {
    return {
        run: { id, state } as AutomationDefinitionRun,
        automationName: name,
        targetType: 'session' as LatestAutomationRunRow['targetType'],
        at,
        tone: automationRunTone(state),
    };
}

const LAB_RUNS: readonly LatestAutomationRunRow[] = [
    labRun('r1', 'Morning triage', 'succeeded', NOW - 3 * 3_600_000),
    labRun('r2', 'Nightly dependency check', 'running', NOW - 4 * 60_000),
    labRun('r3', 'Weekly release notes', 'failed', NOW - 4 * 86_400_000),
    labRun('r4', 'Morning triage', 'succeeded', NOW - 27 * 3_600_000),
];

function labAttention(color: string): AttentionItem[] {
    return [
        { key: 'agent:codex', mark: <Icon name="terminal" size={18} color={color} />, title: 'Codex needs sign-in on MacBook Pro', actionLabel: t('settingsOverview.signIn'), onAction: NEVER_OPENS },
        { key: 'plugins', mark: <Icon name="shield-check" size={18} color={color} />, title: t('settingsOverview.pluginChangesAwaitingReview', { count: 1 }), actionLabel: t('settingsOverview.review'), onAction: NEVER_OPENS },
    ];
}

function labSetup(phone: boolean): SetupBlockItem[] {
    const tile = (id: string, icon: IconName, title: string, subtitle: string, label: string): SetupBlockItem => ({
        id,
        renderTile: () => (
            <SetupBlockTile
                testID={`dev-home.setup.${id}`}
                layout={phone ? 'row' : 'card'}
                icon={icon}
                title={title}
                subtitle={subtitle}
                action={{ label, testID: `dev-home.setup.${id}.action`, onPress: NEVER_OPENS }}
                dismiss={{ label: title, tooltip: t('homeSetup.dismissTooltip'), onPress: NEVER_OPENS }}
            />
        ),
    });
    return [
        phone
            ? tile('connectComputer', 'laptop', t('homeSetup.connectComputerTitle'), t('homeSetup.connectComputerSubtitle'), t('settingsOverview.setupActionScan'))
            : tile('addPhone', 'device-mobile', t('settings.addYourPhone'), t('homeSetup.addPhoneSubtitle'), t('homeSetup.addPhoneAction')),
        tile('addMachine', 'desktop', t('settingsOverview.addMachineTitle'), t(phone ? 'homeSetup.phoneAddMachineSubtitle' : 'homeSetup.addMachineSubtitle'), t(phone ? 'homeSetup.phoneAddMachineAction' : 'settingsOverview.setupActionAddMachine')),
        tile('installComputer', 'laptop', t('homeSetup.installComputerTitle'), t('homeSetup.installComputerSubtitle'), t('homeSetup.installComputerAction')),
    ];
}

/** The Get set up steps the first-run Machines widget's empty state carries. */
const FIRST_RUN_WIDGET_STEPS: ReadonlySet<string> = new Set(['addMachine', 'connectComputer', 'installComputer']);

function LabRows(props: Readonly<{ rows: ReadonlyArray<readonly [IconName, string, string]>; unread?: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <>
            {props.rows.map(([icon, title, subtitle], index) => (
                <Item
                    key={`${index}:${title}`}
                    title={title}
                    subtitle={subtitle}
                    icon={<Icon name={icon} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    rightElement={props.unread ? <StatusDot color={theme.colors.text.link} size={6} /> : undefined}
                />
            ))}
        </>
    );
}

/**
 * `?showcase=1`: the first-run Home showcase (owner 10-31, berthd reference): the default widgets in their
 * designed empty states, each a Daybreak scene, one line on what will appear and at most one action, with
 * Machines showing its real first row. Copy is the content owners' posted proposals (Usage, Triage, FIN,
 * Lane 12); their widgets own the final words.
 */
type ShowcaseEmpty = Readonly<{ mark: IconName; title: string; source?: string; scene: HappierSceneId; empty: string; reason: string; action?: string }>;
const SHOWCASE: Readonly<Record<string, ShowcaseEmpty>> = {
    'default:happier.triage/latest': { mark: 'git-pull-request', title: 'New in PRs & Issues', source: 'PRs & Issues', scene: 'reviewApproved',
        empty: 'No sources yet', reason: 'Pull requests and issues that need you show here.', action: 'Connect a source' },
};

const SHOWCASE_SERVICES = { kind: 'ready', scope: 'app', rows: [], runningCount: 0,
    degraded: [{ kind: 'offline', machineId: 'leeroy-mbp', machineName: 'leeroy-mbp' }], listedMachineCount: 0 } as const;
/** No machine yet: nothing to list and no machine to name. */
const FIRST_RUN_SERVICES = { kind: 'ready', scope: 'app', rows: [], runningCount: 0, degraded: [], listedMachineCount: 0 } as const;

/** Mirrors `HubWidgetSection`'s presented size for a placement (the saved size is untouched). */
function presentedSize(size: WidgetSizeV1, placement: HomeHubSectionPlacement): WidgetSizeV1 {
    return placement.leads ? resolveWidgetRowOwnerSizeV1('home', resolveWidgetRowOfThreeSizeV1('home', size))
        : placement.ownsRow ? resolveWidgetRowOwnerSizeV1('home', size) : placement.inRowOfThree ? resolveWidgetRowOfThreeSizeV1('home', size) : size;
}

const noComposerSuggestions = async () => [];

/**
 * `?create=` frames (lab af-create): a Vercel sandbox this device creates, at the real creation badge adapter and
 * the row facts 58B-U1 records. `A` installing (bound), `J` joining (installed), `Jd` joining that joins after a
 * few seconds (the badge leaves), `Ip` Setup interrupted after install, `Iu` interrupted with no install fact.
 */
const CREATE_FRAMES = ['A', 'J', 'Jd', 'Ip', 'Iu'] as const;
export type HomeCreateFixtureFrame = typeof CREATE_FRAMES[number];
export function isHomeCreateFixtureFrame(value: unknown): value is HomeCreateFixtureFrame {
    return CREATE_FRAMES.includes(value as HomeCreateFixtureFrame);
}
const CREATE_PROMPT = 'Add a dark mode to the pricing page and open a PR';
/**
 * The machine a `?create=` frame creates: Vercel, or `&provider=<pluginId/localId>` for any bundled provisioner (58d U8),
 * with that declaration's own billing and retention facts.
 */
function createFixture(providerKey: string | null | undefined) {
    const declaration = Object.values(BUNDLED_MACHINE_PROVISIONER_DECLARATIONS)
        .find(candidate => buildQualifiedPluginContributionKey(candidate.contribution) === (providerKey ?? 'happier.machine.vercel/vercel'));
    const provider = declaration?.contribution ?? { pluginId: 'happier.machine.vercel', localId: 'vercel' };
    const launch = { provider, schemaVersion: declaration?.descriptor.schemaVersion ?? 1, name: `${provider.localId}-1`, choices: {} };
    const row: ManagedMachineV1 = {
        id: `managed-${launch.name}`, homeId: 'home', custodianAccountId: 'account', launch,
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        resource: { contributionRef: provider, schemaVersion: launch.schemaVersion, value: { sandboxId: 'sbx_7Q2' } },
    };
    return { launch, row, billing: declaration?.descriptor.billing ?? { location: 'cloud' as const, stoppedBilling: 'not-billed' as const },
        retentionCapabilities: declaration?.descriptor.retention ?? { supportedIntents: ['start' as const, 'stop' as const, 'resume' as const, 'delete' as const] } };
}

/** The creation badge as the composer model builds it for an Account-created machine (no controller: this device works). */
function useCreateFixtureBadge(frame: HomeCreateFixtureFrame | null | undefined, homeId: string | null, providerKey?: string | null) {
    const [archiveEffect, setArchiveEffect] = React.useState<'keep' | 'stop' | 'delete'>('keep');
    // `Jd` only: the join lands once, a few seconds after the frame opens (dev fixture, never a product timer).
    const [joined, setJoined] = React.useState(false);
    React.useEffect(() => {
        if (frame !== 'Jd') return undefined;
        const timer = setTimeout(() => setJoined(true), 15000);
        return () => clearTimeout(timer);
    }, [frame]);
    return React.useMemo(() => {
        if (!frame || !homeId) return null;
        const fixture = createFixture(providerKey);
        const selection = createManagedMachineSelectionDraft({ archiveEffect,
            selection: { kind: 'preset', homeId, id: `${fixture.launch.provider.localId}-preset`, revision: 1 },
            receipt: { launch: fixture.launch, optionStatus: 'current', prerequisites: [],
                billing: fixture.billing, retentionCapabilities: fixture.retentionCapabilities,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        const row: ManagedMachineV1 = { ...fixture.row, homeId, ...(frame === 'A' || frame === 'Iu' ? {} : { bootstrapInstalled: true }) };
        const retainedMachine = { machine: row, inspect: NEVER_OPENS };
        const creating = frame === 'A' || frame === 'J' || frame === 'Jd';
        return buildNewSessionManagedProgressBadge({ selection, acquisition: null, select: NEVER_OPENS,
            retryInstallation: NEVER_OPENS, cancel: NEVER_OPENS, retainedMachine,
            ...(joined ? { progress: { kind: 'ready' as const, managedId: row.id, machineId: `guest-${fixture.launch.name}` } }
                : creating ? { progress: { kind: 'acquiring' as const, managedId: row.id }, updateArchiveEffect: setArchiveEffect,
                    archiveChoiceAvailability: { supportedEffects: ['keep', 'stop', 'delete'], nativeUnsupportedEffects: [] } }
                : { progress: { kind: 'idle' as const } }),
        });
    }, [archiveEffect, frame, homeId, joined, providerKey]);
}

/**
 * The Home composer with no machine yet, at the props the composer model gives it then (58d AF1): the machine
 * chip asks "Run on…" and opens the real picker with no machine groups (Create in the cloud · Use one you have),
 * no folder chip, and no suggestions (Home's `none`: nothing could run yet). Typing stays local to this fixture.
 */
function FirstRunComposer(props: Readonly<{ create?: HomeCreateFixtureFrame | null; createProvider?: string | null }>) {
    const [value, setValue] = React.useState(props.create ? CREATE_PROMPT : '');
    const serverId = useResolvedActiveServerSelection().activeServerId;
    // The Home a created machine joins is named by its identity, as the badge's Join stage reads it.
    const createBadge = useCreateFixtureBadge(props.create, serverId ? getServerProfileById(serverId)?.serverIdentityId ?? serverId : null, props.createProvider);
    const [openBadge, setOpenBadge] = React.useState<string | null>(createBadge?.key ?? null);
    const statusBadges = React.useMemo(() => createBadge ? [createBadge] : undefined, [createBadge]);
    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ maxHeight, requestClose, inline }) => (
            <NewSessionMachineSelectionContent
                groups={[]}
                selectedMachine={null}
                selectedServerId={serverId}
                serverId={serverId}
                recentMachines={[]}
                favoriteMachines={[]}
                onSelectMachine={requestClose}
                onSelectScopedMachine={requestClose}
                onSelectManagedMachine={requestClose}
                onConnectMachine={requestClose}
                showSearch={false}
                testIdPrefix="dev-home-machine"
                maxHeight={maxHeight}
                presentation={inline ? 'inline' : undefined}
            />
        ),
        ...LARGE_PICKER_LAYOUT,
    }), [serverId]);
    return (
        <ItemGroup surface="none" header="none">
            <View testID="hub-composer">
                <AgentInput
                    value={value}
                    onChangeText={setValue}
                    placeholder={t('session.inputPlaceholder')}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={noComposerSuggestions}
                    agentType="claude"
                    onAgentClick={NEVER_OPENS}
                    permissionMode="default"
                    onPermissionModeChange={NEVER_OPENS}
                    machineName={props.create ? createFixture(props.createProvider).launch.name : null}
                    machinePopover={machinePopover}
                    statusBadges={statusBadges}
                    activeStatusBadgeKey={createBadge ? openBadge : undefined}
                    onActiveStatusBadgeKeyChange={createBadge ? setOpenBadge : undefined}
                    messageHistory="none"
                    // As Home's composer card: the page column supplies the edges.
                    contentPaddingHorizontal={0}
                    onSend={NEVER_OPENS}
                />
            </View>
        </ItemGroup>
    );
}

function ShowcaseCard(props: Readonly<{ id: string; testID: string; size?: WidgetSizeV1; placement: HomeHubSectionPlacement; noMachine?: boolean }>) {
    const { theme } = useUnistyles();
    const size = props.size ? presentedSize(props.size, props.placement) : undefined;
    const widgetPresentation = size ? { size, footprint: getWidgetSizeFootprintV1('home', size)! } : undefined;
    if (props.id === 'default:builtin:machine_fleet' && props.noMachine) {
        // No machine yet (58d AF1, lab af-first): the real Machines empty state, the ways to add one.
        return (
            <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark="desktop" title="Machines"
                widgetPresentation={widgetPresentation} bodyHeight={props.placement.leads ? 'content' : undefined}
                body={{ kind: 'content', children: <MachineAddWays testIDPrefix={props.testID} /> }} />
        );
    }
    if (props.id === 'default:builtin:usage_capacity') {
        // Capacity's empty state as its owner draws it: the one sign-in (58d AF1).
        return (
            <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark="speedometer" title={t('usage.widgets.usage_capacity')}
                widgetPresentation={widgetPresentation}
                body={{ kind: 'empty', title: t('usage.board.plans.capacitySignInTitle'), reason: t('usage.board.plans.capacityNoneConnectedPromise'),
                    scene: 'connectAccount', action: { label: t('usage.board.plans.capacitySignIn'), onPress: NEVER_OPENS } }} />
        );
    }
    if (props.id === 'default:builtin:machine_fleet') {
        return (
            // Content height, as the real Machines widget (`MachineFleetWidget`) asks: one row is not stretched on a phone.
            <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark="desktop" title="Machines"
                widgetPresentation={widgetPresentation} bodyHeight="content"
                body={{ kind: 'content', children: <Item title="leeroy-mbp" subtitle="Offline · last seen 16 days ago" showChevron={false}
                    icon={<Icon name="laptop" color={theme.colors.text.secondary} />} /> }} />
        );
    }
    if (props.id === 'default:builtin:local_services_app') {
        // The real App glance at static props: no service yet, and the one machine offline (its honest line).
        return (
            <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark="hard-drives" title={t('widgetGlances.localServicesTitle')}
                widgetPresentation={widgetPresentation}
                body={{ kind: 'content', children: <LocalServicesGlanceView testID={`${props.testID}.body`} frameStyle="plain" presentation="body"
                    machineName={null} state={props.noMachine ? FIRST_RUN_SERVICES : SHOWCASE_SERVICES} /> }} />
        );
    }
    if (props.id === 'automations') {
        // The real Latest runs empty body before the first workflow (FIN): its scene, line and New workflow.
        return (
            <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark="timer" title={t('homeWidgets.latestRunsTitle')}
                widgetPresentation={widgetPresentation} body={latestRunsEmptyBody(NEVER_OPENS)} />
        );
    }
    const card = SHOWCASE[props.id];
    if (!card) return null;
    return (
        <WidgetFrame testID={props.testID} frameStyle="card" placement="home" fill mark={card.mark} title={card.title}
            source={card.source} widgetPresentation={widgetPresentation}
            body={{ kind: 'empty', title: card.empty, reason: card.reason, scene: card.scene,
                ...(card.action ? { action: { label: card.action, onPress: NEVER_OPENS } } : {}) }} />
    );
}

export function HomeHubSpecimen(props: Readonly<{ machines: boolean; firstRun?: boolean; showcase?: boolean; voice?: VoiceSetupFixtureFrame | null; brief?: boolean; create?: HomeCreateFixtureFrame | null; createProvider?: string | null }>) {
    const { theme } = useUnistyles();
    const phone = !useIsTablet();
    const service = useJourneyAccountService();
    // The zero-Machine, zero-Session Account (58d AF1).
    const firstRunWorld = props.showcase === true && props.firstRun === true;
    // J1 first run: "Already use Happier?" (K1, two columns) leads Get set up.
    const setupItems = React.useMemo<SetupBlockItem[]>(() => [
        ...(props.firstRun ? [{
            id: 'alreadyUse',
            span: 2 as const,
            renderTile: () => (
                <AlreadyUseHappierTile service={service} onOpenPath={NEVER_OPENS} onUseServiceAsHome={NEVER_OPENS} onDismiss={NEVER_OPENS} />
            ),
        }] : []),
        ...(props.voice ? [buildVoiceSetupFixtureItem(props.voice, phone)] : []),
        // With no machine yet (`?showcase=1&firstRun=1`), Get set up keeps only what no widget covers (58d AF1).
        ...labSetup(phone).filter((item) => !(props.showcase && props.firstRun && FIRST_RUN_WIDGET_STEPS.has(item.id))),
    ], [phone, props.firstRun, props.showcase, props.voice, service]);
    const widgets = React.useMemo(() => [LAB_WIDGET], []);
    const layout = React.useMemo(() => (props.showcase ? getHomeHubDefaultLayoutV1()
        : props.machines ? setHomeHubSectionHidden(getHomeHubDefaultLayoutV1(), HOME_HUB_BUILTIN_SECTIONS, widgets, 'machines', false)
        : getHomeHubDefaultLayoutV1()), [props.machines, props.showcase, widgets]);
    const sections = React.useMemo(
        () => resolveHomeHubLayout(layout, HOME_HUB_BUILTIN_SECTIONS, widgets).sections,
        [layout, widgets],
    );

    return (
        <ItemList testID="dev-home" pageColumn="dashboard">
            <HomeHubReadingColumn>
                <NavigationLargeTitleProvider largeTitle={phone}>
                    <PageHeader
                        title={t('homeIndex.greetingAfternoon', { name: 'Leeroy' })}
                        alwaysShowTitle
                        details={<HubStatusLineView working={firstRunWorld ? 0 : 2} inbox={firstRunWorld ? 0 : 1} home={renderHomeLine} />}
                        actions={(
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                                {props.brief || phone ? null : <VoiceBriefButtonView onOpen={NEVER_OPENS} />}
                                <HubCustomizeButton open={false} onOpenChange={NEVER_OPENS} />
                            </View>
                        )}
                    />
                </NavigationLargeTitleProvider>
            </HomeHubReadingColumn>
            {phone && !props.brief ? (
                <ItemGroup surface="none"><VoiceBriefButtonView onOpen={NEVER_OPENS} block /></ItemGroup>
            ) : null}
            {props.brief ? <HomeHubReadingColumn><VoiceBriefList brief={LAB_BRIEF} onOpen={NEVER_OPENS} /></HomeHubReadingColumn> : null}
            <HomeHubSectionList
                sections={sections}
                leadCardId={firstRunWorld ? resolveHomeHubFirstRunLeadId(sections) : null}
                renderSection={(section, _index, placement) => {
                    const testID = `home-hub.section.${section.id}`;
                    if (props.showcase && (section.kind === 'widget' || section.id === 'automations')) {
                        return <ShowcaseCard key={section.id} id={section.id} testID={testID} placement={placement}
                            size={section.kind === 'widget' ? section.size : undefined} noMachine={props.firstRun} />;
                    }
                    switch (section.id) {
                        case 'start':
                            return <React.Fragment key={section.id}>{firstRunWorld ? <FirstRunComposer create={props.create} createProvider={props.createProvider} /> : <HubComposerSection suggestions="tiles" />}</React.Fragment>;
                        case 'attention':
                            // Nothing needs a person who has nothing running yet: the section draws nothing, as on Home.
                            return firstRunWorld ? null : <React.Fragment key={section.id}><HubAttentionList items={labAttention(theme.colors.text.secondary)} /></React.Fragment>;
                        case 'setup':
                            return <React.Fragment key={section.id}><HubSetupGridView items={setupItems} phone={phone} openId={props.voice && props.voice !== 'SA' ? VOICE_SETUP_STEP_ID : undefined} /></React.Fragment>;
                        case 'usage':
                            return <React.Fragment key={section.id}><ItemGroup title={t('settingsOverview.usageTitle')} surface="none"><HubUsageCardGrid entries={LAB_USAGE} /></ItemGroup></React.Fragment>;
                        case 'automations':
                            return (
                                <WidgetFrame
                                    key={section.id}
                                    testID={testID}
                                    frameStyle="card"
                                    placement="home"
                                    fill
                                    mark="timer"
                                    title={t('homeWidgets.latestRunsTitle')}
                                    meta={<SurfaceAsOfLabel at={NOW} />}
                                    body={{ kind: 'content', children: <>{LAB_RUNS.map((row) => <LatestRunRow key={row.run.id} row={row} onOpen={NEVER_OPENS} />)}</> }}
                                    footer={{ kind: 'open', label: t('homeWidgets.open', { destination: t('navigation.automations') }), onPress: NEVER_OPENS }}
                                />
                            );
                        default:
                            if (section.kind === 'widget' && section.widget) {
                                return (
                                    <WidgetFrame
                                        key={section.id}
                                        testID={testID}
                                        frameStyle="card"
                                        placement="home"
                                        fill
                                        mark={section.widget.icon}
                                        title={section.widget.title}
                                        source={section.widget.pluginName}
                                        meta={<Text style={{  ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.link }}>4 new</Text>}
                                        body={{ kind: 'content', children: <LabRows rows={[
                                            ['git-pull-request', '#2493 Retry relay handshake on 503', 'Review requested · 12m'],
                                            ['git-pull-request', '#2491 Settings search ranking', 'Your PR · checks passed'],
                                            ['circle', '#918 Home popover shows raw host', 'Assigned to you · 1h'],
                                            ['circle', '#915 Composer loses draft on resize', 'Mentioned you · 3h'],
                                        ]} unread /> }}
                                        footer={{ kind: 'open', label: t('homeWidgets.open', { destination: section.widget.pluginName }), onPress: NEVER_OPENS }}
                                    />
                                );
                            }
                            return null;
                    }
                }}
            />
        </ItemList>
    );
}
