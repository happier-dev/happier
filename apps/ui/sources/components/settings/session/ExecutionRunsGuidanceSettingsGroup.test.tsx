import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'ios', select: (options: any) => options?.ios ?? options?.default },
    TextInput: 'TextInput',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { placeholder: '#666' },
                divider: '#333',
            },
        },
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { input: { placeholder: '#666' }, divider: '#333' } }) },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: 'ItemGroup',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

describe('ExecutionRunsGuidanceSettingsGroup', () => {
    it('hides the editor when disabled', async () => {
        const { ExecutionRunsGuidanceSettingsGroup } = await import('./ExecutionRunsGuidanceSettingsGroup');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ExecutionRunsGuidanceSettingsGroup
                    enabled={false}
                    setEnabled={vi.fn()}
                    maxChars={4_000}
                    setMaxChars={vi.fn()}
                    entries={[]}
                    setEntries={vi.fn()}
                />,
            );
        });

        expect(tree!.root.findAllByType('TextInput').length).toBe(0);
    });

    it('calls setEnabled when the toggle item is pressed', async () => {
        const setEnabled = vi.fn();
        const { ExecutionRunsGuidanceSettingsGroup } = await import('./ExecutionRunsGuidanceSettingsGroup');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ExecutionRunsGuidanceSettingsGroup
                    enabled={false}
                    setEnabled={setEnabled}
                    maxChars={4_000}
                    setMaxChars={vi.fn()}
                    entries={[]}
                    setEntries={vi.fn()}
                />,
            );
        });

        const itemNodes = tree!.root.findAllByType('Item');
        const toggle = itemNodes.find((n: any) => n.props.title === 'Enable guidance injection');
        expect(toggle).toBeDefined();

        await act(async () => {
            toggle!.props.onPress?.();
        });

        expect(setEnabled).toHaveBeenCalledWith(true);
    });

    it('allows adding a rule and editing its description', async () => {
        const setEntries = vi.fn();
        const { ExecutionRunsGuidanceSettingsGroup } = await import('./ExecutionRunsGuidanceSettingsGroup');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ExecutionRunsGuidanceSettingsGroup
                    enabled={true}
                    setEnabled={vi.fn()}
                    maxChars={4_000}
                    setMaxChars={vi.fn()}
                    entries={[]}
                    setEntries={setEntries}
                />,
            );
        });

        const itemNodes = tree!.root.findAllByType('Item');
        const addRule = itemNodes.find((n: any) => n.props.title === 'Add rule');
        expect(addRule).toBeDefined();

        await act(async () => {
            addRule!.props.onPress?.();
        });

        expect(setEntries).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ id: 'guidance_uuid', enabled: true })]),
        );

        const nextEntries = setEntries.mock.calls[0]?.[0] as any[];
        expect(Array.isArray(nextEntries)).toBe(true);
        expect(nextEntries[0]).toBeTruthy();

        // Re-render with the new entries, since this component is controlled by its parent.
        await act(async () => {
            tree!.update(
                <ExecutionRunsGuidanceSettingsGroup
                    enabled={true}
                    setEnabled={vi.fn()}
                    maxChars={4_000}
                    setMaxChars={vi.fn()}
                    entries={nextEntries}
                    setEntries={setEntries}
                />,
            );
        });

        // Simulate user typing a description for the first rule.
        setEntries.mockReset();
        await act(async () => {
            const textInputs = tree!.root.findAllByType('TextInput');
            const descriptionInput = textInputs.find((n: any) => n.props.placeholder === 'Describe when to delegate');
            descriptionInput?.props.onChangeText?.('Prefer Claude for UI work');
        });

        expect(setEntries).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ id: 'guidance_uuid', description: 'Prefer Claude for UI work' })]),
        );
    });

    it('allows editing example tool calls when advanced options are expanded', async () => {
        const setEntries = vi.fn();
        const { ExecutionRunsGuidanceSettingsGroup } = await import('./ExecutionRunsGuidanceSettingsGroup');

        const entries = [{ id: 'guidance_uuid', description: 'Prefer Claude for UI work', enabled: true }];

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ExecutionRunsGuidanceSettingsGroup
                    enabled={true}
                    setEnabled={vi.fn()}
                    maxChars={4_000}
                    setMaxChars={vi.fn()}
                    entries={entries as any}
                    setEntries={setEntries}
                />,
            );
        });

        const itemNodes = tree!.root.findAllByType('Item');
        const advanced = itemNodes.find((n: any) => n.props.title === 'Advanced options');
        expect(advanced).toBeDefined();

        await act(async () => {
            advanced!.props.onPress?.();
        });

        setEntries.mockReset();
        await act(async () => {
            const textInputs = tree!.root.findAllByType('TextInput');
            const examplesInput = textInputs.find((n: any) => n.props.placeholder === 'Example tool calls (one per line)');
            examplesInput?.props.onChangeText?.('mcp.execution.run\n  mcp.execution.list  \n');
        });

        expect(setEntries).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ id: 'guidance_uuid', exampleToolCalls: ['mcp.execution.run', 'mcp.execution.list'] }),
            ]),
        );
    });
});
