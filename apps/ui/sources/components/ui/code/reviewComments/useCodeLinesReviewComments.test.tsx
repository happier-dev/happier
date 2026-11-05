import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Pressable, Text, View } from 'react-native';
import { pressTestInstanceAsync, renderHook, renderScreen } from '@/dev/testkit';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { computeLineContentHash } from '@/utils/text/lineContentHash';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { useCodeLinesReviewComments } from './useCodeLinesReviewComments';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    // The mock factory, not the testkit index: the index's graph imports react-native, so loading it here
    // waits on this very factory and module collection never finishes.
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock({
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
        TextInput: (props: any) => React.createElement('TextInput', props),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});

describe('useCodeLinesReviewComments', () => {
    it('does not attach moved repeated lines or ranges with changed interior content', async () => {
        const lines = buildCodeLinesFromFile({ text: 'first();\nchanged();\nlast();\nsame();\nsame();' });
        const drafts: ReviewCommentDraft[] = [
            { id: 'range', filePath: 'a.ts', source: 'file', anchor: { kind: 'range', filePath: 'a.ts', startLine: 1, endLine: 3, startLineHash: computeLineContentHash('first();'), endLineHash: computeLineContentHash('last();'), selectedTextHash: computeLineContentHash('first();\noriginal();\nlast();') }, snapshot: { selectedLines: ['first();', 'original();', 'last();'], beforeContext: [], afterContext: [] }, body: 'range', createdAt: 1 },
            { id: 'repeat', filePath: 'a.ts', source: 'file', anchor: { kind: 'line', filePath: 'a.ts', line: 99, lineHash: computeLineContentHash('same();') }, snapshot: { selectedLines: ['same();'], beforeContext: [], afterContext: [] }, body: 'repeat', createdAt: 1 },
        ];
        const hook = await renderHook(() => useCodeLinesReviewComments({ enabled: true, filePath: 'a.ts', source: 'file', lines, drafts }));
        expect(lines.every((line) => hook.getCurrent()!.renderAfterLine(line) === null)).toBe(true);
    });

    it('retains predecessor prefix hashes on their before side without moving to after lines', async () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1,2 +1,2 @@\n-same();  \n+same();  \n context();' });
        // Literal emitted by the inspected 0.2 HEAD 388915739 codec and producer.
        const drafts: ReviewCommentDraft[] = [{ id: 'old', filePath: 'a.ts', source: 'diff', anchor: { kind: 'line', filePath: 'a.ts', line: 99, side: 'before', lineHash: 'lh1:ba222596f94ab7a7' }, snapshot: { selectedLines: ['-same();'], beforeContext: [], afterContext: [] }, body: 'old', createdAt: 1 }];
        const hook = await renderHook(() => useCodeLinesReviewComments({ enabled: true, filePath: 'a.ts', source: 'diff', lines, drafts }));
        const before = lines.find((line) => line.kind === 'remove')!;
        const after = lines.find((line) => line.kind === 'add')!;
        expect(hook.getCurrent()!.renderAfterLine(before)).not.toBeNull();
        expect(hook.getCurrent()!.renderAfterLine(after)).toBeNull();
    });

    it('rejects a mixed-side range before opening a composer that cannot save it', async () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-old();\n+new();' });
        const range = lines.filter((line) => !line.renderIsHeaderLine);
        const onError = vi.fn();
        const hook = await renderHook(() => useCodeLinesReviewComments({ enabled: true, filePath: 'a.ts', source: 'diff', lines, drafts: [], onError }));
        await act(async () => hook.getCurrent()!.onPressAddCommentRange(range));
        expect(range.some((line) => hook.getCurrent()!.isCommentActive(line))).toBe(false);
        expect(onError).toHaveBeenCalled();
    });
    it('toggles an inline composer after pressing add-comment for a line', async () => {
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
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
        expect(inputStyle.outlineWidth ?? 0).toBe(0);
        expect(inputStyle.boxShadow).toBeUndefined();
    });

    it.each(['file', 'diff'] as const)('opens one composer after the end line and saves the complete %s range comment', async (source) => {
        const onUpsertDraft = vi.fn();
        const lines = source === 'file'
            ? buildCodeLinesFromFile({ text: 'const a = 1;\nconst b = 2;\nconst c = 3;' })
            : buildCodeLinesFromUnifiedDiff({ unifiedDiff: ['--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1,2000 @@',
                ...Array.from({ length: 2000 }, (_, index) => `+export const qaJourney${index + 1} = "needle-${index + 1}";`), ''].join('\n') });
        const startLine = source === 'file' ? 1 : 1991;
        const endLine = source === 'file' ? 2 : 1993;
        const range = lines.filter(line => !line.renderIsHeaderLine && line.newLine !== null && line.newLine >= startLine && line.newLine <= endLine);
        const first = range[0]!;
        const last = range[range.length - 1]!;
        const next = lines.find(line => line.newLine === endLine + 1)!;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source,
                lines,
                drafts: [],
                onUpsertDraft,
            });

            return (
                <React.Fragment>
                    <Pressable testID="add-range-trigger" onPress={() => controls!.onPressAddCommentRange(range)} />
                    <Text testID="active-comment-lines">{lines.filter(line => controls!.isCommentActive(line)).map(line => line.newLine).join(',')}</Text>
                    <View testID="after-line-1">{controls!.renderAfterLine(first)}</View>
                    <View testID="after-line-2">{controls!.renderAfterLine(last)}</View>
                    <View testID="after-line-3">{controls!.renderAfterLine(next)}</View>
                </React.Fragment>
            );
        }

        const screen = await renderScreen(<Harness />);

        await act(async () => {
            await screen.pressByTestIdAsync('add-range-trigger');
        });
        expect(screen.findByTestId('active-comment-lines')!.props.children).toBe(source === 'file' ? '1,2' : '1991,1992,1993');

        const afterLineOne = screen.findByTestId('after-line-1');
        const afterLineTwo = screen.findByTestId('after-line-2');
        const afterLineThree = screen.findByTestId('after-line-3');
        if (!afterLineOne || !afterLineTwo || !afterLineThree) {
            throw new Error('Expected line comment containers');
        }

        expect(afterLineOne.findAllByType('TextInput' as any)).toHaveLength(0);
        expect(afterLineTwo.findAllByType('TextInput' as any)).toHaveLength(1);
        expect(afterLineThree.findAllByType('TextInput' as any)).toHaveLength(0);

        const input = afterLineTwo.findAllByType('TextInput' as any)[0]!;
        await act(async () => {
            input.props.onChangeText('Review this range');
        });

        const save = afterLineTwo.findAllByType(Pressable).find((node) => (
            node.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Save')
        ));
        if (!save) throw new Error('Expected save button');

        await pressTestInstanceAsync(save, 'review comment Save button');

        expect(onUpsertDraft).toHaveBeenCalledTimes(1);
        expect(onUpsertDraft.mock.calls[0]?.[0]).toMatchObject({
            filePath: 'src/a.ts',
            source,
            body: 'Review this range',
            anchor: {
                kind: 'range',
                filePath: 'src/a.ts',
                startLine,
                endLine,
                ...(source === 'diff' ? { side: 'after' } : {}),
            },
            snapshot: {
                selectedLines: range.map(line => line.renderCodeText),
            },
        });
    });

    it('uses themed fallbacks for the inline composer instead of raw color literals', async () => {
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
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

        expect(composerContainerStyle.borderColor).not.toBe('#ddd');
        expect(composerContainerStyle.backgroundColor).not.toBe('#fff');
    });

    it('renders an existing draft on a moved file line by matching the stored line hash', async () => {
        const { computeLineContentHash } = await import('@/utils/text/lineContentHash');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
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
                sourceIndex: 1, hunkIndex: null,
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
        expect(firstLine.findAllByType('EnrichedMarkdownText' as never)).toHaveLength(0);
        expect(secondLine.findAllByType('EnrichedMarkdownText' as never)[0]?.props.markdown).toBe('Keep the moved line anchored.');
    });

    it('renders saved comments flush with the diff body', async () => {
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
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

    });
});
