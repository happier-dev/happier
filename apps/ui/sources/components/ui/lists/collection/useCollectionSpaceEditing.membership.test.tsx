import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { createDefaultCollectionSpaceV1, type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { renderScreen } from '@/dev/testkit';

// Credential-bound Action execution is the boundary; form state and mutation construction stay real.
const execute = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true as const, result: { status: 'completed' } }));
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
    useMountedActionExecution: () => ({ execute, approval: {}, isCurrent: () => true }),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

import { useCollectionSpaceEditing } from './useCollectionSpaceEditing';

const base = createDefaultCollectionSpaceV1('sessionWork');
const anchorRef = { current: null };
let editing: ReturnType<typeof useCollectionSpaceEditing<'sessionWork'>>;
function Host({ selectedSpace = null }: Readonly<{ selectedSpace?: CollectionSpaceV1<'sessionWork'> | null }>) {
    editing = useCollectionSpaceEditing({
        entityKind: 'sessionWork', testIDPrefix: 'space', scope: { serverId: 'server', accountId: 'account' },
        spaces: [base], selectedSpace, currentFilter: base.filter,
        suggestion: { name: 'Work', icon: base.icon }, summary: [], anchorRef,
    });
    return editing.formOverlay;
}
async function renderForm(selectedSpace?: CollectionSpaceV1<'sessionWork'>) {
    const screen = await renderScreen(
        <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <Host selectedSpace={selectedSpace} />
        </HappierUiPlatformProvider>,
    );
    await act(() => selectedSpace ? editing.openEdit() : editing.openSaveAs());
    return screen;
}

describe('Session space membership form', () => {
    beforeEach(() => execute.mockClear());

    it('creates a manual-only space through the existing settings intent', async () => {
        const screen = await renderForm();
        await screen.pressByTestIdAsync('space-membership:manual_only');
        await screen.pressByTestIdAsync('space-submit');
        expect(execute).toHaveBeenCalledWith('settings.invoke', expect.objectContaining({
            input: expect.objectContaining({ mutation: expect.objectContaining({
                op: 'create', space: expect.objectContaining({ membership: { mode: 'manual_only', tags: [] } }),
            }) }),
        }));
    });

    it('edits only the mode so the catalog retains its current qualified membership tags', async () => {
        const tags = [{ serverId: 'other-home', accountId: 'account', tagId: 'private-tag' }];
        const screen = await renderForm({ ...base, id: 'release', membership: { mode: 'manual_only', tags } });
        await screen.pressByTestIdAsync('space-membership:filter_or_manual');
        await screen.pressByTestIdAsync('space-submit');
        expect(execute.mock.calls.at(-1)?.[1]).toHaveProperty('input.mutation.changes.membership', { mode: 'filter_or_manual' });
    });

    it('starts a new space with its own membership instead of inheriting another space assignments', async () => {
        const screen = await renderForm({ ...base, id: 'release', membership: {
            mode: 'manual_only', tags: [{ serverId: 'home', accountId: 'account', tagId: 'existing' }],
        } });
        await act(() => editing.openSaveAs());
        await screen.pressByTestIdAsync('space-submit');
        expect(execute).toHaveBeenCalledWith('settings.invoke', expect.objectContaining({
            input: expect.objectContaining({ mutation: expect.objectContaining({
                op: 'create', space: expect.objectContaining({ membership: { mode: 'filter_or_manual', tags: [] } }),
            }) }),
        }));
    });
});
