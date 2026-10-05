import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildHomeWidgetAddSections } from '@/components/widgets/add/HomeWidgetAddPopover';
import { WidgetAddPanel } from '@/components/widgets/add/WidgetAddPanel';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { buildWidgetCandidateSetup, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for the Set up / Edit inputs step and the instance-aware Add to Home gallery
 * (lab `dashboards` dadd A/Ab, dbind G/E): the real step and panel at static props. Inputs come first;
 * the preview is a fixed stand-in body in the real frame, since a live body needs a running runtime.
 */

const NOOP = (): void => {};
const ACCEPT = async () => ({ ok: true as const });

const SUMMARY: WidgetCandidate = {
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
    surface: { pluginId: 'happier.scm-github', localId: 'checks' },
    key: 'happier.scm-github/checks',
    title: 'Checks',
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
    surface: { pluginId: 'happier.triage', localId: 'latest' },
    key: 'happier.triage/latest',
    title: 'New for you',
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
    gallery: { width: 560 },
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
                <WidgetSetupStep setup={setup} phone={props.phone} onBack={NOOP} onCancel={NOOP} onDone={NOOP} testID={`specimen-setup-${props.kind}`} />
            </FloatingOverlay>
        </View>
    );
}

const copy = (id: string, candidate: WidgetCandidate): WidgetInstanceV1 => ({
    v: 1, id, definition: candidate.surface ? { kind: 'installed', surface: candidate.surface } : candidate.definition!, bindings: {},
});

function HomeGallery(props: Readonly<{ phone: boolean }>) {
    const sections = React.useMemo(() => {
        // Built in (lab dbind G): Happier's own widgets, apart from what plugins add.
        const builtIn = selectBuiltinWidgetCandidates();
        const summary = builtIn.find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        return buildHomeWidgetAddSections({
            candidates: [...builtIn, CHECKS, LATEST],
            instances: [copy('a', summary), copy('b', summary), copy('c', CHECKS), copy('d', CHECKS), copy('default:happier.triage/latest', LATEST)],
            addInstance: async () => {},
            scope: null,
        });
    }, []);
    return (
        <View style={props.phone ? stylesheet.phone : stylesheet.gallery}>
            <FloatingOverlay maxHeight={900}>
                <WidgetAddPanel
                    testID="specimen-add-home"
                    title={t('widgetAdd.homeTitle')}
                    hint={t('widgetAdd.homeHint')}
                    searchPlaceholder={t('widgetAdd.searchWidgets')}
                    view="gallery"
                    onViewChange={NOOP}
                    sections={sections}
                    phone={props.phone}
                    onRequestClose={NOOP}
                />
            </FloatingOverlay>
        </View>
    );
}

export const SETUP_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    SU: ({ phone }) => <Step kind="home" phone={phone} />,
    SUb: ({ phone }) => <Step kind="board" phone={phone} />,
    GH: ({ phone }) => <HomeGallery phone={phone} />,
};
