import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';
import * as ReactNativeSvg from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import {
    getAgentIconSource,
    getAgentIconSvgXml,
    getAgentIconTintColor,
} from '@/agents/catalog/catalog';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';

type AgentIconProps = Readonly<{
    agentId: string;
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
    const { theme, rt } = useUnistyles();
    // Raw SVG XML is resolved in JS, so subscribe it to adaptive appearance changes explicitly.
    void rt.colorScheme;

    const svgXml = getAgentIconSvgXml(agentId, theme);
    if (svgXml) {
        const resolvedSvgXml = color ? applySvgIconColor(svgXml, color) : svgXml;
        const SvgXml = (ReactNativeSvg as unknown as { SvgXml?: React.ComponentType<any> }).SvgXml;
        if (!SvgXml) {
            const uri = `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvgXml)}`;
            return (
                <SafeExpoImage
                    source={{ uri }}
                    style={[{ width: size, height: size }, style]}
                    contentFit="contain"
                    testID={testID}
                />
            );
        }
        return (
            <SvgXml
                xml={resolvedSvgXml}
                width={size}
                height={size}
                style={style as ImageStyle}
                testID={testID}
            />
        );
    }

    const source = getAgentIconSource(agentId);
    if (!source) {
        return null;
    }

    return (
        <SafeExpoImage
            source={source}
            style={[{ width: size, height: size }, style]}
            tintColor={color ?? getAgentIconTintColor(agentId, theme)}
            contentFit="contain"
            testID={testID}
        />
    );
});
