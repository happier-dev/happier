import * as React from 'react';
import { Linking, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { HAPPIER_DESKTOP_DOWNLOAD_URL } from '@/constants/downloadUrls';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { resolveGlassCapability } from '@/components/ui/glass/resolveGlassCapability';
import { useLiquidGlassAvailable } from '@/components/ui/glass/liquidGlass';

import { useGlassAppearance } from '@/components/ui/glass/useGlassAppearance';
import { useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { GLASS_BLUR_STEPS, GLASS_SURFACE_GROUPS, readGlassMaterials, readGlassPreset, resolveGlassSurfaceMaterial, resolveGlassPresetSettingsDelta, type GlassMaterialChoice, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Slider } from '@/components/ui/forms/Slider';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { openDesktopReduceTransparencySettings } from '@/utils/platform/desktopGlassMaterial';
import { Modal } from '@/modal';
import { t } from '@/text';
import { lightTheme } from '@/theme';
import { ThemePalettePreview } from './ThemeModePreview';
import { APPEARANCE_SETTINGS } from './appearanceSettings';

type GlassPresetPreviewProps = Readonly<{
    preset: GlassMaterialChoice;
    settings?: GlassMaterialSettings;
    palette?: React.ComponentProps<typeof ThemePalettePreview>['palette'];
    /** Larger previews keep the real shell/list/transcript children under draft-local material. */
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export function GlassPresetPreview(props: GlassPresetPreviewProps) {
    return <GlassStagePreview {...props} />;
}

// Sample artwork from the lab's busy wallpaper, confined to illustrative previews.
// It is not a new app surface palette; light/dark coats come from the chosen theme.
const SAMPLE_WALLPAPER_COLORS = ['#17307E', '#5B2BB0', '#E2456A', '#FF9F43', '#23B5A8', '#0B6E6A'] as const;

function SampleWallpaper() {
    return <GradientSurface fallbackColor={SAMPLE_WALLPAPER_COLORS[0]} gradient={{ colors: SAMPLE_WALLPAPER_COLORS, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }} borderRadius={0} style={StyleSheet.absoluteFillObject} />;
}

function GlassStagePreview(props: GlassPresetPreviewProps) {
    const environment = useGlassRuntimeEnvironment();
    const reduceTransparency = useReduceTransparency();
    const settings = React.useMemo(() => props.preset === 'custom' ? props.settings ?? {}
        : { ...props.settings, ...resolveGlassPresetSettingsDelta(props.settings ?? {}, props.preset) }, [props.preset, props.settings]);
    const variables = resolveGlassPresentationVariables(settings, {
        ...environment,
        reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
    });
    return <GlassMaterialSettingsProvider value={settings}>
        <View style={[{ flex: 1, minWidth: 0, overflow: 'hidden' }, Platform.OS === 'web' ? variables as unknown as ViewStyle : null, props.style]}>
            <SampleWallpaper />
            {props.children ?? <ThemePalettePreview palette={props.palette ?? lightTheme} materials={readGlassMaterials(settings)} materialSettings={settings} materialEnvironment={{ ...environment, reduceTransparency: reduceTransparency || environment.reduceTransparency === true }} floatingOnly={!environment.desktopWindow} backdrop={<SampleWallpaper />} />}
        </View>
    </GlassMaterialSettingsProvider>;
}

const presetOptions = ['solid', 'auto', 'everywhere'] as const;
const surfaceSettings = {
    chrome: { blur: APPEARANCE_SETTINGS.settings.glassChromeBlur, opacity: APPEARANCE_SETTINGS.settings.glassChromeOpacity },
    sidebar: { blur: APPEARANCE_SETTINGS.settings.glassSidebarBlur, opacity: APPEARANCE_SETTINGS.settings.glassSidebarOpacity },
    content: { blur: APPEARANCE_SETTINGS.settings.glassContentBlur, opacity: APPEARANCE_SETTINGS.settings.glassContentOpacity },
    floating: { blur: APPEARANCE_SETTINGS.settings.glassFloatingBlur, opacity: APPEARANCE_SETTINGS.settings.glassFloatingOpacity },
} as const;
const customizeSettings = [
    APPEARANCE_SETTINGS.settings.glassCustomize,
    ...GLASS_SURFACE_GROUPS.flatMap(group => [surfaceSettings[group].blur, surfaceSettings[group].opacity]),
];

/** The page and popover share this live control owner; only the page's preview/disclosure differ. */
export function GlassAppearanceControls(props: Readonly<{ presentation: 'tiles' | 'compact' }>) {
    const { theme } = useUnistyles();
    const appearance = useGlassAppearance();
    const [expanded, setExpanded] = React.useState(false);
    const compact = props.presentation === 'compact';
    const options = presetOptions.map(id => ({ id, title: t(`settingsAppearance.glassControls.${id}`), preview: <GlassPresetPreview preset={id} settings={appearance.settings} palette={theme} /> }));
    const blurOptions = (['light', 'regular', 'strong'] as const).map(id => ({
        id,
        label: t(id === 'light' ? 'settingsAppearance.glass.intensityLight' : id === 'regular' ? 'settingsAppearance.glass.intensityRegular' : 'settingsAppearance.glass.intensityStrong'),
    }));
    const material = compact ? (
        <SegmentedChoiceItem
            title={t('settingsAppearance.glassControls.material')}
            testIDPrefix="appearance-material"
            options={options.map(option => ({ id: option.id, label: option.title }))}
            value={appearance.preset}
            onChange={value => { if (value !== 'custom') appearance.selectPreset(value); }}
        />
    ) : (
        <SettingRow
            setting={APPEARANCE_SETTINGS.settings.glassPreset}
            accessoryLayout="stacked"
            showChevron={false}
            rightElement={<SelectionTiles variant="visual" tileSizing="fill" testIdPrefix="appearance-material" accessibilityLabel={t('settingsAppearance.glassControls.material')} options={options} value={appearance.preset === 'custom' ? null : appearance.preset} onChange={value => { if (value) appearance.selectPreset(value); }} />}
        />
    );
    const blur = <SegmentedChoiceItem
        title={t(APPEARANCE_SETTINGS.settings.glassIntensity.titleKey)}
        testIDPrefix="appearance-blur"
        options={blurOptions}
        value={appearance.intensity}
        onChange={appearance.setIntensity}
        disabled={appearance.preset === 'solid'}
    />;
    return <>
        {material}
        <GlassEffectiveStateLine settings={appearance.settings} />
        {compact ? blur : <SettingAnchor setting={APPEARANCE_SETTINGS.settings.glassIntensity}>{blur}</SettingAnchor>}
        {!compact ? <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.glass}>
            <SettingAnchor settings={customizeSettings}>
                <ExpandableItem
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                    header={({ headerProps, expanded: isExpanded }) => <SettingAnchor setting={APPEARANCE_SETTINGS.settings.glassCustomize}>
                        <Item {...headerProps} showChevron={false} rightElement={<Icon name={isExpanded ? 'caret-up' : 'caret-down'} color={theme.colors.text.secondary} size={theme.iconSize.medium} />} testID="appearance-customize" title={t('settingsAppearance.glassControls.customize')} detail={expanded ? undefined : t(`settingsAppearance.glassControls.${appearance.preset}`)} />
                    </SettingAnchor>}
                >
                    {GLASS_SURFACE_GROUPS.map(group => <SettingAnchor key={group} settings={[surfaceSettings[group].blur, surfaceSettings[group].opacity]}>
                        <Item title={t(surfaceSettings[group].blur.titleKey)} subtitle={t(`settingsAppearance.glassControls.${group}Description`)} subtitleLines={0} showChevron={false} accessoryLayout="stacked" rightElement={<View style={styles.groupControls}>
                            <SegmentedTabBar role="radiogroup" segmentSizing="equal" targetSize="platform" testIDPrefix={`appearance-${group}-blur`} accessibilityLabel={`${t(surfaceSettings[group].blur.titleKey)} · ${t('settingsAppearance.glassControls.blur')}`} tabs={GLASS_BLUR_STEPS.map(id => ({ id, label: id === 'off' ? t('settingsAppearance.glassControls.off') : blurOptions.find(option => option.id === id)?.label ?? id }))} activeTabId={appearance.materials[group].blur} onSelectTab={blur => appearance.updateSurface(group, { blur })} />
                            {Platform.OS === 'web' ? <View>
                                <View style={styles.opacityLabels}>
                                    <Text style={styles.caption}>{t('settingsAppearance.glassControls.clear')}</Text>
                                    <Text style={styles.caption}>{t('settingsAppearance.glassControls.solid')}</Text>
                                    <Text testID={`appearance-${group}-opacity-value`} style={styles.value}>{formatOpacity(appearance.materials[group].opacity)}</Text>
                                </View>
                                <Slider testID={`appearance-${group}-opacity`} accessibilityLabel={`${t(surfaceSettings[group].opacity.titleKey)} · ${t('settingsAppearance.glassControls.opacity')}`} min={0} max={1} step={0.01} value={appearance.materials[group].opacity} onValueChange={opacity => appearance.updateSurface(group, { opacity })} formatValueText={formatOpacity} />
                            </View> : null}
                        </View>} />
                    </SettingAnchor>)}
                </ExpandableItem>
            </SettingAnchor>
        </SettingSection> : null}
    </>;
}

export function GlassAppearanceSection() {
    const environment = useGlassRuntimeEnvironment();
    return <ItemGroup title={t('settingsAppearance.glassControls.title')} description={t(environment.desktopWindow ? 'settingsAppearance.glassControls.description' : Platform.OS === 'web' ? 'settingsAppearance.glassControls.descriptionBrowser' : 'settingsAppearance.glassControls.descriptionPhone')}>
        <GlassAppearanceControls presentation="tiles" />
    </ItemGroup>;
}

/** One effective-state owner for Settings, the popover and draft Personalize choices. */
export function GlassEffectiveStateLine(props: Readonly<{ settings: GlassMaterialSettings }>) {
    const environment = useGlassRuntimeEnvironment();
    const reduced = useReduceTransparency();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = reduced || environment.reduceTransparency === true;
    const preset = readGlassPreset(props.settings);
    const floating = resolveGlassCapability({ ...environment, reduceTransparency, liquidGlassAvailable, blurAvailable: Platform.OS === 'ios', webBlurAvailable: Platform.OS === 'web', settings: props.settings });
    const hasAndroidTint = Platform.OS === 'android' && resolveGlassSurfaceMaterial(props.settings, 'floating', { ...environment, reduceTransparency }).material.opacity < 1;
    const windowReason = resolveGlassSurfaceMaterial(props.settings, 'chrome', { ...environment, reduceTransparency }).reason;
    const state = reduceTransparency ? 'reduceTransparency' : preset === 'solid' ? Platform.OS === 'web' && !environment.desktopWindow ? 'effectiveBrowserSolid' : 'effectiveSolid'
        : environment.windowActive === false ? 'effectiveInactive'
        : environment.desktopWindow && windowReason === 'unavailable' ? 'effectiveUnavailable'
        : environment.desktopWindow ? preset === 'auto' ? 'effectiveLayered' : preset === 'everywhere' ? 'effectiveUniform' : 'effectiveCustom'
        : Platform.OS === 'web' ? preset === 'custom' && floating === 'solid' ? 'effectiveBrowserCustom' : 'effectiveBrowser'
        : floating === 'solid' ? hasAndroidTint ? 'effectiveTint' : 'effectiveFloatingSolid' : 'effectivePhone';
    const openSettings = !reduceTransparency ? undefined : environment.desktopWindow ? () => openDesktopReduceTransparencySettings()
        : Platform.OS === 'android' ? () => Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS')
            : undefined;
    return <Item
        testID="appearance-effective-state"
        title={t(`settingsAppearance.glassControls.${state}`)}
        titleLines={0}
        subtitleLines={0}
        subtitle={reduceTransparency && Platform.OS === 'ios' ? t('settingsAppearance.glassControls.iosReduceTransparencyPath')
            : openSettings ? t('settingsAppearance.glassControls.osSettings') : undefined}
        onPress={openSettings ? async () => {
            let unavailable = false;
            try {
                unavailable = await openSettings() === false;
            } catch {
                unavailable = true;
            }
            if (unavailable) await Modal.alertAsync(t('common.error'), t('settingsAppearance.glassControls.osSettingsUnavailable'));
        } : undefined}
        showChevron={false}
        bottomElement={Platform.OS === 'web' && !environment.desktopWindow ? <RoundButton size="small" display="inverted" testID="appearance-desktop-download" title={t('setupOnboarding.webDesktopOnlyDesktopAppButton')} onPress={() => { void openExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }} /> : undefined}
    />;
}

const formatOpacity = (value: number) => `${Math.round(value * 100)}%`;
const styles = StyleSheet.create(theme => ({
    groupControls: { alignSelf: 'stretch', gap: PAGE_LIST_METRICS.rowPaddingVerticalPx },
    opacityLabels: { flexDirection: 'row', alignItems: 'center', gap: PAGE_LIST_METRICS.rowPaddingHorizontalPx },
    caption: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 18 },
    value: { marginLeft: 'auto', color: theme.colors.text.primary, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
}));
