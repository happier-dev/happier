import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { WIDGET_SIZE_POLICY_V1 } from '@happier-dev/protocol/widgets';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { WIDGET_ADD_SURFACE_PX, WidgetAddPanel } from '@/components/widgets/add/WidgetAddSurface';
import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from '@/components/widgets/add/widgetAddSections';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { projectSessionBoard } from '@/sync/domains/session/board';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for the one Add surface on a Session Board and the Companion (lab `widget-add`
 * wsplit A, `cwidgets` WC3): the real surface and the real section builders at static props.
 */

const NOOP = (): void => {};

function candidate(pluginId: string, localId: string, title: string, pluginName: string, icon: WidgetCandidate['icon']): WidgetCandidate {
    return {
        sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.sessionBoard.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.sessionBoard.defaultSize },
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
        ['relay', boardItem('Relay retries, last 90 min', { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main></main>'), requestedCapabilities: {} })],
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

const stylesheet = StyleSheet.create(() => ({
    surfacePhone: { width: 390 },
}));

/** The real Add surface at its desktop composition, or the phone's pushed list. */
function Surface(props: Readonly<{ phone: boolean; children: React.ReactNode }>) {
    return props.phone ? (
        <View style={stylesheet.surfacePhone}><FloatingOverlay maxHeight={900}>{props.children}</FloatingOverlay></View>
    ) : (
        <View style={{ width: WIDGET_ADD_SURFACE_PX.width }}>
            <FloatingOverlay maxHeight={WIDGET_ADD_SURFACE_PX.height} scrollEnabled={false}>
                <View style={{ height: WIDGET_ADD_SURFACE_PX.height }}>{props.children}</View>
            </FloatingOverlay>
        </View>
    );
}

function BoardAdd(props: Readonly<{ phone: boolean }>) {
    const content = React.useMemo(() => buildBoardWidgetAddContent({
        intents: ['note', 'interactiveView', 'fromPlugins', 'askAgent'],
        candidates: CANDIDATES,
        snapshot: BOARD,
        run: NOOP,
        openPlugins: NOOP,
    }), []);
    return (
        <Surface phone={props.phone}>
            <WidgetAddPanel
                testID="specimen-add-board"
                title={t('widgetAdd.boardTitle')}
                hint={t('widgetAdd.boardHint')}
                searchPlaceholder={t('widgetAdd.searchWidgets')}
                addLabel={t('widgetAdd.addToBoard')}
                composition={props.phone ? 'push' : 'split'}
                sections={content.sections}
                {...(content.ask ? { ask: content.ask } : {})}
                phone={props.phone}
                onRequestClose={NOOP}
            />
        </Surface>
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
        <Surface phone={props.phone}>
            <WidgetAddPanel
                testID="specimen-add-companion"
                title={t('widgetAdd.companionTitle')}
                hint={t('widgetAdd.companionHint')}
                searchPlaceholder={t('widgetAdd.searchCompanion')}
                addLabel={t('widgetAdd.addToCompanion')}
                composition="push"
                sections={sections}
                phone={props.phone}
                onRequestClose={NOOP}
            />
        </Surface>
    );
}

export const ADD_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    WB: ({ phone }) => <BoardAdd phone={phone} />,
    WC3add: ({ phone }) => <CompanionAdd phone={phone} />,
};
