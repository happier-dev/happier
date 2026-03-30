import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from './registryCore';

import {
    getAgentIconSource,
    getAgentIconSvgXml,
    getAgentIconTintColor,
} from '@/agents/catalog/catalog';

type AgentIconProps = Readonly<{
    agentId: AgentId;
    size: number;
    style?: StyleProp<ImageStyle>;
    testID?: string;
}>;

export function AgentIcon(props: AgentIconProps) {
    const { agentId, size, style, testID } = props;
    const { theme } = useUnistyles();

    const svgXml = getAgentIconSvgXml(agentId, theme);
    if (svgXml) {
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
        <Image
            source={source}
            style={[{ width: size, height: size }, style]}
            tintColor={getAgentIconTintColor(agentId, theme)}
            contentFit="contain"
            testID={testID}
        />
    );
}
