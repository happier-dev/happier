import * as React from 'react';

import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionCompanionContentItem } from '../sessionCompanionContentModel';
import type { SessionCompanionInstanceView } from '../SessionCompanionItemFrame';
import { ChangesGlance } from './ChangesGlance';
import { LocalServicesGlance } from './LocalServicesGlance';
import { PaneLinkRow, sessionCompanionPaneLabel } from './PaneLinkRow';
import { PluginGlance } from './PluginGlance';

/** The Companion items that are glances or pane links rather than Board widgets (lab C1, bounded C3). */
export type SessionCompanionGlanceItem = Extract<SessionCompanionContentItem, { kind: 'changes' | 'local_services' | 'pane' | 'instance' }>;

export function isSessionCompanionGlanceItem(entry: SessionCompanionContentItem): entry is SessionCompanionGlanceItem {
    return entry.kind === 'changes' || entry.kind === 'local_services' || entry.kind === 'pane' || entry.kind === 'instance';
}

/** What a glance is called in its menu and reorder announcements. */
export function sessionCompanionGlanceLabel(entry: SessionCompanionGlanceItem): string {
    switch (entry.kind) {
        case 'changes': return t('widgetGlances.changesTitle');
        case 'local_services': return t('widgetGlances.localServicesTitle');
        case 'pane': return sessionCompanionPaneLabel(entry.ref.paneId);
        case 'instance': {
            const instance = entry.ref.instance;
            const definition = instance.definition;
            return instance.displayName ?? (definition.kind === 'installed' ? definition.surface.localId
                : definition.kind === 'builtin' ? definition.id
                : definition.kind === 'artifact' ? definition.artifactId : definition.definition.name);
        }
    }
}

/**
 * One glance or pane link in the Companion, in the widget frame (lab WC, WC3): the built-in Changes
 * and Local services glances, a link row for any other pane, and a plugin's compact glance. Each
 * reads its own owner in its own leaf, so one glance's data never re-renders the column.
 */
export function SessionCompanionGlance(props: Readonly<{
    entry: SessionCompanionGlanceItem;
    sessionId: string;
    session: Session;
    serverId?: string | null;
    frameStyle: WidgetFrameStyle;
    headerAccessory: React.ReactNode;
    /** A direct personal copy's rename field and repair line. */
    instanceView?: SessionCompanionInstanceView;
    measurementOnly: boolean;
    testID: string;
}>): React.ReactElement | null {
    const common = {
        sessionId: props.sessionId,
        serverId: props.serverId ?? null,
        frameStyle: props.frameStyle,
        menu: props.headerAccessory,
        measurementOnly: props.measurementOnly,
        testID: props.testID,
    };
    switch (props.entry.kind) {
        case 'changes': return <ChangesGlance {...common} />;
        case 'local_services': return <LocalServicesGlance {...common} />;
        case 'pane': return <PaneLinkRow {...common} paneId={props.entry.ref.paneId} />;
        case 'instance': return <PluginGlance {...common} session={props.session} instance={props.entry.ref.instance} {...(props.instanceView ? { instanceView: props.instanceView } : {})} />;
    }
}

/**
 * A built-in glance as the add popover's gallery tile shows it: the real glance at the Companion's
 * default frame, with no action and no machine request (Changes reads the session's cached
 * snapshot; Local services shows its frame until it is added and visible).
 */
export function SessionCompanionGlancePreview(props: Readonly<{
    kind: 'changes' | 'local_services';
    sessionId: string;
    serverId: string | null;
    testID: string;
}>): React.ReactElement {
    const common = {
        sessionId: props.sessionId,
        serverId: props.serverId,
        frameStyle: 'plain' as const,
        measurementOnly: true,
        testID: props.testID,
    };
    return props.kind === 'changes' ? <ChangesGlance {...common} /> : <LocalServicesGlance {...common} />;
}
