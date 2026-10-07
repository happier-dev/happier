import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { WIDGET_SIZE_POLICY_V1 } from '@happier-dev/protocol/widgets';

import { HubAttentionList, type AttentionItem } from '@/components/hub/HubAttentionSection';
import { HomeHubSectionList } from '@/components/hub/HomeHubSectionList';
import { HomeWhereLine } from '@/components/homes/journeys/label/HomeWhereLine';
import { AlreadyUseHappierTile } from '@/components/homes/journeys/alreadyUse/AlreadyUseHappierTile';
import { useJourneyAccountService } from '@/components/homes/journeys/useJourneyAccountService';
import { HubSetupGridView } from '@/components/hub/HubSetupSection';
import { VOICE_SETUP_STEP_ID } from '@/voice/settings/setup/useVoiceSetupItem';
import { buildVoiceSetupFixtureItem, LAB_BRIEF, type VoiceSetupFixtureFrame } from './voiceSetupFixtures';
import { VoiceBriefButtonView, VoiceBriefList } from '@/components/voice/brief/VoiceBrief';
import { View } from 'react-native';
import { HubUsageSectionView } from '@/components/hub/HubUsageSection';
import { HubCustomizeButton } from '@/components/hub/header/HubCustomizeButton';
import { HubStatusLineView } from '@/components/hub/header/HubStatusLine';
import { HOME_HUB_BUILTIN_SECTIONS } from '@/components/hub/homeHubSections';
import { HOME_HUB_DEFAULT_LAYOUT, resolveHomeHubLayout, setHomeHubSectionHidden } from '@/components/hub/layout/homeHubLayout';
import type { UsageSummaryEntry } from '@/components/hub/usage/useUsageSummary';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HubComposerSection } from '@/components/hub/composer/HubComposerSection';
import { LatestRunRow } from '@/components/automations/home/AutomationsLatestRunsSection';
import { automationRunTone, type LatestAutomationRunRow } from '@/components/automations/home/latestAutomationRuns';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
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

export function HomeHubSpecimen(props: Readonly<{ machines: boolean; firstRun?: boolean; voice?: VoiceSetupFixtureFrame | null; brief?: boolean }>) {
    const { theme } = useUnistyles();
    const phone = !useIsTablet();
    const service = useJourneyAccountService();
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
        ...labSetup(phone),
    ], [phone, props.firstRun, props.voice, service]);
    const widgets = React.useMemo(() => [LAB_WIDGET], []);
    const layout = React.useMemo(() => (props.machines
        ? setHomeHubSectionHidden(HOME_HUB_DEFAULT_LAYOUT, HOME_HUB_BUILTIN_SECTIONS, widgets, 'machines', false)
        : HOME_HUB_DEFAULT_LAYOUT), [props.machines, widgets]);
    const sections = React.useMemo(
        () => resolveHomeHubLayout(layout, HOME_HUB_BUILTIN_SECTIONS, widgets).sections,
        [layout, widgets],
    );

    return (
        <ItemList testID="dev-home">
            <PageHeader
                title={t('homeIndex.greetingAfternoon', { name: 'Leeroy' })}
                titleProminence={phone ? 'hero' : 'page'}
                alwaysShowTitle
                details={<HubStatusLineView working={2} needsYou={1} home={renderHomeLine} />}
                actions={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        {props.brief || phone ? null : <VoiceBriefButtonView onOpen={NEVER_OPENS} />}
                        <HubCustomizeButton open={false} onOpenChange={NEVER_OPENS} />
                    </View>
                )}
            />
            {phone && !props.brief ? (
                <ItemGroup surface="none"><VoiceBriefButtonView onOpen={NEVER_OPENS} block /></ItemGroup>
            ) : null}
            {props.brief ? <VoiceBriefList brief={LAB_BRIEF} onOpen={NEVER_OPENS} /> : null}
            <HomeHubSectionList
                sections={sections}
                renderSection={(section) => {
                    const testID = `home-hub.section.${section.id}`;
                    switch (section.id) {
                        case 'start':
                            return <React.Fragment key={section.id}><HubComposerSection /></React.Fragment>;
                        case 'attention':
                            return <React.Fragment key={section.id}><HubAttentionList items={labAttention(theme.colors.text.secondary)} /></React.Fragment>;
                        case 'setup':
                            return <React.Fragment key={section.id}><HubSetupGridView items={setupItems} phone={phone} openId={props.voice && props.voice !== 'SA' ? VOICE_SETUP_STEP_ID : undefined} /></React.Fragment>;
                        case 'usage':
                            return <React.Fragment key={section.id}><HubUsageSectionView entries={LAB_USAGE} asOf={NOW} /></React.Fragment>;
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
                                    source={t('navigation.automations')}
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
                                        meta={<Text style={{ ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.link }}>4 new</Text>}
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
