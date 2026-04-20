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
    style?: StyleProp<ImageStyle>;
    testID?: string;
}>;

export function AgentIcon(props: AgentIconProps) {
    const { agentId, size, style, testID } = props;
    const { theme } = useUnistyles();

    const svgXml = getAgentIconSvgXml(agentId, theme);
    if (svgXml) {
        const SvgXml = (ReactNativeSvg as unknown as { SvgXml?: React.ComponentType<any> }).SvgXml;
        if (!SvgXml) {
            const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svgXml)}`;
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
                xml={svgXml}
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
            tintColor={getAgentIconTintColor(agentId, theme)}
            contentFit="contain"
            testID={testID}
        />
    );
}
