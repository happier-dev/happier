import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(standardCleanup);

describe('PluginReadOnlySnapshotNotice', () => {
    it('keeps retained content quiet during routine refresh', async () => {
        const { PluginReadOnlySnapshotNotice } = await import('./PluginReadOnlySnapshotNotice');
        const screen = await renderSettingsView(<PluginReadOnlySnapshotNotice testID="notice" reason="refreshing" />);
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'notice')).toHaveLength(0);
    });
    it('keeps a failed read actionable', async () => {
        const { PluginReadOnlySnapshotNotice } = await import('./PluginReadOnlySnapshotNotice');
        const retry = vi.fn();
        const screen = await renderSettingsView(<PluginReadOnlySnapshotNotice testID="notice" reason="projectionUnavailable" onRetry={retry} />);
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'notice').length).toBeGreaterThan(0);
        screen.pressByTestId('notice-retry');
        expect(retry).toHaveBeenCalled();
    });
});
