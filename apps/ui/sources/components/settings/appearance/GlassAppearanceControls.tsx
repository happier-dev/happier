import * as React from 'react';
import { Linking, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AtmospherePreview } from '@/components/atmosphere/look/AtmospherePreview';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { LookPanelBlock, LookSegments } from '@/components/atmosphere/look/LookControls';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_DESKTOP_DOWNLOAD_URL } from '@/constants/downloadUrls';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { isNativeBlurAvailable } from '@/components/ui/glass/blurMaterial';
import { resolveGlassCapability } from '@/components/ui/glass/resolveGlassCapability';
import { useLiquidGlassAvailable } from '@/components/ui/glass/liquidGlass';

import { useGlassAppearance } from '@/components/ui/glass/useGlassAppearance';
import { useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { GLASS_PRESETS, readGlassMaterials, readGlassPreset, resolveGlassSurfaceMaterial, resolveGlassPresetSettingsDelta, type GlassMaterialChoice, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import { readGlassSurfaceMode } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Slider } from '@/components/ui/forms/Slider';
import { useSettingPreview } from '@/sync/store/settingsPreview';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { openDesktopReduceTransparencySettings } from '@/utils/platform/desktopGlassMaterial';
import { Modal } from '@/modal';
import { t } from '@/text';
import { lightTheme } from '@/theme';
import { ThemePalettePreview } from './ThemeModePreview';
import { APPEARANCE_SETTINGS } from './appearanceSettings';
import { AtmosphereAppearanceRows, AtmosphereWhereItShows } from './AtmosphereAppearanceRows';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { useSettingMutable } from '@/sync/store/hooks';
import type { NewSessionBackdropStrengthV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { lookCopy } from '@/components/atmosphere/look/LookControls';

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
            <AtmospherePreview />
            {props.children ?? <ThemePalettePreview palette={props.palette ?? lightTheme} materials={readGlassMaterials(settings)} materialSettings={settings} materialEnvironment={{ ...environment, reduceTransparency: reduceTransparency || environment.reduceTransparency === true }} floatingOnly={!environment.desktopWindow} backdrop={<AtmospherePreview />} />}
        </View>
    </GlassMaterialSettingsProvider>;
}

const presetOptions = GLASS_PRESETS;

/**
 * The page, the Appearance popover and the Look panel share this live control owner. `tiles` is the
 * Settings page (visual tiles, preview, layers); `compact` the toolbar popover's rows; `panel` the
 * Look panel's blocks, which say only what constrains the choice and leave the desktop app to Settings.
 */
export function GlassAppearanceControls(props: Readonly<{ presentation: 'tiles' | 'compact' | 'panel' }>) {
    const surfaceSettings = [
        { group: 'content', setting: APPEARANCE_SETTINGS.settings.glassWindow },
        { group: 'chrome', setting: APPEARANCE_SETTINGS.settings.glassChrome },
        { group: 'sidebar', setting: APPEARANCE_SETTINGS.settings.glassSidebar },
        { group: 'card', setting: APPEARANCE_SETTINGS.settings.glassElements },
        { group: 'floating', setting: APPEARANCE_SETTINGS.settings.glassFloating },
    ] as const;
    const { theme } = useUnistyles();
    const appearance = useGlassAppearance();
    const previewTint = useSettingPreview('glassTintIntensity');
    const environment = useGlassRuntimeEnvironment();
    const compact = props.presentation === 'compact';
    const showBlurIntensity = Platform.OS === 'web' || isNativeBlurAvailable();
    const options = presetOptions.map(id => ({ id, title: t(`settingsAppearance.glassControls.${id}`), preview: <GlassPresetPreview preset={id} settings={appearance.settings} palette={theme} /> }));
    const blurOptions = (['light', 'regular', 'strong'] as const).map(id => ({
        id,
        label: t(id === 'light' ? 'settingsAppearance.glass.intensityLight' : id === 'regular' ? 'settingsAppearance.glass.intensityRegular' : 'settingsAppearance.glass.intensityStrong'),
    }));
    const tintDisabled = appearance.preset === 'solid' || appearance.preset === 'custom';
    const tintPercent = `${appearance.tint}%`;
    const tintSlider = <Slider
        testID="appearance-tint"
        accessibilityLabel={t(APPEARANCE_SETTINGS.settings.glassTint.titleKey)}
        min={0}
        max={100}
        step={1}
        value={appearance.tint}
        formatValueText={value => `${value}%`}
        onValueChange={appearance.setTint}
        onValuePreview={previewTint}
        disabled={tintDisabled}
    />;
    if (props.presentation === 'panel') {
        return <>
            <LookPanelBlock title={t('settingsAppearance.glassControls.title')}>
                <LookSegments<GlassMaterialChoice>
                    label={t('settingsAppearance.glassControls.material')}
                    testIDPrefix="appearance-material"
                    options={options.map(option => ({ id: option.id, label: option.title }))}
                    value={appearance.preset}
                    onChange={value => { if (value !== 'custom') appearance.selectPreset(value); }}
                />
            </LookPanelBlock>
            <GlassEffectiveStateLine settings={appearance.settings} constraintsOnly />
            {showBlurIntensity ? <LookPanelBlock title={t(APPEARANCE_SETTINGS.settings.glassIntensity.titleKey)}>
                <LookSegments
                    label={t(APPEARANCE_SETTINGS.settings.glassIntensity.titleKey)}
                    testIDPrefix="appearance-blur"
                    options={blurOptions}
                    value={appearance.intensity}
                    onChange={appearance.setIntensity}
                    disabled={appearance.preset === 'solid'}
                />
            </LookPanelBlock> : null}
            <LookPanelBlock title={t(APPEARANCE_SETTINGS.settings.glassTint.titleKey)} value={tintPercent} testID="appearance-tint-block">
                {tintSlider}
            </LookPanelBlock>
        </>;
    }
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
    // Tint scales the named presets' Elements and menu coats; authored (custom) coats apply as set.
    const tint = <Item
        testID="appearance-tint-row"
        title={t(APPEARANCE_SETTINGS.settings.glassTint.titleKey)}
        detail={tintPercent}
        disabled={tintDisabled}
        showChevron={false}
        bottomElement={<View style={styles.tintSlider}>{tintSlider}</View>}
    />;
    return <>
        {material}
        <GlassEffectiveStateLine settings={appearance.settings} />
        {showBlurIntensity ? compact ? blur : <SettingAnchor setting={APPEARANCE_SETTINGS.settings.glassIntensity}>{blur}</SettingAnchor> : null}
        {compact ? tint : <SettingAnchor setting={APPEARANCE_SETTINGS.settings.glassTint}>{tint}</SettingAnchor>}
        {!compact ? <NewSessionBackdropStrengthRow solid={appearance.preset === 'solid'} /> : null}
        {!compact ? <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.glass}>
            {surfaceSettings.filter(({ group }) => group !== 'content' || environment.desktopWindow === true).map(({ group, setting }) => <SettingAnchor key={group} setting={setting}>
                <SegmentedChoiceItem<'glass' | 'solid'>
                    title={t(setting.titleKey)}
                    subtitle={setting.descriptionKey ? t(setting.descriptionKey) : undefined}
                    subtitleLines={0}
                    testIDPrefix={`appearance-${group}`}
                    options={[{ id: 'glass', label: t('settingsAppearance.glassControls.glass') }, { id: 'solid', label: t('settingsAppearance.glassControls.solid') }]}
                    value={readGlassSurfaceMode(appearance.settings, group)}
                    onChange={mode => appearance.setSurfaceMode(group, mode)}
                />
            </SettingAnchor>)}
        </SettingSection> : null}
    </>;
}

