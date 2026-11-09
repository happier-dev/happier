import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(standardCleanup);
const { PluginReadOnlySnapshotNotice } = await import('./PluginReadOnlySnapshotNotice');

describe('PluginReadOnlySnapshotNotice', () => {
    it('asks for a Machine without claiming an outage or offering a failed-read retry', async () => {
        const screen = await renderSettingsView(<PluginReadOnlySnapshotNotice testID="notice" reason="noTarget" onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.chooseMachine');
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.chooseMachineInstalled');
        expect(screen.findByTestId('notice-retry')).toBeNull();
    });

    it('keeps retained content quiet during routine refresh', async () => {
        const screen = await renderSettingsView(<PluginReadOnlySnapshotNotice testID="notice" reason="refreshing" />);
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'notice')).toHaveLength(0);
    });
    it('keeps a failed read actionable', async () => {
        const retry = vi.fn();
        const screen = await renderSettingsView(<PluginReadOnlySnapshotNotice testID="notice" reason="projectionUnavailable" onRetry={retry} />);
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'notice').length).toBeGreaterThan(0);
        screen.pressByTestId('notice-retry');
        expect(retry).toHaveBeenCalled();
    });
});
