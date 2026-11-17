import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { EmbedStyleV1 } from '@happier-dev/protocol/embed';

import { EmbeddedChatPreview } from '@/components/settings/session/SessionSettingPreviews';
import { ThemeColorTokenRow, describeContrastPairs } from '@/components/settings/appearance/themeProfiles/ThemeColorTokenRow';
import { resolveThemeProfileEditorDraft } from '@/components/settings/appearance/themeProfiles/themeProfileEditorModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { resolveEmbedThemeApplication } from '@/embed/style/embedStyleTheme';
import { isRuntimeWebFontFileUrl } from '@/platform/installWebFontFaces';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { THEME_PROFILE_TOKEN_DEFINITIONS } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import { applyThemeStyleScales, resolveThemeStyleScales, type ThemeRadiusScaleName } from '@/theme/themeStyleScales';
import { t, type TranslationKeyNoParams } from '@/text';

import { EMBED_SETTINGS } from '../embedsSettings';
import type { EmbedDraftSectionProps } from './EmbedAccessSections';

type EmbedStyle = EmbedStyleV1;
const EMPTY_STYLE: EmbedStyle = { v: 1 };
const HAPPIER_PRESET = 'happier';
const CORNER_OPTIONS: ReadonlyArray<readonly [ThemeRadiusScaleName, TranslationKeyNoParams]> = [
    ['sharp', 'settingsEmbeds.appearance.cornersSharp'],
    ['soft', 'settingsEmbeds.appearance.cornersSoft'],
    ['round', 'settingsEmbeds.appearance.cornersRound'],
];

/** The colour groups Settings shows (plan 04 §6.2): the token ids come from the one token registry. */
const COLOR_GROUPS: ReadonlyArray<Readonly<{ titleKey: TranslationKeyNoParams; matches: (tokenId: string) => boolean }>> = [
    { titleKey: 'settingsEmbeds.appearance.colorGroups.surface', matches: (id) => id.startsWith('background.') || id.startsWith('surface.') || id.startsWith('border.') },
    { titleKey: 'settingsEmbeds.appearance.colorGroups.text', matches: (id) => id.startsWith('text.') },
    { titleKey: 'settingsEmbeds.appearance.colorGroups.accent', matches: (id) => id.startsWith('control.button.') },
    { titleKey: 'settingsEmbeds.appearance.colorGroups.messages', matches: (id) => id.startsWith('message.') },
    { titleKey: 'settingsEmbeds.appearance.colorGroups.composer', matches: (id) => id.startsWith('composer.') || id.startsWith('control.input.') },
    { titleKey: 'settingsEmbeds.appearance.colorGroups.approvals', matches: (id) => id.startsWith('permission.') || id.startsWith('control.permissionButton.') },
];

const stylesheet = StyleSheet.create((theme) => ({
    reset: {
        alignItems: 'flex-start',
        paddingTop: theme.space.s8,
        // On the sheets' text edge, level with the page's closing review below it.
        marginHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    },
}));

function withStyle(props: EmbedDraftSectionProps, patch: Partial<EmbedStyle>) {
    const style = { ...(props.draft.config.style ?? EMPTY_STYLE), ...patch };
    props.onChange({ ...props.draft, config: { ...props.draft.config, style } });
}

/** Static preset props keep theme resolution and real miniature children out of draft-name edits. */
const PresetPreview = React.memo(function PresetPreview(props: Readonly<{ presetId: string | null; mode: ThemeProfileMode }>) {
    const profile = props.presetId
        ? BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === props.presetId)?.profile ?? null
        : null;
    return <EmbeddedChatPreview appearance={resolveThemeProfile({ mode: props.mode, profile })} />;
});

/** A corner tile: the same embedded chat window with that scale's bubble and composer radii. */
function CornerPreview(props: Readonly<{ radius: ThemeRadiusScaleName }>) {
    const { theme } = useUnistyles();
    const appearance = React.useMemo(() => applyThemeStyleScales(theme, resolveThemeStyleScales({ radius: props.radius })), [theme, props.radius]);
    return <EmbeddedChatPreview appearance={appearance} />;
}

