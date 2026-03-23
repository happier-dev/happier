import { describe, expect, it, vi } from 'vitest';

import { ActionInputFields } from './ActionInputFields';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                surfaceHigh: '#222',
                surfaceHighest: '#444',
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ActionInputFields', () => {
    it('does not clear the last selected value for required multiselect fields', async () => {
        const onPatch = vi.fn();

        const screen = await renderScreen(<ActionInputFields
            fields={[
                {
                    path: 'engineIds',
                    title: 'Review engines',
                    widget: 'multiselect',
                    required: true,
                } as any,
            ]}
            input={{ engineIds: ['claude'] }}
            editable
            resolveFieldOptions={() => [
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
            ]}
            onPatch={onPatch}
        />);

        const claudeChip = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Claude');
        expect(claudeChip).toBeDefined();

        await pressTestInstanceAsync(claudeChip);

        expect(onPatch).not.toHaveBeenCalled();
    });
});
