import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { StageDevice } from './DeviceFrame';
import { stageVisualTokens } from './stageVisualTokens';

/**
 * The stage renders a real app surface behind a lazily imported chunk. While
 * that chunk is in flight the stage used to paint a bare rectangle, which is
 * pixel-identical to an intentional planet-only beat — a broken beat and a
 * loading beat were indistinguishable, so neither the user nor QA could tell
 * them apart. These fallbacks give the two states an honest shape:
 *
 * - `StageSurfaceSkeleton` reads as the app shell arriving inside the device
 *   chrome (sidebar column + detail column, or a single column on phone);
 * - `StageSurfaceUnavailable` states plainly that the surface did not load.
 *
 * The rows reuse the shared `SelectionListSkeletonRow` primitive so the pulse,
 * reduced-motion behavior, theming, and assistive-tech hiding stay owned in one
 * place instead of being re-implemented for the stage.
 */

const SIDEBAR_SKELETON_ROWS = 7;
const DETAIL_SKELETON_ROWS = 5;
// The desktop shell draws its traffic lights over the top-left of the content,
// so the skeleton starts below them instead of underneath.
const SIDEBAR_SKELETON_TOP_INSET_PX = 64;
const DETAIL_SKELETON_TOP_INSET_PX = 24;

function SkeletonRows(props: Readonly<{ count: number; testID: string }>): React.ReactElement {
    return (
        <>
            {Array.from({ length: props.count }, (_unused, index) => (
                <SelectionListSkeletonRow
                    key={index}
                    index={index}
                    testID={`${props.testID}-row-${index}`}
                />
            ))}
        </>
    );
}

export function StageDetailSkeleton(props: Readonly<{ testID?: string }>): React.ReactElement {
    const styles = stylesheet;
    const testID = props.testID ?? 'stage-surface-skeleton-detail';
    return (
        <View testID={testID} style={styles.detail}>
            <View testID={`${testID}-header`} style={styles.detailHeader} />
            <SkeletonRows count={DETAIL_SKELETON_ROWS} testID={testID} />
        </View>
    );
}

export function StageSurfaceSkeleton(props: Readonly<{
    device: StageDevice;
    testID?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const testID = props.testID ?? 'stage-surface-skeleton';

    if (props.device === 'phone') {
        return (
            <View testID={testID} style={styles.root}>
                <StageDetailSkeleton testID={`${testID}-detail`} />
            </View>
        );
    }

    return (
        <View testID={testID} style={styles.root}>
            <View testID={`${testID}-sidebar`} style={styles.sidebar}>
                <SkeletonRows count={SIDEBAR_SKELETON_ROWS} testID={`${testID}-sidebar`} />
            </View>
            <StageDetailSkeleton testID={`${testID}-detail`} />
        </View>
    );
}

export function StageSurfaceUnavailable(props: Readonly<{ testID?: string }>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={props.testID ?? 'stage-surface-unavailable'} style={styles.unavailable}>
            <Text style={styles.unavailableLabel}>{t('common.unavailable')}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        backgroundColor: theme.colors.background.canvas,
        flex: 1,
        flexDirection: 'row',
        minHeight: 0,
        minWidth: 0,
    },
    sidebar: {
        borderRightColor: theme.colors.border.default,
        borderRightWidth: StyleSheet.hairlineWidth,
        flexShrink: 0,
        minHeight: 0,
        overflow: 'hidden',
        paddingTop: SIDEBAR_SKELETON_TOP_INSET_PX,
        width: stageVisualTokens.appShell.sidebarWidth,
    },
    detail: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        paddingTop: DETAIL_SKELETON_TOP_INSET_PX,
    },
    detailHeader: {
        backgroundColor: theme.colors.surface.inset,
        borderCurve: 'continuous',
        borderRadius: 8,
        height: 40,
        marginBottom: 24,
        marginHorizontal: 16,
    },
    unavailable: {
        alignItems: 'center',
        backgroundColor: theme.colors.background.canvas,
        flex: 1,
        justifyContent: 'center',
    },
    unavailableLabel: {
        color: theme.colors.text.secondary,
    },
}));
