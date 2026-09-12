import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider } from '../../appShell/panes/AppPaneProvider';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
        });
    },
});

vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: (props: any) => React.createElement('SessionBrowseFilesSurface', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: (props: any) => React.createElement('SessionGitSurface', props),
}));

describe('SessionRightPanel (keep mounted tabs)', () => {
    it('keeps Git and Files tab surfaces mounted so switching tabs preserves state', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </AppPaneProvider>,
        );

        const getStyleValue = (node: ReactTestInstance, key: string) => {
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && key in entry) {
                    return (entry as Record<string, unknown>)[key];
                }
            }
            return undefined;
        };

        expect(screen.findAllByType('SessionGitSurface')).toHaveLength(1);
        // Lazy-mount inactive tabs for faster initial open.
        expect(screen.findAllByType('SessionBrowseFilesSurface')).toHaveLength(0);

        await screen.pressByTestIdAsync('session-rightpanel-tab:files');

        expect(screen.findAllByType('SessionGitSurface')).toHaveLength(1);
        expect(screen.findAllByType('SessionBrowseFilesSurface')).toHaveLength(1);
        expect(screen.findByType('SessionBrowseFilesSurface')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(0);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(1);

        // Switching back keeps both mounted.
        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        expect(screen.findAllByType('SessionGitSurface')).toHaveLength(1);
        expect(screen.findAllByType('SessionBrowseFilesSurface')).toHaveLength(1);
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(1);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(0);
    });
});
