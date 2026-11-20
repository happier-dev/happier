import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { themeSurfaceDataSet } from '@happier-dev/plugin-sdk/ui';
import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';

import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { isGlassComposerSurface } from '../composerSurfaceStyle';
import { instrumentStripStyles } from '../instrumentStrip/instrumentStripStyles';
import { AgentInputDocumentPreviewText } from './AgentInputDocumentPreviewText';
import {
    AGENT_INPUT_FIELD_CONTAINER_STYLE,
    AGENT_INPUT_FIELD_PADDING_Y,
    AGENT_INPUT_FIELD_TO_CHIP_RAIL_GAP_PX,
    AGENT_INPUT_NATIVE_FIELD_PADDING_Y,
    NEW_SESSION_RESTING_RAILS_HEIGHT_PX,
    resolveAgentInputBandStyle,
    resolveAgentInputPanelInnerShadowStyle,
    resolveAgentInputPanelLayoutStyle,
    resolveAgentInputPanelMaterial,
    resolveAgentInputPanelShadowStyle,
    resolveAgentInputPhonePanelLayoutStyle,
} from './agentInputChromeStyles';

/** The empty New Session field and its chrome, without the editor or live controls. */
export function AgentInputNewSessionRestingBox(props: Readonly<{ placeholder: string; trailing?: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const boundary = useAtmosphereBandBoundary();
    const glass = isGlassComposerSurface({ setting: useSetting('composerSurfaceStyle') });
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const inputSurface = { surface: 'composer', part: 'input', state: 'default' } as const;
    return (
        <View testID="new-session-composer-band" ref={boundary?.ref} onLayout={boundary?.onLayout} collapsable={false} style={styles.band}>
            <View style={[instrumentStripStyles.root, styles.fullWidth]} />
            <View style={[styles.fullWidth, glass ? styles.shadowGlass : styles.shadow]}>
                <GlassSurface
                    testID="agent-input-material-surface"
                    themeSurface={{ surface: 'composer', part: 'root', state: 'default' }}
                    {...resolveAgentInputPanelMaterial({ theme, glass })}
                    style={[styles.panel, isMobileLayoutWidth(width) ? styles.phonePanel : null, glass ? styles.innerShadow : null]}
                >
                    <View dataSet={themeSurfaceDataSet(inputSurface.surface, inputSurface.part, inputSurface.state)}
                        style={[styles.field, surfaceOverridesEnabled ? themeSurfaceStyles.surface(inputSurface) : null]}>
                        <View style={styles.prompt}>
                            <AgentInputDocumentPreviewText value="" placeholder={props.placeholder} references={[]} fieldInset={false} singleLine />
                        </View>
                        {props.trailing}
                    </View>
                    <View style={styles.rails} />
                </GlassSurface>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    band: resolveAgentInputBandStyle(theme),
    fullWidth: { width: '100%' },
    shadow: resolveAgentInputPanelShadowStyle(theme, false),
    shadowGlass: resolveAgentInputPanelShadowStyle(theme, true),
    panel: resolveAgentInputPanelLayoutStyle(theme),
    phonePanel: resolveAgentInputPhonePanelLayoutStyle(theme),
    innerShadow: resolveAgentInputPanelInnerShadowStyle(theme),
    field: AGENT_INPUT_FIELD_CONTAINER_STYLE,
    prompt: {
        flex: 1,
        minWidth: 0,
        paddingVertical: Platform.OS === 'web' ? AGENT_INPUT_FIELD_PADDING_Y : AGENT_INPUT_NATIVE_FIELD_PADDING_Y,
    },
    rails: { height: AGENT_INPUT_FIELD_TO_CHIP_RAIL_GAP_PX + NEW_SESSION_RESTING_RAILS_HEIGHT_PX },
}));
