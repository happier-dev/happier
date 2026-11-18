import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AvatarGradient } from '@/components/ui/avatar/AvatarGradient';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { APP_RAIL_AVATAR_SIZE_PX, APP_RAIL_ICON_GLYPH_SIZE_PX, APP_RAIL_ITEM_SLOT_PX, APP_RAIL_WIDTH_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { PreviewRows, PreviewStage } from '@/components/settings/session/SessionListPreview';
import { t } from '@/text';

/**
 * Previews for "Where to keep new coordinators". Each tile renders the real surface at static props: the
 * session list's own row presentation (with its own group heading) for the two list placements, and the
 * app rail's metrics and Bot avatar for the rail. Nothing reads a session, a pin or the rail's state.
 */

const SAMPLE_IDS = ['happier-sample-a', 'happier-sample-b', 'happier-sample-c'] as const;
const COORDINATOR_ID = 'happier-coordinator-sample';

export const CoordinatorKeepRailPreview = React.memo(function CoordinatorKeepRailPreview() {
    return <PreviewStage>
        <View style={styles.railScene}>
            <View style={styles.rail}>
                <View style={styles.railSlot}><Icon name="chat" size={APP_RAIL_ICON_GLYPH_SIZE_PX} /></View>
                <View style={styles.railSlot}><Icon name="tray" size={APP_RAIL_ICON_GLYPH_SIZE_PX} /></View>
                {/* The Bot sits in the tile's visible height: it is what this option is about. */}
                <View style={styles.railSlot}><AvatarGradient id={COORDINATOR_ID} size={APP_RAIL_AVATAR_SIZE_PX} /></View>
            </View>
            <View style={styles.railPane}>
                <PreviewRows density="minimal" ids={SAMPLE_IDS} />
            </View>
        </View>
    </PreviewStage>;
});

/** Kept at the top of the list, the coordinator's row sits above the project groups; otherwise it is one row among its project's. */
export const CoordinatorKeepListPreview = React.memo(function CoordinatorKeepListPreview(props: Readonly<{ pinned: boolean }>) {
    const coordinator = t('settingsCoordination.previewCoordinator');
    return <PreviewStage>
        {props.pinned ? <>
            <PreviewRows density="minimal" ids={[COORDINATOR_ID]} titles={[coordinator]} />
            <CollectionListGroupLabel title="happier" mark={<Icon name="folder" size={13} />} />
            <PreviewRows density="minimal" ids={SAMPLE_IDS.slice(0, 2)} />
        </> : <>
            <CollectionListGroupLabel title="happier" mark={<Icon name="folder" size={13} />} first />
            <PreviewRows density="minimal" ids={[SAMPLE_IDS[0], COORDINATOR_ID, SAMPLE_IDS[1]]} titles={[t('settingsSessionPages.preview.userMessage'), coordinator]} />
        </>}
    </PreviewStage>;
});

const styles = StyleSheet.create((theme) => ({
    railScene: { flexDirection: 'row', alignItems: 'stretch', minHeight: 240 },
    rail: { width: APP_RAIL_WIDTH_PX, alignItems: 'center', paddingTop: 8, backgroundColor: theme.colors.surface.inset },
    railSlot: { height: APP_RAIL_ITEM_SLOT_PX, alignItems: 'center', justifyContent: 'center' },
    railPane: { flex: 1, paddingTop: 8 },
}));