/** The frost behind New session, Modal and Docked alike; Solid glass has no frost to set. */
function NewSessionBackdropStrengthRow(props: Readonly<{ solid: boolean }>) {
    const [strength, setStrength] = useSettingMutable('newSessionBackdropStrengthV1');
    const setting = APPEARANCE_SETTINGS.settings.newSessionBackdropStrength;
    return <SettingAnchor setting={setting}>
        <SegmentedChoiceItem<NewSessionBackdropStrengthV1>
            title={t(setting.titleKey)}
            subtitle={t('settingsAppearance.newSessionBackdropStrength.description')}
            subtitleLines={0}
            testIDPrefix="appearance-new-session-backdrop"
            options={(['subtle', 'soft', 'medium', 'rich'] as const).map(id => ({ id, label: t(`settingsAppearance.newSessionBackdropStrength.${id}`) }))}
            value={strength}
            onChange={setStrength}
            disabled={props.solid}
        />
    </SettingAnchor>;
}

/**
 * Your Home in miniature under your current glass: the greeting, the composer and the first cards over
 * the atmosphere Home shows on this device (lab Settings "Preview"). Glass and backdrop changes show here.
 */
function HomeAtmospherePreview() {
    const appearance = useGlassAppearance();
    return <GlassPresetPreview preset={appearance.preset} settings={appearance.settings} style={styles.homePreview}>
        <View style={styles.homePreviewPage} pointerEvents="none" aria-hidden>
            <View style={styles.homePreviewHeadline} />
            <GlassSurface surfaceGroup="card" finishRole="composer" style={styles.homePreviewComposer}>{null}</GlassSurface>
            <View style={styles.homePreviewCards}>
                {[0, 1, 2].map(index => <GlassSurface key={index} surfaceGroup="card" finishRole="card" style={styles.homePreviewCard}>{null}</GlassSurface>)}
            </View>
        </View>
    </GlassPresetPreview>;
}

