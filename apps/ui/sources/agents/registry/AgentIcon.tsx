import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from './registryCore';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { ViewStyle } from 'react-native';

import {
    getAgentIconSource,
    getAgentIconSvgXml,
    getAgentIconTintColor,
    getAgentCore,
} from '@/agents/catalog/catalog';

type AgentIconProps = Readonly<{
    agentId: AgentId;
    size: number;
    color?: string;
    style?: StyleProp<ImageStyle>;
    testID?: string;
}>;

const SVG_COLOR_ATTRIBUTE_PATTERN = /\s(fill|stroke)="(?!none\b)[^"]*"/g;

function escapeSvgAttributeValue(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

function applySvgIconColor(svgXml: string, color: string): string {
    const escapedColor = escapeSvgAttributeValue(color);
    return svgXml.replace(
        SVG_COLOR_ATTRIBUTE_PATTERN,
        (_match, attribute: string) => ` ${attribute}="${escapedColor}"`,
    );
}

export const AgentIcon = React.memo(function AgentIcon(props: AgentIconProps) {
    const { agentId, size, color, style, testID } = props;
    const { theme } = useUnistyles();

    const svgXml = getAgentIconSvgXml(agentId, theme);
    if (svgXml) {
        return (
            // The mark is boxed rather than dropped in bare.
            //
            // `SvgXml` renders a raw DOM `<svg>` on web — the one leaf in this app that is
            // not a React-Native-Web view, and so the only one that is statically
            // positioned. CSS paints static content BENEATH positioned siblings, and
            // React-Native-Web positions every view it renders, so an Agent mark placed on
            // a filled control whose background is an absolutely positioned layer
            // (`GradientSurface`, inside `PrimaryCircleIconButton` and `RoundButton`) was
            // painted over by that background: the composer's armed
            // "Continue with {Agent}" send control drew as an empty filled circle with the
            // mark hidden underneath it.
            //
            // Every other icon in the app already renders inside a view — `Icon` does, and
            // so does the image branch below — so the box makes the Agent mark behave like
            // the rest, rather than special-casing each control that hosts one.
            <View style={{ width: size, height: size }}>
                <SvgXml
                    xml={color ? applySvgIconColor(svgXml, color) : svgXml}
                    width={size}
                    height={size}
                    style={style as ImageStyle}
                    testID={testID}
                />
            </View>
        );
    }

    const source = getAgentIconSource(agentId);
    if (!source) {
        // Core stores this as a Node-safe string; this UI boundary owns the Ionicons contract.
        const fallbackIconName = getAgentCore(agentId).ui.agentPickerIconName as IconName;
        return (
            <Icon
                name={fallbackIconName}
                size={size}
                color={color ?? getAgentIconTintColor(agentId, theme) ?? theme.colors.text.secondary}
                style={style as StyleProp<ViewStyle>}
                testID={testID}
            />
        );
    }

    return (
        <Image
            source={source}
            style={[{ width: size, height: size }, style]}
            tintColor={color ?? getAgentIconTintColor(agentId, theme)}
            contentFit="contain"
            testID={testID}
        />
    );
});
