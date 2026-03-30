import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSourceControlStatusCommonModuleMocks } from './sourceControlStatusTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

installSourceControlStatusCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSessionProjectScmSnapshot: () => snapshotMock,
        });
    },
});

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
        const screen = await renderScreen(<CompactSourceControlStatus sessionId="session-1" />);
        const labels = screen.getTextContent();
        expect(labels).toContain('3');
    });
});