const EmbedColorsDisclosure = React.memo(function EmbedColorsDisclosure(props: EmbedDraftSectionProps) {
    const [expanded, setExpanded] = React.useState(false);
    const [invalid, setInvalid] = React.useState<ReadonlySet<string>>(() => new Set());
    const style = props.draft.config.style ?? EMPTY_STYLE;
    // Colours are kept per mode. A fixed mode opens on its own colours; System edits either.
    const [editedMode, setEditedMode] = React.useState<ThemeProfileMode>(() => (style.mode === 'dark' ? 'dark' : 'light'));
    const mode: ThemeProfileMode = style.mode === 'light' || style.mode === 'dark' ? style.mode : editedMode;
    const profile = resolveEmbedThemeApplication(style).themeProfiles.profiles[0]!;
    // One resolution per mode for every row, as the theme editor does.
    const resolved = resolveThemeProfileEditorDraft(profile, mode).tokens;
    const customized = Object.keys(style.colors?.light ?? {}).length + Object.keys(style.colors?.dark ?? {}).length;
    const setColor = (tokenId: string, value: string | null) => {
        const current = { ...(style.colors?.[mode] ?? {}) };
        if (value === null) delete current[tokenId];
        else current[tokenId] = value;
        withStyle(props, { colors: { ...style.colors, [mode]: current } });
    };
    return (
        <ExpandableItem
            testID="settings-embed-colors"
            expanded={expanded}
            onExpandedChange={setExpanded}
            header={({ headerProps }) => (
                <Item
                    {...headerProps}
                    testID="settings-embed-colors-header"
                    title={t('settingsEmbeds.appearance.colors')}
                    detail={customized === 0 ? t('settingsEmbeds.appearance.colorsDefault') : t('settingsEmbeds.appearance.colorsCustomized', { count: customized })}
                />
            )}
        >
            {style.mode === 'light' || style.mode === 'dark' ? null : (
                <SegmentedChoiceItem<ThemeProfileMode>
                    testID="settings-embed-colors-mode"
                    testIDPrefix="settings-embed-colors-mode"
                    title={t('settingsEmbeds.appearance.colorsFor')}
                    options={[
                        { id: 'light', label: t('settingsEmbeds.appearance.modeLight') },
                        { id: 'dark', label: t('settingsEmbeds.appearance.modeDark') },
                    ]}
                    value={editedMode}
                    onChange={setEditedMode}
                />
            )}
            {COLOR_GROUPS.map((group) => (
                <React.Fragment key={group.titleKey}>
                    <Item title={t(group.titleKey)} mode="info" showChevron={false} density="compact" />
                    {THEME_PROFILE_TOKEN_DEFINITIONS.filter((token) => group.matches(token.id)).map((token) => (
                        <ThemeColorTokenRow
                            key={`${mode}:${token.id}`}
                            value={resolved[token.id]!.value}
                            changed={resolved[token.id]!.changed}
                            contrastAgainst={describeContrastPairs(resolved[token.id]!.contrast.warnings)}
                            contrastFix={resolved[token.id]!.contrast.fix}
                            mode={mode}
                            token={token}
                            invalid={invalid.has(token.id)}
                            recentColors={[]}
                            onChange={(tokenId, value) => setColor(tokenId, value)}
                            onInvalidChange={(tokenId, isInvalid) => setInvalid((current) => {
                                const next = new Set(current);
                                if (isInvalid) next.add(tokenId);
                                else next.delete(tokenId);
                                return next;
                            })}
                            onReset={(tokenId) => setColor(tokenId, null)}
                        />
                    ))}
                </React.Fragment>
            ))}
        </ExpandableItem>
    );
});

/**
 * Appearance (presentation, plan 04 §6.2): every control maps onto the theme owner through
 * `EmbedStyleV1`, and the live preview follows each change.
 */
