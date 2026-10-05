import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Popover } from '@/components/ui/popover/Popover';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export type GitPaneLayout = 'unified' | 'tabs';
export type GitChangesLayout = 'list' | 'tree';
export type GitChangesDensity = 'comfortable' | 'compact';

/** The three display choices, each read from its one account setting (unknown values read as the default). */
export function useGitDisplaySettings() {
    const [paneLayout, setPaneLayout] = useSettingMutable('scmGitPaneLayout');
    const [changesLayout, setChangesLayout] = useSettingMutable('scmChangedFilesLayout');
    const [density, setDensity] = useSettingMutable('filesChangedFilesRowDensity');
    return {
        paneLayout: (paneLayout === 'tabs' ? 'tabs' : 'unified') as GitPaneLayout,
        changesLayout: (changesLayout === 'tree' ? 'tree' : 'list') as GitChangesLayout,
        density: (density === 'compact' ? 'compact' : 'comfortable') as GitChangesDensity,
        setPaneLayout: setPaneLayout as (next: GitPaneLayout) => void,
        setChangesLayout: setChangesLayout as (next: GitChangesLayout) => void,
        setDensity: setDensity as (next: GitChangesDensity) => void,
    };
}

/**
 * The display choices as rows (Git lab TV): Pane · Layout Unified | Tabs, then Changes · Show as
 * List | Tree and Density Default | Compact. Tree rows are always compact, so Density leaves while
 * the tree shows. The pane's popover and the phone ⋯ sheet both render these rows.
 */
export const GitDisplayOptions = React.memo(function GitDisplayOptions(props: Readonly<{ testIDPrefix?: string; paneOnly?: boolean }>) {
    const { theme } = useUnistyles();
    const prefix = props.testIDPrefix ?? 'session-git-display';
    const settings = useGitDisplaySettings();
    const iconColor = theme.colors.text.secondary;
    const layoutOptions = React.useMemo((): ReadonlyArray<SegmentedChoiceOption<GitPaneLayout>> => [
        { id: 'unified', label: t('sessionGitDisplay.layoutUnified') },
        { id: 'tabs', label: t('sessionGitDisplay.layoutTabs') },
    ], []);
    const showAsOptions = React.useMemo((): ReadonlyArray<SegmentedChoiceOption<GitChangesLayout>> => [
        { id: 'list', label: t('sessionGitDisplay.showAsList'), icon: <Icon name="list" size={14} color={iconColor} /> },
        { id: 'tree', label: t('sessionGitDisplay.showAsTree'), icon: <Icon name="tree-structure" size={14} color={iconColor} /> },
    ], [iconColor]);
    const densityOptions = React.useMemo((): ReadonlyArray<SegmentedChoiceOption<GitChangesDensity>> => [
        { id: 'comfortable', label: t('sessionGitDisplay.densityDefault') },
        { id: 'compact', label: t('sessionGitDisplay.densityCompact') },
    ], []);
    return (
        <>
            <ItemGroup title={t('sessionGitDisplay.paneGroup')}>
                <SegmentedChoiceItem<GitPaneLayout>
                    title={t('sessionGitDisplay.layout')}
                    options={layoutOptions}
                    value={settings.paneLayout}
                    onChange={settings.setPaneLayout}
                    testIDPrefix={`${prefix}-layout`}
                />
            </ItemGroup>
            {!props.paneOnly ? <ItemGroup title={t('sessionGitDisplay.changesGroup')} description={t('sessionGitDisplay.note')}>
                <SegmentedChoiceItem<GitChangesLayout>
                    title={t('sessionGitDisplay.showAs')}
                    options={showAsOptions}
                    value={settings.changesLayout}
                    onChange={settings.setChangesLayout}
                    testIDPrefix={`${prefix}-show-as`}
                />
                {settings.changesLayout === 'list' ? (
                    <SegmentedChoiceItem<GitChangesDensity>
                        title={t('sessionGitDisplay.density')}
                        options={densityOptions}
                        value={settings.density}
                        onChange={settings.setDensity}
                        testIDPrefix={`${prefix}-density`}
                    />
                ) : null}
            </ItemGroup> : null}
        </>
    );
});

/**
 * The display control beside the scope menu: its glyph shows the current layout (list or tree); it opens
 * one popover with the pane layout, list or tree, and density.
 */
export const GitDisplayMenu = React.memo(function GitDisplayMenu(props: Readonly<{ testID?: string; paneOnly?: boolean }>) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'session-git-display';
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const settings = useGitDisplaySettings();
    const close = React.useCallback(() => setOpen(false), []);
    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <IconButton
                    testID={testID}
                    variant="plain"
                    size={28}
                    icon={<Icon name={!props.paneOnly && settings.changesLayout === 'tree' ? 'tree-structure' : 'list'} size={14} color={theme.colors.text.secondary} />}
                    selected={open}
                    expanded={open}
                    hasPopup="dialog"
                    accessibilityLabel={t('sessionGitDisplay.trigger')}
                    tooltip={t('sessionGitDisplay.trigger')}
                    onPress={() => setOpen((value) => !value)}
                />
            </View>
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    placement="bottom"
                    gap={6}
                    maxWidthCap={360}
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start' }}
                    onRequestClose={close}
                    backdrop={{ enabled: true, blockOutsidePointerEvents: false }}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" containerStyle={{ width: 340 }}>
                            <View testID={`${testID}-popover`}>
                                <GitDisplayOptions testIDPrefix={testID} paneOnly={props.paneOnly} />
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </>
    );
});

/**
 * The inline list | tree switch of a change list (turn card, comparison rail, narrow comparison header):
 * the same `scmChangedFilesLayout` choice as Show as above, drawn as two icon segments.
 */
export const ChangedFilesLayoutSwitch = React.memo(function ChangedFilesLayoutSwitch(props: Readonly<{ testIDPrefix: string }>) {
    const { theme } = useUnistyles();
    const settings = useGitDisplaySettings();
    const iconColor = theme.colors.text.secondary;
    const tabs = React.useMemo((): ReadonlyArray<SegmentedTab<GitChangesLayout>> => [
        { id: 'list', label: t('sessionGitDisplay.showAsList'), icon: <Icon name="list" size={14} color={iconColor} /> },
        { id: 'tree', label: t('sessionGitDisplay.showAsTree'), icon: <Icon name="tree-structure" size={14} color={iconColor} /> },
    ], [iconColor]);
    return (
        <SegmentedTabBar<GitChangesLayout>
            testIDPrefix={props.testIDPrefix}
            role="radiogroup"
            compact
            segmentSizing="content"
            accessibilityLabel={t('sessionGitDisplay.showAs')}
            tabs={tabs}
            activeTabId={settings.changesLayout}
            onSelectTab={settings.setChangesLayout}
        />
    );
});
