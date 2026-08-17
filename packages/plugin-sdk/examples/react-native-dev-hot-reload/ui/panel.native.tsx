import * as React from 'react';

import { Action, Card, defineUiSurface, Text } from '@happier-dev/plugin-ui';

function DevelopmentPanel() {
    return (
        <Card>
            <Text value="React Native development example" variant="title" />
            <Text value="Edit this source; the normal development command rebuilds the artifact before it submits a candidate." />
            <Action.Copy value="Development artifact rebuilt" title="Copy rebuild status" />
        </Card>
    );
}

export const renderSurface = defineUiSurface(DevelopmentPanel);
