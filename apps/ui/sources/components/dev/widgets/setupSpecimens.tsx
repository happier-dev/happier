import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDataChart, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SheetDismissProvider } from '@/modal/components/card/sheetDragDismiss';
import { WIDGET_SIZE_POLICY_V1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildHomeWidgetAddSections } from '@/components/widgets/add/HomeWidgetAddPopover';
import { WIDGET_ADD_SURFACE_PX, WidgetAddPanel } from '@/components/widgets/add/WidgetAddSurface';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { buildWidgetCandidateSetup, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for the Edit inputs step and the Add to Home surface (lab `dashboards` dbind E,
 * `widget-add` wsplit A): the real step and surface at static props. Inputs come first; the preview
 * is a fixed stand-in body in the real frame, since a live body needs a running runtime.
 */

const NOOP = (): void => {};
const ACCEPT = async () => ({ ok: true as const });

const SUMMARY: WidgetCandidate = {
    sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
    surface: { pluginId: 'happier.channels', localId: 'session-conversations-widget' },
    key: 'happier.channels/session-conversations-widget',
    title: 'External conversations',
    pluginName: 'Channels',
    sharedPluginName: false,
    icon: 'chat-circle',
    homeDefault: 'available',
    target: 'session',
    sessionInputPath: 'session',
    inputs: { fields: [{ path: 'session', title: 'Session', description: 'Home has no session of its own, so pick one.', widget: 'json', required: true }] },
};
const CHECKS: WidgetCandidate = {
    sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
    surface: { pluginId: 'happier.scm-github', localId: 'checks' },
    key: 'happier.scm-github/checks',
    title: 'Checks',
    description: 'The checks on one branch',
    pluginName: 'GitHub',
    sharedPluginName: false,
    icon: 'check-circle',
    homeDefault: 'available',
    target: 'session',
    sessionInputPath: 'session',
    inputs: { fields: [
        { path: 'session', title: 'Session', widget: 'json', required: true },
        { path: 'branch', title: 'Branch', widget: 'select', required: true, options: [
            { value: 'relay-retry', label: 'relay-retry' }, { value: 'main', label: 'main' },
            { value: 'release', label: 'release' }, { value: 'settings-modal', label: 'settings-modal' },
        ] },
        { path: 'period', title: 'Period', widget: 'select', required: true, options: [
            { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' },
        ] },
        // On a shared Board a connection is each viewer's own (lab dscope Q3): shown, never asked.
        { path: 'account', title: 'GitHub account', widget: 'select', connectedAccountOptions: true },
    ] },
    connectedAccountPurposeBindings: [{ path: 'account', purpose: 'checks-read', consumer: { pluginId: 'happier.scm-github', localId: 'checks' } }],
};
const LATEST: WidgetCandidate = {
    sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
    surface: { pluginId: 'happier.triage', localId: 'latest' },
    key: 'happier.triage/latest',
    title: 'New for you',
    description: 'PRs and issues waiting on you',
    pluginName: 'PRs & Issues',
    sharedPluginName: false,
    icon: 'git-pull-request',
    homeDefault: 'shown',
    target: 'app',
};
const BOARD_SESSION: WidgetSurfaceContext = {
    session: { ref: { serverId: 'specimen', sessionId: 'relay' }, label: 'Retry relay handshake on 503' },
};

const stylesheet = StyleSheet.create((theme) => ({
    desktop: { width: 800 },
    phone: { width: 390 },
    row: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text.primary },
    sub: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.secondary },
}));

function StandInChecks(): React.ReactElement {
    return (
        <WidgetFrame
            testID="specimen-setup-preview"
            frameStyle="card"
            placement="board"
            mark="check-circle"
            title="Checks"
            source="GitHub"
            body={{
                kind: 'content',
                children: (
                    <View style={{ gap: 6 }}>
                        {[['build · web', 'Passed · 3m 02s'], ['test · relay soak', 'Running · 6 min'], ['test · ui', 'Passed · 11m 12s']].map(([title, sub]) => (
                            <View key={title}>
                                <Text style={stylesheet.row} numberOfLines={1}>{title}</Text>
                                <Text style={stylesheet.sub} numberOfLines={1}>{sub}</Text>
                            </View>
                        ))}
                    </View>
                ),
            }}
        />
    );
}

function Step(props: Readonly<{ phone: boolean; kind: 'home' | 'board' }>) {
    const setup = React.useMemo(() => (props.kind === 'home'
        ? buildWidgetCandidateSetup({
            candidate: SUMMARY,
            context: {},
            audience: 'personal',
            mode: { kind: 'add', submitLabel: t('widgetAdd.addToHome') },
            submit: ACCEPT,
            renderPreview: () => <StandInChecks />,
        })
        : buildWidgetCandidateSetup({
            candidate: CHECKS,
            context: BOARD_SESSION,
            audience: 'shared',
            mode: { kind: 'add', submitLabel: t('widgetAdd.addToBoard') },
            submit: ACCEPT,
            renderPreview: () => <StandInChecks />,
        })), [props.kind]);
    return (
        <View style={props.phone ? stylesheet.phone : stylesheet.desktop}>
            <FloatingOverlay maxHeight={900}>
                <WidgetSetupStep setup={setup} phone={props.phone} onCancel={NOOP} onDone={NOOP} testID={`specimen-setup-${props.kind}`} />
            </FloatingOverlay>
        </View>
    );
}

