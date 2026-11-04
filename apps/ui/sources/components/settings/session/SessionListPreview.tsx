import * as React from 'react';
import { View } from 'react-native';
import { AvatarGradient } from '@/components/ui/avatar/AvatarGradient';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { CollectionRowContent, CollectionRowLine, CollectionRowTitle } from '@/components/ui/lists/collection/CollectionRowContent';
import {
    SESSION_LIST_ROW_IDENTITY_METRICS,
    resolveCollectionRowDensity,
    resolveSessionListDensityViewState,
    type SessionListRowDensity,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { usePreferredLanguage, t } from '@/text';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { buildSessionListArrangementSample, type SessionListAttentionPlacementChoice } from '@/components/settings/session/sessionListArrangementSample';

// A viewport onto normal-sized rows: the stage draws a column at its own width and scales it to the
// tile, so a small natural tile and a wide filling tile both show the same rows, legibly.
const CANVAS_WIDTH = 320;
const FALLBACK_SCALE = 0.34;
const SAMPLE_IDS = ['happier-sample-a', 'happier-sample-b', 'happier-sample-c', 'happier-sample-d'] as const;

export function PreviewStage(props: Readonly<{
    /** Rows at a fixed canvas width, scaled to the tile (the default: a miniature of a whole column). */
    children: React.ReactNode | ((canvasWidth: number) => React.ReactNode);
    /**
     * Rows at a fixed scale instead, laid out at the tile's width ÷ scale: wider tiles show more of each
     * row rather than bigger rows, so a list preview reads at about the size of the list it shows.
     */
    scale?: number;
}>) {
    const [width, setWidth] = React.useState(0);
    const canvasWidth = props.scale && width > 0 ? Math.round(width / props.scale) : CANVAS_WIDTH;
    const scale = props.scale ?? (width > 0 ? width / CANVAS_WIDTH : FALLBACK_SCALE);
    return <View
        style={{ flex: 1, overflow: 'hidden' }}
        onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.width);
            setWidth((current) => current === next ? current : next);
        }}
        pointerEvents="none"
        accessible={false}
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
    >
        <View style={{ width: canvasWidth, transform: [{ scale }], transformOrigin: 'top left' }}>
            {typeof props.children === 'function' ? props.children(canvasWidth) : props.children}
        </View>
    </View>;
}

export function PreviewRows(props: Readonly<{ density: SessionListRowDensity; ids: readonly string[]; project?: string; titles?: readonly string[] }>) {
    const showIdentity = props.density !== 'minimal';
    return <>{props.ids.map((id, index) => <CollectionRowContent
        key={id}
        density={resolveCollectionRowDensity(props.density)}
        identity={showIdentity ? <AvatarGradient id={id} size={SESSION_LIST_ROW_IDENTITY_METRICS[props.density].slotSize} /> : null}
        title={<CollectionRowTitle density={resolveCollectionRowDensity(props.density)}>{props.titles?.[index] ?? t('settingsSessionPages.preview.userMessage')}</CollectionRowTitle>}
    >
        {props.density === 'default'
            ? <CollectionRowLine density={resolveCollectionRowDensity(props.density)}>{props.project ?? '~/happier'}</CollectionRowLine>
            : null}
    </CollectionRowContent>)}</>;
}

/** Static props feed the same physical row presentation as the mounted list. */
export const SessionListDensityPreview = React.memo(function SessionListDensityPreview(props: Readonly<{
    density: 'detailed' | 'cozy' | 'narrow';
}>) {
    usePreferredLanguage();
    const viewState = resolveSessionListDensityViewState(props.density);
    const rowDensity: SessionListRowDensity = viewState.compactMinimal ? 'minimal' : viewState.compact ? 'compact' : 'default';
    return <PreviewStage><PreviewRows density={rowDensity} ids={SAMPLE_IDS} /></PreviewStage>;
});

// A little under the list's own size, so the arrangement reads as the sidebar it previews.
const ARRANGEMENT_SCALE = 0.8;

/**
 * What the session list looks like under a View (layout) and a Needs you placement: a small sample
 * list arranged by the live listing owner, drawn by the real rows and group labels at static props.
 */
export const SessionListLayoutPreview = React.memo(function SessionListLayoutPreview(props: Readonly<{
    /** The View option's id (`layout:projects`, `layout:recent_activity`) or the bare layout. */
    layout: string;
    /** Where Needs you and Working sit; the list's default when omitted. */
    attention?: SessionListAttentionPlacementChoice;
    density?: 'detailed' | 'cozy' | 'narrow';
}>) {
    const language = usePreferredLanguage();
    const layout: SessionListLayoutChoice = props.layout.replace(/^layout:/, '') === 'recent_activity' ? 'recent_activity' : 'projects';
    const attention = props.attention ?? 'both';
    const groups = React.useMemo(() => buildSessionListArrangementSample(layout, attention), [layout, attention, language]);
    return <PreviewStage scale={ARRANGEMENT_SCALE}>
        {(canvasWidth) => <View style={{ paddingHorizontal: 4, paddingTop: 2 }}>
            <SessionListSample density={props.density ?? 'narrow'} groups={groups} width={canvasWidth - 8} />
        </View>}
    </PreviewStage>;
});

export type SessionListSampleRow = Readonly<{
    id: string;
    title: string;
    project: string;
    /** The row's state word, in the tone the live row uses for it. */
    status?: Readonly<{ label: string; tone: 'neutral' | 'attention' }>;
}>;

export type SessionListSampleGroup = Readonly<{ heading: string; rows: readonly SessionListSampleRow[] }>;

/**
 * A sessions column at full size for a larger preview stage (Personalize Happier): the same physical
 * row presentation as the mounted list under a density, with the groups the caller arranged. The
 * groups are sample data; the live list's arrangement stays with its own owner.
 */
export function SessionListSample(props: Readonly<{
    density: 'detailed' | 'cozy' | 'narrow';
    groups: readonly SessionListSampleGroup[];
    /** Omit to fill the stage's native content width. */
    width?: number;
}>) {
    const viewState = resolveSessionListDensityViewState(props.density);
    const density: SessionListRowDensity = viewState.compactMinimal ? 'minimal' : viewState.compact ? 'compact' : 'default';
    return <View
        style={{ width: props.width }}
        pointerEvents="none"
        accessible={false}
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
    >
        {props.groups.map((group, groupIndex) => <React.Fragment key={group.heading}>
            <CollectionListGroupLabel title={group.heading} countPlacement="title" first={groupIndex === 0} />
            {group.rows.map((row, index) => <CollectionRowContent
                key={row.id}
                density={resolveCollectionRowDensity(density)}
                identity={density === 'minimal' ? null : <AvatarGradient id={row.id} size={SESSION_LIST_ROW_IDENTITY_METRICS[density].slotSize} />}
                title={<CollectionRowTitle density={resolveCollectionRowDensity(density)}>{row.title}</CollectionRowTitle>}
                trailing={density === 'minimal' && row.status
                    ? <CollectionRowLine density={resolveCollectionRowDensity(density)} style={workStatusWordStyle(row.status.tone)}>{row.status.label}</CollectionRowLine>
                    : null}
            >
                {density !== 'minimal' ? (
                    <CollectionRowLine density={resolveCollectionRowDensity(density)} style={row.status ? workStatusWordStyle(row.status.tone) : null}>
                        {row.status?.label ?? row.project}
                    </CollectionRowLine>
                ) : null}
            </CollectionRowContent>)}
        </React.Fragment>)}
    </View>;
}
