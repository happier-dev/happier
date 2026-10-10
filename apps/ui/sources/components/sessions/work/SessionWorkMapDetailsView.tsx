import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { useSessionWorkSources } from './sessionWorkSources';
import { SessionWorkMapView } from './SessionWorkMapView';
import { useSessionWorkMap } from './useSessionWorkMap';

export const SESSION_WORK_MAP_DETAILS_TAB_KIND = 'sessionWorkMap';

/** The Work map, expanded into the Details pane (⤢, lab `session-B`). One tab per lead Session. */
export function createSessionWorkMapDetailsTab(params: Readonly<{ sessionId: string }>): DetailsTab {
    return {
        key: `${SESSION_WORK_MAP_DETAILS_TAB_KIND}:${params.sessionId}`,
        kind: SESSION_WORK_MAP_DETAILS_TAB_KIND,
        title: t('sessionWork.title'),
        subtitle: null,
        resource: { kind: SESSION_WORK_MAP_DETAILS_TAB_KIND, sessionId: params.sessionId },
    };
}

export function isSessionWorkMapDetailsResource(value: unknown): value is Readonly<{ kind: typeof SESSION_WORK_MAP_DETAILS_TAB_KIND; sessionId: string }> {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as { kind?: unknown; sessionId?: unknown };
    return candidate.kind === SESSION_WORK_MAP_DETAILS_TAB_KIND && typeof candidate.sessionId === 'string';
}

const stylesheet = StyleSheet.create(() => ({
    scroll: { flex: 1, minHeight: 0 },
    content: { padding: 16 },
}));

export const SessionWorkMapDetailsView = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
}>) => {
    const styles = stylesheet;
    const sources = useSessionWorkSources();
    const session = useSessionViewShellSession(props.sessionId, props.serverId);
    const projection = sources && sources.sessionId === props.sessionId ? sources.projection : null;
    const { map, openItem } = useSessionWorkMap({
        sessionId: props.sessionId,
        serverId: props.serverId,
        scopeId: props.scopeId,
        subagents: sources?.agentActivity.subagents ?? [],
        session,
        projection,
    });
    if (!map || !projection) {
        return (
            <View style={styles.content}>
                <SurfaceStateCard testID="session-work-map-unavailable" kind="empty" title={t('sessionWork.empty.title')} />
            </View>
        );
    }
    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <SessionWorkMapView map={map} projection={projection} testIDPrefix="session-work-map-details" onOpenItem={openItem} />
        </ScrollView>
    );
});
