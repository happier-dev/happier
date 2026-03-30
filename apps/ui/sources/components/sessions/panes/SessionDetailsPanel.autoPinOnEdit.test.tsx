import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    },
    icons: () => ({
        Octicons: 'Octicons',
        Ionicons: 'Ionicons',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary mock: SessionDetailsPanel only reads editor focus mode in this suite.
                useLocalSetting: ((key: string) => {
                    if (key === 'editorFocusModeEnabled') return false;
                    return null;
                }) as any,
                // Boundary mock: the suite only needs a stable boolean mutable local setting tuple.
                useLocalSettingMutable: (() => [false, vi.fn()]) as any,
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

const SessionFileDetailsViewMock = vi.fn((props: any) => React.createElement('SessionFileDetailsView', props));
vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: (props: any) => SessionFileDetailsViewMock(props),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

const pinDetailsTab = vi.fn();
const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: 'file:a',
        tabs: [
            { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: false, isPreview: true, resource: { kind: 'file', path: 'a.txt' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab,
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState,
    }),
}));

afterEach(() => {
    standardCleanup();
    pinDetailsTab.mockClear();
    SessionFileDetailsViewMock.mockClear();
});

describe('SessionDetailsPanel (auto pin on edit)', () => {
    it('pins a preview file tab when editing begins', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(SessionFileDetailsViewMock).toHaveBeenCalledTimes(1);
        const props = SessionFileDetailsViewMock.mock.calls[0]?.[0];
        expect(typeof props?.onStartEditingFile).toBe('function');

        await act(async () => {
            props.onStartEditingFile();
        });

        expect(pinDetailsTab).toHaveBeenCalledWith('file:a');
    });
});
