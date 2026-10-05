import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetAddPanel } from '@/components/widgets/add/WidgetAddPanel';
import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from '@/components/widgets/add/widgetAddSections';
import type { WidgetAddView } from '@/components/widgets/add/widgetAddModel';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { projectSessionBoard } from '@/sync/domains/session/board';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for the one Add popover (lab `cwidgets` WG/WGp, WL/WLp and the Companion's WC3
 * popover): the real panel and the real section builders at static props. A plugin tile's live
 * preview needs a running plugin runtime, so here it shows a fixed stand-in body.
 */

const NOOP = (): void => {};

function candidate(pluginId: string, localId: string, title: string, pluginName: string, icon: WidgetCandidate['icon']): WidgetCandidate {
    return {
        surface: { pluginId, localId },
        key: `${pluginId}/${localId}`,
        title,
        pluginName,
        sharedPluginName: false,
        icon,
        homeDefault: 'available',
        target: 'session',
    };
}

const CANDIDATES: readonly WidgetCandidate[] = [
    candidate('happier.triage', 'branch-pr', 'This branch’s PR', 'PRs & Issues', 'git-pull-request'),
    candidate('happier.channels', 'session-conversations-widget', 'External conversations', 'Channels', 'chat-circle'),
];

function boardItem(title: string, source: SessionSurfaceItemV1['source']) {
    const value: SessionSurfaceItemV1 = { v: 1, title, frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source };
    return { revision: 'r1', outcome: { status: 'ready' as const, value } };
}

const BOARD = projectSessionBoard({
    layout: undefined,
    items: new Map([
        ['checklist', boardItem('Release checklist', { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('- [x] Backoff capped at 5 attempts') })],
        ['relay', boardItem('Relay retries, last 90 min', { kind: 'hostedHtml', source: { kind: 'html', html: '<main></main>' }, requestedCapabilities: {} })],
        ['conv', boardItem('External conversations', { kind: 'widget', instance: {
            v: 1, id: 'conv', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'session-conversations-widget' } }, bindings: {},
        } })],
    ]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

const stylesheet = StyleSheet.create((theme) => ({
    surface: { width: 560 },
    surfaceList: { width: 420 },
    surfacePhone: { width: 390 },
    row: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text.primary },
    sub: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.secondary },
}));

function StandInPreview(props: Readonly<{ lines: readonly [string, string][] }>) {
    return (
        <View style={{ gap: 6 }}>
            {props.lines.map(([title, sub]) => (
                <View key={title}>
                    <Text style={stylesheet.row} numberOfLines={1}>{title}</Text>
                    <Text style={stylesheet.sub} numberOfLines={1}>{sub}</Text>
                </View>
            ))}
        </View>
    );
}

const PREVIEWS: Readonly<Record<string, readonly [string, string][]>> = {
    'happier.triage/branch-pr': [['#2493 Retry relay handshake on 503', 'Open · Review requested from Ana'], ['3 of 4 checks passed', 'test · cli (windows) failed']],
    'happier.channels/session-conversations-widget': [['Release crew', 'Telegram group · Ana replied 2 min ago'], ['#happier-dev', 'Discord channel · paused']],
};

function BoardAdd(props: Readonly<{ view: WidgetAddView; phone: boolean }>) {
    const content = React.useMemo(() => buildBoardWidgetAddContent({
        intents: ['note', 'interactiveView', 'fromPlugins', 'askAgent'],
        candidates: CANDIDATES,
        snapshot: BOARD,
        run: NOOP,
        renderPluginPreview: (row) => <StandInPreview lines={PREVIEWS[row.key] ?? []} />,
        openPlugins: NOOP,
    }), []);
    return (
        <View style={props.phone ? stylesheet.surfacePhone : props.view === 'gallery' ? stylesheet.surface : stylesheet.surfaceList}>
            <FloatingOverlay maxHeight={900}>
                <WidgetAddPanel
                    testID={`specimen-add-${props.view}`}
                    title={t('widgetAdd.boardTitle')}
                    hint={t('widgetAdd.boardHint')}
                    searchPlaceholder={t('widgetAdd.searchWidgets')}
                    view={props.view}
                    onViewChange={NOOP}
                    sections={content.sections}
                    {...(content.ask ? { ask: content.ask } : {})}
                    phone={props.phone}
                    onRequestClose={NOOP}
                />
            </FloatingOverlay>
        </View>
    );
}

function CompanionAdd(props: Readonly<{ phone: boolean }>) {
    const sections = React.useMemo(() => buildCompanionWidgetAddSections({
        refs: [
            { kind: 'builtin', id: 'session_summary' },
            { kind: 'builtin', id: 'changes' },
            { kind: 'pane', paneId: 'terminal' },
            { kind: 'pane', paneId: 'agents' },
        ],
        snapshot: BOARD,
        glanceCandidates: [CANDIDATES[0]!],
        pluginProjection: null,
        addItem: NOOP,
        renderNotePreview: (document) => <SessionBoardDeclarativeContent document={document} actionBinding={null} />,
    }), []);
    return (
        <View style={props.phone ? stylesheet.surfacePhone : stylesheet.surface}>
            <FloatingOverlay maxHeight={900}>
                <WidgetAddPanel
                    testID="specimen-add-companion"
                    title={t('widgetAdd.companionTitle')}
                    hint={t('widgetAdd.companionHint')}
                    searchPlaceholder={t('widgetAdd.searchCompanion')}
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

export const ADD_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    WG: ({ phone }) => <BoardAdd view="gallery" phone={phone} />,
    WL: ({ phone }) => <BoardAdd view="list" phone={phone} />,
    WC3add: ({ phone }) => <CompanionAdd phone={phone} />,
};