/** What the Glass and backdrop page is for on this host; it heads that page. */
export function useGlassAppearancePurpose(): string {
    const environment = useGlassRuntimeEnvironment();
    return t(environment.desktopWindow ? 'settingsAppearance.glassControls.description' : Platform.OS === 'web' ? 'settingsAppearance.glassControls.descriptionBrowser' : 'settingsAppearance.glassControls.descriptionPhone');
}

/** The current material and backdrop in a few words, for the row that opens the page. */
export function useGlassAppearanceSummary(): string {
    const appearance = useGlassAppearance();
    const value = useSetting('homeAtmosphere');
    const backdrop = lookCopy(value.source === 'planet' ? 'sourcePlanet' : value.source === 'picture' ? 'sourcePicture' : 'sourceNone');
    return `${t(`settingsAppearance.glassControls.${appearance.preset}`)} · ${backdrop}`;
}

/** Glass and backdrop: the glass over the app, the atmosphere behind Home, and where it shows. */
export function GlassAppearanceSection() {
    return <>
        <ItemGroup title={t('settingsAppearance.glassControls.title')}>
            <SectionContentRow testID="appearance-home-preview">
                <HomeAtmospherePreview />
            </SectionContentRow>
            <GlassAppearanceControls presentation="tiles" />
        </ItemGroup>
        <ItemGroup title={t(APPEARANCE_SETTINGS.settings.homeAtmosphere.titleKey)}>
            <AtmosphereAppearanceRows />
        </ItemGroup>
        <AtmosphereWhereItShows />
    </>;
}

/** One effective-state owner for Settings, the popover and draft Personalize choices. */
export function GlassEffectiveStateLine(props: Readonly<{
    settings: GlassMaterialSettings;
    /** Only a state that constrains the choice (reduce transparency, Solid in a browser), and no desktop download. */
    constraintsOnly?: boolean;
}>) {
    const environment = useGlassRuntimeEnvironment();
    const reduced = useReduceTransparency();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = reduced || environment.reduceTransparency === true;
    const preset = readGlassPreset(props.settings);
    const floating = resolveGlassCapability({ ...environment, reduceTransparency, liquidGlassAvailable, blurAvailable: isNativeBlurAvailable(), webBlurAvailable: Platform.OS === 'web', settings: props.settings });
    const windowReason = resolveGlassSurfaceMaterial(props.settings, 'chrome', { ...environment, reduceTransparency }).reason;
    const state = reduceTransparency ? 'reduceTransparency' : preset === 'solid' ? Platform.OS === 'web' && !environment.desktopWindow ? 'effectiveBrowserSolid' : 'effectiveSolid'
        : environment.desktopWindow && windowReason === 'unavailable' ? 'effectiveUnavailable'
        : environment.desktopWindow ? preset === 'auto' ? 'effectiveLayered' : preset === 'everywhere' ? 'effectiveUniform' : 'effectiveCustom'
        : Platform.OS === 'web' ? preset === 'custom' && floating === 'solid' ? 'effectiveBrowserCustom' : 'effectiveBrowser'
        : floating === 'tint' ? 'effectiveTint' : floating === 'solid' ? 'effectiveFloatingSolid' : 'effectivePhone';
    if (props.constraintsOnly && state !== 'reduceTransparency' && state !== 'effectiveBrowserSolid') return null;
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
        titleStyle={styles.effectiveState}
        bottomElement={Platform.OS === 'web' && !environment.desktopWindow && !props.constraintsOnly ? <View style={styles.downloadAction}><TextLinkButton tone="strong" testID="appearance-desktop-download" label={t('setupOnboarding.webDesktopOnlyDesktopAppButton')} onPress={() => { void openExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }} /></View> : undefined}
    />;
}

const styles = StyleSheet.create(theme => ({
    // The lab preview's proportions: a short Home pane, its hero centred a little above the middle.
    homePreview: { aspectRatio: 2.8, borderRadius: theme.borderRadius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default },
    homePreviewPage: { ...StyleSheet.absoluteFillObject, alignItems: 'center', paddingTop: '13%', gap: theme.space.s12 },
    homePreviewHeadline: { width: '22%', height: 6, borderRadius: 3, backgroundColor: theme.colors.text.primary, opacity: 0.7 },
    homePreviewComposer: { width: '46%', height: '15%', borderRadius: theme.borderRadius.md },
    homePreviewCards: { position: 'absolute', left: '8%', right: '8%', bottom: 0, height: '22%', flexDirection: 'row', gap: '3%' },
    homePreviewCard: { flex: 1, borderTopLeftRadius: theme.borderRadius.md, borderTopRightRadius: theme.borderRadius.md },
    // The slider spans the row under its label and value, as the Look page's Strength does.
    tintSlider: { alignSelf: 'stretch' },
    effectiveState: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    downloadAction: { flexDirection: 'row', alignSelf: 'flex-start' },
}));