export const EmbedAppearanceSection = React.memo(function EmbedAppearanceSection(props: EmbedDraftSectionProps) {
    const style = props.draft.config.style ?? EMPTY_STYLE;
    const previewMode: ThemeProfileMode = style.mode === 'dark' ? 'dark' : 'light';
    const [fontUrl, setFontUrl] = React.useState(style.typography?.fontUrl ?? '');
    const fontUrlRefused = fontUrl.trim().length > 0 && !isRuntimeWebFontFileUrl(fontUrl.trim());
    const setTypography = (patch: NonNullable<EmbedStyle['typography']>) => withStyle(props, { typography: { ...style.typography, ...patch } });

    return (
        <>
            <ItemGroup title={t('settingsEmbeds.appearance.title')} description={t('settingsEmbeds.appearance.description')}>
                <SettingAnchor setting={EMBED_SETTINGS.settings.mode}>
                    <SegmentedChoiceItem
                        testID="settings-embed-mode"
                        testIDPrefix="settings-embed-mode"
                        title={t('settingsEmbeds.appearance.mode')}
                        options={[
                            { id: 'system', label: t('settingsEmbeds.appearance.modeSystem') },
                            { id: 'light', label: t('settingsEmbeds.appearance.modeLight') },
                            { id: 'dark', label: t('settingsEmbeds.appearance.modeDark') },
                        ]}
                        value={style.mode ?? 'system'}
                        onChange={(mode) => withStyle(props, { mode })}
                    />
                </SettingAnchor>
                <SettingRow setting={EMBED_SETTINGS.settings.theme} accessoryLayout="stacked" showChevron={false} rightElement={(
                    <SelectionTiles
                        variant="visual"
                        testIdPrefix="settings-embed-preset"
                        accessibilityLabel={t('settingsEmbeds.appearance.theme')}
                        value={style.preset ?? HAPPIER_PRESET}
                        onChange={(next) => withStyle(props, { preset: !next || next === HAPPIER_PRESET ? undefined : next })}
                        options={[
                            { id: HAPPIER_PRESET, title: t('settingsEmbeds.appearance.presetHappier'), preview: <PresetPreview presetId={null} mode={previewMode} /> },
                            ...BUILT_IN_THEME_PROFILES.map((definition) => ({
                                id: definition.presetId,
                                title: t(definition.translationKey),
                                preview: <PresetPreview presetId={definition.presetId} mode={definition.preferredMode} />,
                            })),
                        ]}
                    />
                )} />
                <SettingAnchor setting={EMBED_SETTINGS.settings.colors}>
                    <EmbedColorsDisclosure {...props} />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup>
                <SettingRow setting={EMBED_SETTINGS.settings.fontFamily} accessoryLayout="adaptive" showChevron={false} rightElement={(
                    <FieldTextInput
                        testID="settings-embed-font-family"
                        accessibilityLabel={t('settingsEmbeds.appearance.fontFamily')}
                        placeholder={t('settingsEmbeds.appearance.fontFamilyPlaceholder')}
                        value={style.typography?.fontFamily ?? ''}
                        onChangeText={(fontFamily) => setTypography({ fontFamily: fontFamily || undefined })}
                    />
                )} />
                <SettingRow
                    setting={EMBED_SETTINGS.settings.fontFile}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="settings-embed-font-url"
                            accessibilityLabel={t('settingsEmbeds.appearance.fontFile')}
                            placeholder="https://fonts.example.com/font.woff2"
                            value={fontUrl}
                            keyboardType="url"
                            inputMode="url"
                            autoCapitalize="none"
                            monospace
                            error={fontUrlRefused ? t('settingsEmbeds.appearance.fontFileRefused') : null}
                            onChangeText={(next) => {
                                setFontUrl(next);
                                const trimmed = next.trim();
                                if (!trimmed) setTypography({ fontUrl: undefined });
                                else if (isRuntimeWebFontFileUrl(trimmed)) setTypography({ fontUrl: trimmed });
                            }}
                        />
                    )}
                />
                <SettingAnchor setting={EMBED_SETTINGS.settings.textSize}>
                    <SegmentedChoiceItem
                        testID="settings-embed-text-size"
                        testIDPrefix="settings-embed-text-size"
                        title={t('settingsEmbeds.appearance.textSize')}
                        options={[
                            { id: 'compact', label: t('settingsEmbeds.appearance.textSizeCompact') },
                            { id: 'default', label: t('settingsEmbeds.appearance.textSizeDefault') },
                            { id: 'large', label: t('settingsEmbeds.appearance.textSizeLarge') },
                        ]}
                        value={style.typography?.scale ?? 'default'}
                        onChange={(scale) => setTypography({ scale })}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup>
                <SettingRow setting={EMBED_SETTINGS.settings.corners} accessoryLayout="stacked" showChevron={false} rightElement={(
                    <SelectionTiles
                        variant="visual"
                        testIdPrefix="settings-embed-corners"
                        accessibilityLabel={t('settingsEmbeds.appearance.corners')}
                        value={style.radius ?? 'soft'}
                        onChange={(radius) => withStyle(props, { radius: radius ?? undefined })}
                        options={CORNER_OPTIONS.map(([radius, titleKey]) => ({
                            id: radius,
                            title: t(titleKey),
                            preview: <CornerPreview radius={radius} />,
                        }))}
                    />
                )} />
                <SettingAnchor setting={EMBED_SETTINGS.settings.density}>
                    <SegmentedChoiceItem
                        testID="settings-embed-density"
                        testIDPrefix="settings-embed-density"
                        title={t('settingsEmbeds.appearance.density')}
                        options={[
                            { id: 'compact', label: t('settingsEmbeds.appearance.densityCompact') },
                            { id: 'comfortable', label: t('settingsEmbeds.appearance.densityComfortable') },
                        ]}
                        value={style.density ?? 'comfortable'}
                        onChange={(density) => withStyle(props, { density })}
                    />
                </SettingAnchor>
            </ItemGroup>
            {/* An operation row in the page column, with the sections' gutter (it was clipped at the column edge). */}
            <ItemGroup surface="none">
            <View style={stylesheet.reset}>
                <RoundButton
                    testID="settings-embed-appearance-reset"
                    size="small"
                    display="secondary"
                    title={t('settingsEmbeds.appearance.reset')}
                    disabled={props.draft.config.style === null}
                    onPress={() => {
                        setFontUrl('');
                        props.onChange({ ...props.draft, config: { ...props.draft.config, style: null } });
                    }}
                />
            </View>
            </ItemGroup>
        </>
    );
});
