import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import type { PluginConfigurationSettingFieldV2 } from '@happier-dev/protocol/plugins/contributions/settings';

import { ConnectedServicesSpecimen } from '@/components/dev/connectedServices/ConnectedServicesSpecimen';
import { ConnectedAccountConfigurationForm } from '@/components/settings/connectedServices/account/ConnectedAccountConfigurationForm';
import { useDeviceType } from '@/utils/platform/responsive';

const configurationFields: readonly PluginConfigurationSettingFieldV2[] = [
    { id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } },
    { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } },
    { id: 'tier', title: 'Tier', schema: { type: 'number', enum: [1, 2] } },
    { id: 'scopes', title: 'Scopes', schema: { type: 'array', items: { type: 'number', enum: [1, 2] } } },
];

/** Dev-only: the Connected services surfaces with fixture accounts (lab `csvc`). `?frame=<id>`. */
export default function ConnectedServicesDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    const frame = typeof params.frame === 'string' ? params.frame : null;
    const phone = useDeviceType() === 'phone';
    const entityFrame = frame !== null && ['D1p', 'D2p', 'PLp', 'PLap'].includes(frame);
    return <>
        {/* Entity actions reach screen and parent in the real hidden-child settings stack.
            This detached fixture keeps only its parent header visible on phones, too. */}
        <Stack.Screen options={{ headerShown: !(phone && entityFrame) }} />
        {frame === 'configuration' ? <ConnectedAccountConfigurationForm
            title="Configuration"
            fields={configurationFields}
            values={{ enabled: false, endpoint: 'https://example.test', tier: 1, scopes: [1] }}
            configuredSecretFieldIds={[]}
            saving={false}
            onSubmit={() => {}}
        /> : <ConnectedServicesSpecimen frame={frame} />}
    </>;
}
