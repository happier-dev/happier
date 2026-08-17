import * as React from 'react';

import { Action, Card, defineUiSurface, Text } from '@happier-dev/plugin-ui';

function InstalledPanel() {
    return (
        <Card>
            <Text value="Installed React Native example" variant="title" />
            <Text value="This artifact uses the host-provided semantic surface context." tone="secondary" />
            <Action.Copy value="Installed React Native example" title="Copy example title" />
        </Card>
    );
}

export const renderSurface = defineUiSurface(InstalledPanel);
