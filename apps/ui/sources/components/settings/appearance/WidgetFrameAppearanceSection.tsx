import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetFrame, type WidgetFramePlacement, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { widgetFrameSurfaceLabel } from '@/components/widgets/frame/widgetFrameMenu';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { APPEARANCE_SETTINGS } from './appearanceSettings';

const PREVIEW_SCALE = 0.6;
const PREVIEW_HEIGHT_PX = 116;

function styleChoices(): ReadonlyArray<{ id: WidgetFrameStyle; label: string }> {
    return [
        { id: 'card', label: t('widgetFrame.styleCard') },
        { id: 'plain', label: t('widgetFrame.stylePlain') },
    ];
}

function styleLabel(style: WidgetFrameStyle): string {
    return style === 'card' ? t('widgetFrame.styleCard') : t('widgetFrame.stylePlain');
}

/** What each surface's preview shows: the frame around a familiar widget of that surface. */
const PREVIEW_CONTENT: Readonly<Record<WidgetFramePlacement, () => Readonly<{ mark: 'timer' | 'list-checks' | 'git-branch'; title: string; source: string }>>> = {
    home: () => ({ mark: 'timer', title: t('homeWidgets.latestRunsTitle'), source: t('navigation.automations') }),
    board: () => ({ mark: 'list-checks', title: t('sessionCompanion.plan.title'), source: t('sessionCompanion.status.agentFallback') }),
    companion: () => ({ mark: 'git-branch', title: t('widgetGlances.changesTitle'), source: t('widgetFrame.surfaceCompanion') }),
};

/**
 * One surface's live preview: the real widget frame at static props (no subscriptions), scaled into
 * a tile, so the Card | Plain choice is shown rather than described.
 */
const WidgetFramePreview = React.memo(function WidgetFramePreview(props: Readonly<{
    placement: WidgetFramePlacement;
    frameStyle: WidgetFrameStyle;
}>) {
    const content = PREVIEW_CONTENT[props.placement]();
    return (
        <View style={styles.mini}>
            <View style={styles.miniStage}>
                <View style={styles.miniScale}>
                    <WidgetFrame
                        testID={`settings-appearance-widgets.preview.${props.placement}`}
                        frameStyle={props.frameStyle}
                        placement={props.placement}
                        mark={content.mark}
                        title={content.title}
                        source={content.source}
                        body={{
                            kind: 'content',
                            children: (
                                <View style={styles.lines}>
                                    <View style={[styles.line, { width: '86%' }]} />
                                    <View style={[styles.line, { width: '64%' }]} />
                                    <View style={[styles.line, { width: '74%' }]} />
                                </View>
                            ),
                        }}
                    />
                </View>
            </View>
            <Text style={styles.miniLabel}>
                {t('widgetFrame.previewLabel', { surface: widgetFrameSurfaceLabel(props.placement), style: styleLabel(props.frameStyle) })}
            </Text>
        </View>
    );
});

/**
 * Settings → Appearance → Widgets (lab WK): how widgets are framed on this device, per surface —
 * Home, the Board, the Companion — each a Card | Plain choice under a live preview of all three.
 * One widget's own frame is changed from its ⋯ menu.
 */
export function WidgetFrameAppearanceSection() {
    const [home, setHome] = useLocalSettingMutable('widgetFrameStyleHome');
    const [board, setBoard] = useLocalSettingMutable('widgetFrameStyleBoard');
    const [companion, setCompanion] = useLocalSettingMutable('widgetFrameStyleCompanion');
    const settings = APPEARANCE_SETTINGS.settings;
    const choices = styleChoices();
    return (
        <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.widgets}>
            <ItemGroup title={t('widgetFrame.appearanceTitle')} description={t('widgetFrame.appearanceDescription')}>
                <SectionContentRow testID="settings-appearance-widgets.previews">
                    <View style={styles.minis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <WidgetFramePreview placement="home" frameStyle={home} />
                        <WidgetFramePreview placement="board" frameStyle={board} />
                        <WidgetFramePreview placement="companion" frameStyle={companion} />
                    </View>
                </SectionContentRow>
                <SettingAnchor setting={settings.widgetFrameHome}>
                    <SegmentedChoiceItem
                        title={t(settings.widgetFrameHome.titleKey)}
                        testIDPrefix="settings-appearance-widgets-home"
                        options={choices}
                        value={home}
                        onChange={setHome}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.widgetFrameBoard}>
                    <SegmentedChoiceItem
                        title={t(settings.widgetFrameBoard.titleKey)}
                        testIDPrefix="settings-appearance-widgets-board"
                        options={choices}
                        value={board}
                        onChange={setBoard}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.widgetFrameCompanion}>
                    <SegmentedChoiceItem
                        title={t(settings.widgetFrameCompanion.titleKey)}
                        testIDPrefix="settings-appearance-widgets-companion"
                        options={choices}
                        value={companion}
                        onChange={setCompanion}
                    />
                </SettingAnchor>
            </ItemGroup>
        </SettingSection>
    );
}

const styles = StyleSheet.create((theme) => ({
    minis: {
        flexDirection: 'row',
        gap: 12,
    },
    mini: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    miniStage: {
        height: PREVIEW_HEIGHT_PX,
        overflow: 'hidden',
        borderRadius: 10,
        backgroundColor: theme.colors.background.canvas,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        padding: 10,
    },
    miniScale: {
        width: `${100 / PREVIEW_SCALE}%`,
        transform: [{ scale: PREVIEW_SCALE }],
        transformOrigin: 'top left',
    },
    miniLabel: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    lines: {
        gap: 8,
        paddingVertical: 4,
    },
    line: {
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.border.default,
    },
}));
