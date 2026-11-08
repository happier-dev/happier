import * as React from 'react';

import type { WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionCompanionContentItem } from '../sessionCompanionContentModel';
import type { SessionCompanionInstanceView } from '../SessionCompanionItemFrame';
import { ChangesGlance } from './ChangesGlance';
import { EnvironmentGlance } from './EnvironmentGlance';
import { LinksGlance } from './LinksGlance';
import { RunningGlance } from './RunningGlance';
import { UsageGlance } from './UsageGlance';
import { LocalServicesGlance } from './LocalServicesGlance';
import { PaneLinkRow, sessionCompanionPaneLabel } from './PaneLinkRow';
import { PluginGlance } from './PluginGlance';

/** The Companion items that are glances or pane links rather than Board widgets (lab C1, bounded C3). */
export type SessionCompanionGlanceItem = Extract<SessionCompanionContentItem, { kind: SessionCompanionGlanceKind }>;

type SessionCompanionGlanceKind = 'changes' | 'local_services' | 'environment' | 'running' | 'usage' | 'links' | 'pane' | 'instance';
const GLANCE_KINDS: ReadonlySet<SessionCompanionContentItem['kind']> = new Set<SessionCompanionGlanceKind>(['changes', 'local_services', 'environment', 'running', 'usage', 'links', 'pane', 'instance']);

export function isSessionCompanionGlanceItem(entry: SessionCompanionContentItem): entry is SessionCompanionGlanceItem {
    return GLANCE_KINDS.has(entry.kind);
}

/** What a glance is called in its menu and reorder announcements. */
export function sessionCompanionGlanceLabel(entry: SessionCompanionGlanceItem): string {
    switch (entry.kind) {
        case 'changes': return t('widgetGlances.changesTitle');
        case 'local_services': return t('widgetGlances.localServicesTitle');
        case 'environment': return t('sessionCompanion.sections.environment');
        case 'running': return t('sessionCompanion.sections.running');
        case 'usage': return t('sessionCompanion.sections.usage');
        case 'links': return t('sessionCompanion.sections.links');
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
    /** False until the item is first in view: a plugin's executable body waits for it. */
    bodyPresented?: boolean;
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
        case 'environment': return <EnvironmentGlance {...common} session={props.session} />;
        case 'running': return <RunningGlance {...common} session={props.session} />;
        case 'usage': return <UsageGlance {...common} session={props.session} />;
        case 'links': return <LinksGlance {...common} />;
        case 'pane': return <PaneLinkRow {...common} paneId={props.entry.ref.paneId} />;
        case 'instance': return <PluginGlance {...common} session={props.session} instance={props.entry.ref.instance} bodyPresented={props.bodyPresented !== false} {...(props.instanceView ? { instanceView: props.instanceView } : {})} />;
    }
}

/**
 * A built-in glance as the add popover's gallery tile shows it: the real glance at the Companion's
 * default frame, with no action and no machine request (Changes reads the session's cached
 * snapshot; Local services shows its frame until it is added and visible).
 */
export function SessionCompanionGlancePreview(props: Readonly<{
    kind: 'changes' | 'local_services' | 'environment' | 'running' | 'usage' | 'links';
    session: Session;
    sessionId: string;
    serverId: string | null;
    testID: string;
}>): React.ReactElement | null {
    const common = {
        sessionId: props.sessionId,
        serverId: props.serverId,
        frameStyle: 'plain' as const,
        measurementOnly: true,
        testID: props.testID,
    };
    switch (props.kind) {
        case 'changes': return <ChangesGlance {...common} />;
        case 'local_services': return <LocalServicesGlance {...common} />;
        case 'environment': return <EnvironmentGlance {...common} session={props.session} />;
        case 'usage': return <UsageGlance {...common} session={props.session} />;
        case 'links': return <LinksGlance {...common} />;
        // Running reads live feeds; a closed gallery starts none, so its tile shows its name only.
        case 'running': return null;
    }
}
