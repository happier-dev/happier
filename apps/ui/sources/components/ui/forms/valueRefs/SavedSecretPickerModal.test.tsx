import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { installValueRefsCommonModuleMocks } from '@/components/ui/forms/valueRefs/valueRefsTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storedSecrets: SavedSecret[] = [{
    id: 'secret-1',
    name: 'qa_saved_secret',
    kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, value: 'sk-stored' },
    createdAt: 1,
    updatedAt: 1,
}];

installValueRefsCommonModuleMocks();

vi.mock('@/sync/store/hooks', () => ({
    useSetting: () => storedSecrets,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettings: vi.fn() }),
}));

vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/ItemRowActions', () => createPassThroughModule(['ItemRowActions']));
vi.mock('@/components/ui/forms/InlineAddExpander', () => createPassThroughModule(['InlineAddExpander']));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

// `Item` renders its right-hand affordances through a prop rather than children, so the row slot has
// to be mounted for the mutation controls to be observable at all.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { rightElement?: React.ReactNode }) => React.createElement(
        'Item',
        props,
        props.rightElement,
    ),
}));

type PickerScreen = Awaited<ReturnType<typeof renderScreen>>;

function rowActionIds(screen: PickerScreen): string[] {
    return screen.findAllByType('ItemRowActions' as never)
        .flatMap((node) => ((node.props.actions ?? []) as ReadonlyArray<{ id: string }>).map((action) => action.id));
}

/**
 * The picker is shared between callers that own the secret list (MCP value refs, provider
 * connections) and callers whose own flow carries the disclosure for writing a credential. Only the
 * first group may mutate a stored record from inside the picker.
 */
describe('SavedSecretPickerModal', () => {
    it('keeps rename, replace, delete and add for consumers that own the secret list', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');

        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose: vi.fn(),
            selectedId: null,
            onSelectId: vi.fn(),
        }));

        expect(rowActionIds(screen)).toEqual(['edit', 'replace', 'delete']);
        expect(screen.findAllByType('InlineAddExpander' as never)).toHaveLength(1);
        expect(screen.findByTestId('saved-secret:none')).toBeTruthy();
    });

    it('is a pure selector when the caller owns the credential write: select an existing id or dismiss', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');
        const onSelectId = vi.fn();
        const onClose = vi.fn();

        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
            onClose,
            selectedId: null,
            onSelectId,
            includeNoneRow: false,
            allowAdd: false,
            allowEdit: false,
        }));

        // Nothing in the tree can create, replace, rename or delete a stored record.
        expect(rowActionIds(screen)).toEqual([]);
        expect(screen.findAllByType('InlineAddExpander' as never)).toHaveLength(0);
        expect(screen.findByTestId('saved-secret:none')).toBeNull();

        // Selecting an already-stored record stays the whole point of the surface.
        screen.pressByTestId('saved-secret:secret-1');
        expect(onSelectId).toHaveBeenCalledWith('secret-1');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
