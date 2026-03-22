import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    ScrollView: 'ScrollView',
                    TextInput: 'TextInput',
                    ActivityIndicator: 'ActivityIndicator',
                    Platform: {
                        OS: 'ios',
                        select: (spec: Record<string, unknown>) =>
                      spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
                    },
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
  RepositoryTreeList: 'RepositoryTreeList',
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
  SessionRepositoryTreeBrowserView: (props: any) => React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
    useSessionRepositoryTreeExpandedPaths: () => [],
});
});

describe('ProjectFileLinkPickerModal', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('wires file opens to onPickPath + onClose', async () => {
    const { ProjectFileLinkPickerModal } = await import('./ProjectFileLinkPickerModal');
    const onPickPath = vi.fn();
    const onClose = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ProjectFileLinkPickerModal sessionId="s1" onPickPath={onPickPath} onClose={onClose} />)).tree;

    const browser = tree.root.findByType('SessionRepositoryTreeBrowserView' as any);
    await act(async () => {
      browser.props.onOpenFile('src/api.ts');
    });

    expect(onPickPath).toHaveBeenCalledWith('src/api.ts');
    expect(onClose).toHaveBeenCalled();
  });
});
