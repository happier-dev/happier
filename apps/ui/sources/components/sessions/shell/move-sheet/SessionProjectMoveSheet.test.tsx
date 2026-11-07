import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { SessionProjectMoveSheet } from './SessionProjectMoveSheet';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SessionProjectMoveSheet', () => {
    it('selects a destination, ignores the current project, and offers restoration separately from cancellation', async () => {
        const onSelect = vi.fn();
        const onCancel = vi.fn();
        const screen = await renderScreen(<SessionProjectMoveSheet canRestore targets={[
            { id: 'current', title: 'Current', subtitle: '/current', machineId: 'm', rootPath: '/current', disabled: true },
            { id: 'destination', title: 'MAXICAM', subtitle: '/target', machineId: 'm', rootPath: '/target', disabled: false },
        ]} onSelect={onSelect} onCancel={onCancel} />);
        invokeTestInstanceHandler(screen.findByTestId('session-project-move-sheet:projects:option:current'), 'onPress');
        expect(onSelect).not.toHaveBeenCalled();
        invokeTestInstanceHandler(screen.findByTestId('session-project-move-sheet:projects:option:destination'), 'onPress');
        expect(onSelect).toHaveBeenLastCalledWith({ machineId: 'm', rootPath: '/target' });
        invokeTestInstanceHandler(screen.findByTestId('session-project-move-sheet:projects:option:automatic'), 'onPress');
        expect(onSelect).toHaveBeenLastCalledWith(null);
        expect(onCancel).not.toHaveBeenCalled();
    });
});
