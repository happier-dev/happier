import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import { BrowserSurfacePaneHeader } from './browserSurfacePaneHeader';

// Native styling and font/icon loading are environment boundaries; all header and store logic is real.
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const initialStorage = getStorage().getState();
afterEach(() => {
    standardCleanup();
    getStorage().setState(initialStorage, true);
});

function HeaderText(): React.ReactElement {
    const published = usePublishedPaneHeaderContent('browser');
    const text = published?.line?.segments.map((segment) => typeof segment === 'string' ? segment : segment.text).join('') ?? '';
    return <Text testID="browser-header-text" accessibilityHint={published?.immersive ? 'immersive' : 'large'}>{text}</Text>;
}

function Harness(props: Readonly<{ presentation: 'workspace' | 'viewer'; pageOpen?: boolean }>): React.ReactElement {
    return <PaneHeaderSlotProvider>
        <HeaderText />
        <PaneHeaderSlotScope slotKey="browser">
            <BrowserSurfacePaneHeader presentation={props.presentation} serverId={null} machineId="preview-machine" pageOpen={props.pageOpen} />
        </PaneHeaderSlotScope>
    </PaneHeaderSlotProvider>;
}

describe('Browser surface pane header', () => {
    it('publishes live machine names only for the workspace and retracts the header in viewer mode', async () => {
        const machine = createMachineFixture({
            id: 'preview-machine',
            metadata: { host: 'preview.local', displayName: 'Preview Computer', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/tmp/happier', homeDir: '/tmp' },
        });
        getStorage().setState({ machines: { [machine.id]: machine } });
        const screen = await renderScreen(<Harness presentation="workspace" />);
        const headerText = () => screen.findHostByTestId('browser-header-text')?.props.children;
        expect(headerText()).toContain('Preview Computer');

        await screen.update(<Harness presentation="viewer" />);
        expect(headerText()).toBe('');
        await act(async () => {
            getStorage().setState({ machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed Computer' } } } });
        });
        expect(headerText()).toBe('');

        await screen.update(<Harness presentation="workspace" />);
        expect(headerText()).toContain('Renamed Computer');
    });

    it('never asks a phone to draw the large header, and names only the Machine over an open page (lab Kp)', async () => {
        const machine = createMachineFixture({
            id: 'preview-machine',
            metadata: { host: 'preview.local', displayName: 'Preview Computer', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/tmp/happier', homeDir: '/tmp' },
        });
        getStorage().setState({ machines: { [machine.id]: machine } });
        const screen = await renderScreen(<Harness presentation="workspace" />);
        const header = () => screen.findHostByTestId('browser-header-text')?.props;
        expect(header()?.accessibilityHint).toBe('immersive');

        await screen.update(<Harness presentation="workspace" pageOpen />);
        expect(header()?.accessibilityHint).toBe('immersive');
        expect(header()?.children).toBe('Preview Computer');
    });
});
