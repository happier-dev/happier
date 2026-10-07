import * as React from 'react';
import { View } from 'react-native';
import { AvatarGradient } from '@/components/ui/avatar/AvatarGradient';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { SessionListRowPresentation, SessionListRowSubtitle, SessionListRowTitle } from '@/components/sessions/shell/row/SessionListRowPresentation';
import { sessionListStyles } from '@/components/sessions/shell/sessionListStyles';
import {
    SESSION_LIST_ROW_IDENTITY_METRICS,
    resolveSessionListDensityViewState,
    type SessionListRowDensity,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';

// A viewport onto normal-sized rows, matching the other session settings previews.
const CANVAS_WIDTH = 320;
const PREVIEW_SCALE = 0.34;
const SAMPLE_IDS = ['happier-sample-a', 'happier-sample-b', 'happier-sample-c', 'happier-sample-d'] as const;

function PreviewStage(props: Readonly<{ children: React.ReactNode }>) {
    return <View
        style={{ flex: 1, overflow: 'hidden' }}
        pointerEvents="none"
        accessible={false}
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
    >
        <View style={{ width: CANVAS_WIDTH, transform: [{ scale: PREVIEW_SCALE }], transformOrigin: 'top left' }}>
            {props.children}
        </View>
    </View>;
}

function PreviewRows(props: Readonly<{ density: SessionListRowDensity; ids: readonly string[]; project?: string }>) {
    const showIdentity = props.density !== 'minimal';
    return <>{props.ids.map((id, index) => <SessionListRowPresentation
        key={id}
        density={props.density}
        first={index === 0}
        last={index === props.ids.length - 1}
        identity={showIdentity ? <AvatarGradient id={id} size={SESSION_LIST_ROW_IDENTITY_METRICS[props.density].slotSize} /> : null}
        title={<SessionListRowTitle density={props.density}>{t('settingsSessionPages.preview.userMessage')}</SessionListRowTitle>}
    >
        {props.density === 'default'
            ? <SessionListRowSubtitle density={props.density}>{props.project ?? '~/happier'}</SessionListRowSubtitle>
            : null}
    </SessionListRowPresentation>)}</>;
}

/** Static props feed the same physical row presentation as the mounted list. */
export const SessionListDensityPreview = React.memo(function SessionListDensityPreview(props: Readonly<{
    density: 'detailed' | 'cozy' | 'narrow';
}>) {
    const viewState = resolveSessionListDensityViewState(props.density);
    const rowDensity: SessionListRowDensity = viewState.compactMinimal ? 'minimal' : viewState.compact ? 'compact' : 'default';
    return <PreviewStage><PreviewRows density={rowDensity} ids={SAMPLE_IDS} /></PreviewStage>;
});

export const SessionListLayoutPreview = React.memo(function SessionListLayoutPreview(props: Readonly<{
    layout: `layout:${SessionListLayoutChoice}`;
}>) {
    // Representative groups, not a second arrangement policy: only the sample
    // headings change. The real layout writer and reader still own the choice.
    const headings = props.layout === 'layout:projects'
        ? ['~/happier', '~/website']
        : props.layout === 'layout:recent_activity'
            ? [t('sessionHistory.today'), t('sessionHistory.yesterday')]
            : [t('common.active'), t('common.inactive')];
    return <PreviewStage>{headings.map((heading, index) => <React.Fragment key={heading}>
        <View style={sessionListStyles.groupHeaderSection}>
            <Eyebrow style={sessionListStyles.groupHeaderTitle}>{heading}</Eyebrow>
        </View>
        <PreviewRows density="minimal" ids={SAMPLE_IDS.slice(index * 2, index * 2 + 2)} project={heading} />
    </React.Fragment>)}</PreviewStage>;
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
    width: number;
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
        {props.groups.map((group) => <React.Fragment key={group.heading}>
            <View style={sessionListStyles.groupHeaderSection}>
                <Eyebrow style={sessionListStyles.groupHeaderTitle}>{group.heading}</Eyebrow>
            </View>
            {group.rows.map((row, index) => <SessionListRowPresentation
                key={row.id}
                density={density}
                first={index === 0}
                last={index === group.rows.length - 1}
                statusTone={row.status?.tone === 'attention' ? 'attention' : undefined}
                identity={density === 'minimal' ? null : <AvatarGradient id={row.id} size={SESSION_LIST_ROW_IDENTITY_METRICS[density].slotSize} />}
                title={<SessionListRowTitle density={density}>{row.title}</SessionListRowTitle>}
                trailing={density === 'minimal' && row.status
                    ? <SessionListRowSubtitle density={density} style={workStatusWordStyle(row.status.tone)}>{row.status.label}</SessionListRowSubtitle>
                    : null}
            >
                {density !== 'minimal' ? (
                    <SessionListRowSubtitle density={density} style={row.status ? workStatusWordStyle(row.status.tone) : null}>
                        {row.status?.label ?? row.project}
                    </SessionListRowSubtitle>
                ) : null}
            </SessionListRowPresentation>)}
        </React.Fragment>)}
    </View>;
}
