import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    readOpenWorkflowDefinition,
    splitLibraryDefinitions,
} from './workflowsColumnModel';

describe('readOpenWorkflowDefinition', () => {
    it('keeps Events navigation from selecting a saved definition', () => {
        expect(readOpenWorkflowDefinition('/workflows/events')).toBeNull();
        expect(readOpenWorkflowDefinition('/workflows/events/occurrence')).toBeNull();
        expect(readOpenWorkflowDefinition('/workflows/definition%20one')).toBe('definition one');
    });
});

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
