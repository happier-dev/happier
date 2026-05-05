import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Pressable, Text, View } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit');
    return await createReactNativeWebMock({
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
        TextInput: (props: any) => React.createElement('TextInput', props),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit');
    return await createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#4f8cff' },
                divider: '#333',
                surface: '#111',
                surfacePressed: '#444',
                text: '#eee',
                textSecondary: '#aaa',
                textDestructive: '#f00',
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: 'TextInput',
}));

describe('useCodeLinesReviewComments', () => {
    it('toggles an inline composer after pressing add-comment for a line', async () => {
        const { useCodeLinesReviewComments } = await import('./useCodeLinesReviewComments');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
                kind: 'file',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const a = 1;',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ] as any;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source: 'file',
                lines,
                drafts: [],
            });

            return (
                <React.Fragment>
                    <Pressable testID="add-comment-trigger" onPress={() => controls!.onPressAddComment(lines[0])} />
                    <Text>{controls!.isCommentActive(lines[0]) ? 'active' : 'inactive'}</Text>
                    {controls!.renderAfterLine(lines[0])}
                </React.Fragment>
            );
        }

        const screen = await renderScreen(<Harness />);

        expect(screen.findByTestId('add-comment-trigger')).toBeTruthy();
        expect(screen.findAllByType('TextInput' as any)).toHaveLength(0);
        const statusBefore = screen.findAllByType('Text' as any).map((n) => n.props.children).join(' ');
        expect(statusBefore).toContain('inactive');

        await act(async () => {
            await screen.pressByTestIdAsync('add-comment-trigger');
        });

        const statusAfter = screen.findAllByType('Text' as any).map((n) => n.props.children).join(' ');
        expect(statusAfter).toContain('active');
        const inputs = screen.findAllByType('TextInput' as any);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.props.placeholder).toBe('Add a review comment…');
        const inputStyle = flattenTestStyle(inputs[0]!.props.style);
        expect(inputStyle.outline).toBeUndefined();
        expect(inputStyle.outlineStyle).toBeUndefined();
        expect(inputStyle.boxShadow).toBeUndefined();
    });

    it('uses themed fallbacks for the inline composer instead of raw color literals', async () => {
        const { useCodeLinesReviewComments } = await import('./useCodeLinesReviewComments');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
                kind: 'file',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const a = 1;',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ] as any;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source: 'file',
                lines,
                drafts: [],
            });

            return (
                <React.Fragment>
                    <Pressable testID="add-comment-trigger" onPress={() => controls!.onPressAddComment(lines[0])} />
                    {controls!.renderAfterLine(lines[0])}
                </React.Fragment>
            );
        }

        const screen = await renderScreen(<Harness />);

        await act(async () => {
            await screen.pressByTestIdAsync('add-comment-trigger');
        });

        const input = screen.findAllByType('TextInput' as any)[0];
        if (!input?.parent) {
            throw new Error('Expected inline composer container');
        }
        const composerContainerStyle = flattenTestStyle(input.parent.props.style);
        const cancelText = screen.findAllByType('Text' as any).find((node) => node.props.children === 'Cancel');
        const saveText = screen.findAllByType('Text' as any).find((node) => node.props.children === 'Save');
        const cancelButton = cancelText?.parent?.parent ?? null;
        const saveButton = saveText?.parent?.parent ?? null;
        if (!cancelButton || !saveButton) {
            throw new Error('Expected inline composer action buttons');
        }

        expect(composerContainerStyle.borderColor).not.toBe('#ddd');
        expect(composerContainerStyle.backgroundColor).not.toBe('#fff');
        expect(flattenTestStyle(cancelButton.props.style)).toMatchObject({
            backgroundColor: expect.not.stringMatching(/^#fff$/i),
            borderColor: expect.not.stringMatching(/^#ddd$/i),
        });
        expect(flattenTestStyle(saveButton.props.style)).toMatchObject({
            backgroundColor: expect.not.stringMatching(/^#000$/i),
        });
    });

    it('renders an existing draft on a moved file line by matching the stored line hash', async () => {
        const { useCodeLinesReviewComments } = await import('./useCodeLinesReviewComments');
        const { computeLineContentHash } = await import('@/utils/text/lineContentHash');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
                kind: 'file',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const inserted = true;',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1,
                kind: 'file',
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'const moved = 2;',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ] as any;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source: 'file',
                lines,
                drafts: [{
                    id: 'draft-1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: {
                        kind: 'fileLine',
                        startLine: 1,
                        lineHash: computeLineContentHash('const moved = 2;'),
                    },
                    snapshot: {
                        selectedLines: ['const moved = 2;'],
                        beforeContext: [],
                        afterContext: [],
                    },
                    body: 'Keep the moved line anchored.',
                    createdAt: 1,
                }],
            });

            return (
                <React.Fragment>
                    <View testID="first-line">{controls!.renderAfterLine(lines[0])}</View>
                    <View testID="second-line">{controls!.renderAfterLine(lines[1])}</View>
                </React.Fragment>
            );
        }

        const screen = await renderScreen(<Harness />);

        const firstLine = screen.findByTestId('first-line');
        const secondLine = screen.findByTestId('second-line');
        if (!firstLine || !secondLine) {
            throw new Error('Expected review comment line containers to render');
        }
        const firstLineText = firstLine.findAllByType('Text' as any).map((n) => n.props.children).join(' ');
        const secondLineText = secondLine.findAllByType('Text' as any).map((n) => n.props.children).join(' ');

        expect(firstLineText).not.toContain('Keep the moved line anchored.');
        expect(secondLineText).toContain('Keep the moved line anchored.');
    });

    it('renders saved comments flush with the diff body and lets users edit them', async () => {
        const { useCodeLinesReviewComments } = await import('./useCodeLinesReviewComments');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
                kind: 'file',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const secret = "old";',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ] as any;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source: 'file',
                lines,
                drafts: [{
                    id: 'draft-1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: {
                        kind: 'fileLine',
                        startLine: 1,
                    },
                    snapshot: {
                        selectedLines: ['const secret = "old";'],
                        beforeContext: [],
                        afterContext: [],
                    },
                    body: 'Update the secret handling.',
                    createdAt: 1,
                }],
            });

            return <View testID="line">{controls!.renderAfterLine(lines[0])}</View>;
        }

        const screen = await renderScreen(<Harness />);

        const savedContainer = screen.findByTestId('review-comment-saved-drafts:f:1');
        if (!savedContainer) {
            throw new Error('Expected saved review comment container');
        }
        expect(flattenTestStyle(savedContainer.props.style).marginLeft ?? 0).toBe(0);

        await act(async () => {
            await screen.pressByTestIdAsync('review-comment-draft-edit:draft-1');
        });

        const inputs = screen.findAllByType('TextInput' as any);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.props.value).toBe('Update the secret handling.');
    });
});
