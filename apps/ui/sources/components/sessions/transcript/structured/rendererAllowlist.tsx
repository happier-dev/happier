import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';

export type PluginStructuredMessageRendererId =
    | 'actionList'
    | 'keyValue'
    | 'markdownSummary'
    | 'notice'
    | 'resourceLink'
    | 'status'
    | 'summaryCard';

function readHostRendererId(
    descriptor: PluginUiStructuredMessageProjection,
): PluginStructuredMessageRendererId | null {
    const renderer = descriptor.renderer;
    if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) {
        return null;
    }
    if ((renderer as { kind?: unknown }).kind !== 'host') {
        return null;
    }
    const rendererId = (renderer as { rendererId?: unknown }).rendererId;
    if (
        rendererId === 'actionList'
        || rendererId === 'keyValue'
        || rendererId === 'markdownSummary'
        || rendererId === 'notice'
        || rendererId === 'resourceLink'
        || rendererId === 'status'
        || rendererId === 'summaryCard'
    ) {
        return rendererId;
    }
    return null;
}

export function renderPluginStructuredMessage(params: Readonly<{
    descriptor: PluginUiStructuredMessageProjection;
    payload: unknown;
}>): React.ReactElement | null {
    const rendererId = readHostRendererId(params.descriptor);
    if (!rendererId) {
        return null;
    }

    return (
        <View
            testID={`plugin-structured-message-${rendererId}`}
            style={{ minWidth: 0 }}
        >
            <Text>{params.descriptor.kind}</Text>
        </View>
    );
}
