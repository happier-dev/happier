import * as React from 'react';

import { ProviderSettingsHome } from '@/components/settings/providers/collection/ProviderSettingsHome';
import { buildDemoProviderContributions } from '@/demoMode/world/providers';

const noop = () => {};

/** Available connectors only: this frame does not simulate configured model access. */
export function ProvidersStageSurface(): React.ReactElement {
    const available = React.useMemo(buildDemoProviderContributions, []);
    return <ProviderSettingsHome available={available} targetChip={null} onAdd={noop} onConnect={noop}
        footer={null}>{null}</ProviderSettingsHome>;
}
