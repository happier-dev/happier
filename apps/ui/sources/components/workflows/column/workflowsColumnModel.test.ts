import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol';

import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    selectHistoryPreviewRuns,
    splitLibraryDefinitions,
} from './workflowsColumnModel';

describe('splitLibraryDefinitions', () => {
    it('keeps plugin catalog identities in From plugins instead of treating them as saved workflows', () => {
        const plugin = {
            workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
            title: 'Check changes',
            definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
        };
        const split = splitLibraryDefinitions([], [plugin]);
        expect(split.library).toEqual([]);
        expect(split.sharedWithYou).toEqual([]);
        expect(split.fromPlugins).toEqual([plugin]);
        expect(split.fromPlugins[0]).toBe(plugin);
    });

    it('puts workflows others shared with you in their own section, never in Library', () => {
        const header = (definitionId: string, access?: 'owner' | 'view' | 'edit' | 'admin') => ({
            kind: 'workflow-definition.v1' as const,
            definitionId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: definitionId },
            contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            ...(access === undefined ? {} : { access }),
        });
        const split = splitLibraryDefinitions([header('mine'), header('owned', 'owner'), header('theirs', 'edit')] as never);
        expect(split.library.map((entry) => entry.definitionId)).toEqual(['mine', 'owned']);
        expect(split.sharedWithYou.map((entry) => entry.definitionId)).toEqual(['theirs']);
    });
});

describe('selectHistoryPreviewRuns', () => {
    it('shows settled runs only, so a running run is never listed twice', () => {
        const run = (id: string, state: WorkflowRunSummaryV1['state']) => ({ id, state }) as WorkflowRunSummaryV1;
        const preview = selectHistoryPreviewRuns([run('a', 'running'), run('b', 'succeeded'), run('c', 'cancelled'), run('d', 'paused')]);
        expect(preview.map((entry) => entry.id)).toEqual(['b', 'c']);
    });
});
