import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { renderScreen } from '@/dev/testkit';
import { installSessionActionsCommonModuleMocks } from './sessionActionsTestHelpers';

installSessionActionsCommonModuleMocks({ storage: async importOriginal => await importOriginal() });
const { ActionInputFields } = await import('./ActionInputFields');

describe('Group label metadata at the real generic Action editor', () => {
    it.each(['teams.groups.create', 'teams.groups.update'] as const)('%s submits edited label text through Action admission', async actionId => {
        const spec = getActionSpec(actionId);
        const input = { v: 1, teamId: 'team-1', groupId: 'group-1', name: 'Group',
            ...(actionId === 'teams.groups.create' ? { requestKey: 'label-editor' } : {}) };
        const fields = resolveEffectiveInputFields(spec, input).filter(field => field.path === 'name' || field.path === 'description');
        const onPatch = vi.fn<(patch: Record<string, unknown>) => void>();
        const screen = await renderScreen(<ActionInputFields fields={fields} input={input} editable
            resolveFieldOptions={() => []} resolveFieldTestID={field => `group-label-${field.path}`} onPatch={onPatch} />);
        for (const field of ['name', 'description']) {
            const edited = `Updated ${field}`;
            act(() => screen.changeTextByTestId(`group-label-${field}`, edited));
            const patch = onPatch.mock.calls.at(-1)?.[0];
            expect(patch?.[field]).toBe(edited);
            expect(spec.inputSchema.safeParse({ ...input, ...patch }).success).toBe(true);
        }
    });
});