const copy = (id: string, candidate: WidgetCandidate): WidgetInstanceV1 => ({
    v: 1, id, definition: candidate.surface ? { kind: 'installed', surface: candidate.surface } : candidate.definition!, bindings: {},
});

// An Account definition (Your widgets) whose saved read is served by the analytics plugin.
const SIGNUPS: WidgetCandidate = {
    sizeDeclaration: { sizes: ['small', 'medium', 'wide'], defaultSize: 'medium' },
    definition: { kind: 'artifact', artifactId: 'signups' },
    key: 'artifact:signups',
    title: 'Signups this week',
    description: 'New people per day, against last week',
    pluginName: 'analytics replica',
    bodyKind: 'declarative',
    madeBy: { author: { kind: 'agent' }, createdAt: Date.UTC(2026, 9, 3, 12) },
    sharedPluginName: false,
    icon: 'chart-bar',
    homeDefault: 'available',
    target: 'app',
};
const HOME_SCOPE = { serverId: 'specimen', accountId: 'specimen', owner: { kind: 'home' as const } };

/** The saved query's real body nodes (the public metric and chart) at static data. */
function StandInSignups(): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const days = [['Thu', 142], ['Fri', 168], ['Sat', 151], ['Sun', 189], ['Mon', 214], ['Tue', 236], ['Wed', 183]] as const;
    return (
        <View style={{ gap: 12 }}>
            <HappierDataMetric label="Signups this week" value={1284} theme={presentationTheme}
                comparison={{ value: '+18%', label: 'vs the week before', meaning: 'good' }} />
            <HappierDataChart label="Signups per day" style="bar" theme={presentationTheme} points={days.map(([x, y]) => ({ x, y }))} />
        </View>
    );
}

/**
 * The Add to Home surface (lab `widget-add` wsplit A0/A1/A2 and its phone push): the real surface
 * and the real Home sections at static props, nothing selected or opened on one widget.
 */
function HomeAdd(props: Readonly<{ phone: boolean; entry?: string }>) {
    const sections = React.useMemo(() => {
        // Built in (lab dbind G): Happier's own widgets, apart from what plugins add.
        const builtIn = selectBuiltinWidgetCandidates();
        const summary = builtIn.find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        return buildHomeWidgetAddSections({
            candidates: [...builtIn, CHECKS, LATEST, SIGNUPS],
            instances: [copy('a', summary), copy('b', summary), copy('c', CHECKS), copy('d', CHECKS), copy('default:happier.triage/latest', LATEST)],
            addInstance: async () => {},
            scope: HOME_SCOPE,
            renderSetupPreview: (candidate) => (candidate.key === SIGNUPS.key ? <StandInSignups /> : <StandInChecks />),
        });
    }, []);
    const panel = (
        <WidgetAddPanel
            testID={`specimen-add-home${props.entry ? `-${props.entry}` : ''}`}
            title={t('widgetAdd.homeTitle')}
            hint={t('widgetAdd.homeHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={t('widgetAdd.addToHome')}
            composition={props.phone ? 'push' : 'split'}
            phone={props.phone}
            sections={sections}
            {...(props.entry ? { initialEntryId: props.entry } : {})}
            onRequestClose={NOOP}
        />
    );
    return props.phone ? (
        // The phone's bottom sheet: the same card frame `WidgetSheetShell` opens.
        <View style={[stylesheet.phone, { height: 760, justifyContent: 'flex-end' }]}>
            <SheetDismissProvider onDismiss={NOOP}>
                <ModalCardFrame header="none" title={t('widgetAdd.homeTitle')} presentation="sheet" testID="specimen-add-home.sheet">{panel}</ModalCardFrame>
            </SheetDismissProvider>
        </View>
    ) : (
        <View style={{ width: WIDGET_ADD_SURFACE_PX.width }}>
            <FloatingOverlay maxHeight={WIDGET_ADD_SURFACE_PX.height} scrollEnabled={false}>
                <View style={{ height: WIDGET_ADD_SURFACE_PX.height }}>{panel}</View>
            </FloatingOverlay>
        </View>
    );
}

export const SETUP_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    SU: ({ phone }) => <Step kind="home" phone={phone} />,
    SUb: ({ phone }) => <Step kind="board" phone={phone} />,
    WA0: ({ phone }) => <HomeAdd phone={phone} />,
    WA1: ({ phone }) => <HomeAdd phone={phone} entry={`plugin-${SIGNUPS.key}`} />,
    WA2: ({ phone }) => <HomeAdd phone={phone} entry="plugin-builtin:session_summary" />,
};
