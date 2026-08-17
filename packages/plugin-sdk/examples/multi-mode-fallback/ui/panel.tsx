import * as React from 'react';

import { Action, Card, defineUiSurface, Text } from '@happier-dev/plugin-ui';

function FallbackPanel() {
    return (
        <Card>
            <Text value="Multi-mode fallback example" variant="title" />
            <Text value="The host chooses this semantic React Native artifact before falling back." />
            <Action.Copy value="reactNative" title="Copy selected renderer" />
        </Card>
    );
}

export const renderSurface = defineUiSurface(FallbackPanel);
