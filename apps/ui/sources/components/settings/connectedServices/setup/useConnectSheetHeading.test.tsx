/// <reference types="vite/client" />
import * as React from 'react';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { mergeChromeConfig } from '@/modal/components/customModalChrome';
import type { CustomModalChromeConfig } from '@/modal/types';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { resolveConnectedAccountAuthenticationModeMachineRequirement } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { useConnectSheetHeading } from './useConnectSheetHeading';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

// Cover the selected modes from real bundled declarations, rather than copying placement expectations.
const manifests = import.meta.glob<{ PLUGIN_MANIFEST?: unknown }>('../../../../../../../packages/plugins/*/src/manifest.ts');
const modes = (await Promise.all(Object.values(manifests).map(async load => {
    const module = await load();
    const parsed = PluginPortableReleaseManifestV1Schema.safeParse(module.PLUGIN_MANIFEST);
    if (!parsed.success) return [];
    return (parsed.data.contributes.connectedAccountDescriptors ?? []).flatMap(descriptor =>
        descriptor.authentication.modes.map(mode => ({
            key: `${parsed.data.id}/${descriptor.id}/${mode.id}`,
            machineRequired: !descriptor.authentication.account
                || Boolean(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true, 'authentication')),
        })));
}))).flat();

function Heading(props: Readonly<{ machineRequired: boolean }>) {
    const [chrome, setChromeState] = React.useState<CustomModalChromeConfig | null>(null);
    const setChrome = React.useCallback((next: CustomModalChromeConfig | null) =>
        setChromeState(current => mergeChromeConfig(current, next)), []);
    const actions = React.useMemo(() => props.machineRequired ? <View testID="machine-target" /> : null, [props.machineRequired]);
    useConnectSheetHeading({ request: { intent: 'add' }, onClose: () => {}, onResult: () => {}, setChrome }, {
        title: 'Connect', subtitle: 'Choose a method', leading: null, leadingKey: 'service', actions,
    });
    return <View>{chrome?.kind === 'card' ? chrome.actions : null}</View>;
}

it.each(modes)('publishes the selected mode target and clears previous actions: $key', async ({ machineRequired }) => {
    const screen = await renderScreen(<Heading machineRequired={!machineRequired} />);
    try {
        expect(screen.findHostByTestId('machine-target') !== null).toBe(!machineRequired);
        await screen.update(<Heading machineRequired={machineRequired} />);
        expect(screen.findHostByTestId('machine-target') !== null).toBe(machineRequired);
    } finally { await screen.unmount(); }
});
