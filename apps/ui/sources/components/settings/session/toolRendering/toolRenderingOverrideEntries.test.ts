import { describe, expect, it, vi } from 'vitest';
import { TOOL_RENDERING_OVERRIDE_ENTRIES } from './toolRenderingOverrideEntries';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

// The catalog imports native UI primitives; keep its labels and normalization real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('TOOL_RENDERING_OVERRIDE_ENTRIES', () => {
    it('distinguishes independently configurable tools with the same transcript title', () => {
        const edit = TOOL_RENDERING_OVERRIDE_ENTRIES.find((entry) => entry.toolName === 'Edit');
        const multiEdit = TOOL_RENDERING_OVERRIDE_ENTRIES.find((entry) => entry.toolName === 'MultiEdit');

        expect(edit).toBeDefined();
        expect(multiEdit).toBeDefined();
        expect(edit?.title).not.toBe(multiEdit?.title);
        expect(new Set(TOOL_RENDERING_OVERRIDE_ENTRIES.map((entry) => entry.title)).size)
            .toBe(TOOL_RENDERING_OVERRIDE_ENTRIES.length);
    });
    it('covers normalized canonical tool names without stale omissions or alias duplicates', () => {
        expect(TOOL_RENDERING_OVERRIDE_ENTRIES).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ toolName: 'Delete' }),
                expect.objectContaining({ toolName: 'WorkspaceIndexingPermission' }),
                expect.objectContaining({ toolName: 'SubAgent' }),
            ]),
        );

        expect(TOOL_RENDERING_OVERRIDE_ENTRIES.filter((entry) => entry.toolName === 'SubAgent')).toHaveLength(1);
    });
});
