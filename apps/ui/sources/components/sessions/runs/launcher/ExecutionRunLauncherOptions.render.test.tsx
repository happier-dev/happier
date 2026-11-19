import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
const permissionModeOptions = [
    { value: 'read-only', label: 'Read-only' },
    { value: 'default', label: 'Default' },
];

// Imported once at collection, after the boundary mocks, so module loading is never a test's own time.
const { ExecutionRunLauncherOptions } = await import('./ExecutionRunLauncherOptions');

async function renderOptions() {
    return renderScreen(React.createElement(ExecutionRunLauncherOptions, {
        profileChoices: [],
        selectedProfileId: '',
        selectedPermissionMode: 'read-only',
        permissionModeOptions,
        fields: [],
        input: {},
        editable: true,
        resolveFieldOptions: () => [],
        onSelectProfile: vi.fn(),
        onPatch: vi.fn(),
    }));
}

describe('ExecutionRunLauncherOptions', () => {
    it('reports the selected permission mode through accessibility state', async () => {
        const screen = await renderOptions();

        expect(screen.findByTestId('execution-run-launcher-permission-mode:read-only')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('execution-run-launcher-permission-mode:default')?.props.accessibilityState)
            .toMatchObject({ checked: false });
        standardCleanup();
    });
});
