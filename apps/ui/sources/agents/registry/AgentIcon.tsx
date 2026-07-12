import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from './registryCore';

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
            <SvgXml
                xml={color ? applySvgIconColor(svgXml, color) : svgXml}
                width={size}
                height={size}
                style={style as ImageStyle}
                testID={testID}
            />
        );
    }

    const source = getAgentIconSource(agentId);
    if (!source) {
        // Core stores this as a Node-safe string; this UI boundary owns the Ionicons contract.
        const fallbackIconName = getAgentCore(agentId).ui.agentPickerIconName as React.ComponentProps<typeof Ionicons>['name'];
        return (
            <Ionicons
                name={fallbackIconName}
                size={size}
                color={color ?? getAgentIconTintColor(agentId, theme) ?? theme.colors.text.secondary}
                style={style as React.ComponentProps<typeof Ionicons>['style']}
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
