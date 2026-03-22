import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSessionProjectScmSnapshot: () => snapshotMock,
});
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            Text: 'Text',
                            Platform: {
                                OS: 'web',
                                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null,
                            },
                            AppState: {
                                addEventListener: () => ({ remove: () => {} }),
                            },
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('CompactSourceControlStatus', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

      it('renders compact file count when there are non-line changes', async () => {
          snapshotMock = {
              repo: { isRepo: true, rootPath: '/repo' },
              branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
              entries: [{}, {}, {}],
              totals: {
                  includedFiles: 0,
                  pendingFiles: 0,
                  untrackedFiles: 3,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const { CompactSourceControlStatus } = await import('./CompactSourceControlStatus');
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CompactSourceControlStatus sessionId="session-1" />)).tree;
        const labels = tree!.root.findAllByType('Text' as any).map((node) => String(node.props.children));
        expect(labels).toContain('3');
    });
});
