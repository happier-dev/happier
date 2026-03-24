import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installSourceControlStatusCommonModuleMocks } from './sourceControlStatusTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: any = null;

installSourceControlStatusCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSessionProjectScmSnapshot: () => snapshotMock,
        }),
    text: async () =>
        createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'files.sourceControlStatus.changedFilesLabel') {
                    return `${String(values?.count ?? '')} files`;
                }

                return key;
            },
        }),
});

describe('ProjectSourceControlStatus', () => {
    beforeEach(() => {
        snapshotMock = null;
    });

    it('renders changed file count when there are non-line changes', async () => {
        snapshotMock = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            entries: [{}, {}],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 2,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };
        const { ProjectSourceControlStatus } = await import('./ProjectSourceControlStatus');
        const screen = await renderScreen(<ProjectSourceControlStatus sessionId="session-1" />);
        const labels = screen.getTextContent();
        expect(labels).toContain('2 files');
    });
});
