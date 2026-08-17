import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    ComposerAttachmentViewV1,
    PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

import type { AgentInputAttachmentsRowItem } from '../agentInputContracts';

const attachmentRowPlatform = vi.hoisted(() => ({
    os: 'web' as 'android' | 'web',
}));
const attachmentRowFocus = vi.hoisted(() => ({
    focusedTestIDs: [] as string[],
}));

type AttachmentRowPressableMockProps = React.Attributes & Readonly<{
    children?: React.ReactNode;
    testID?: string;
}>;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: React.forwardRef<any, AttachmentRowPressableMockProps>(
                ({ children, ...props }, ref) => {
                    React.useImperativeHandle(ref, () => ({
                        focus: () => {
                            if (typeof props.testID === 'string') {
                                attachmentRowFocus.focusedTestIDs.push(props.testID);
                            }
                        },
                    }), [props.testID]);
                    return React.createElement('Pressable', props, children);
                },
            ),
            Platform: {
                get OS() {
                    return attachmentRowPlatform.os;
                },
                select: (value: Record<string, unknown>) => (
                    value[attachmentRowPlatform.os] ?? value.native ?? value.web ?? value.default ?? null
                ),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { show: vi.fn(), alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key === 'common.remove' ? 'Remove' : key });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findNearestHostParent(node: ReactTestInstance | undefined): ReactTestInstance | null {
    let parent = node?.parent ?? null;
    while (parent && typeof parent.type !== 'string') {
        parent = parent.parent;
    }
    return parent;
}

describe('AgentInputAttachmentsRow', () => {
    beforeEach(() => {
        attachmentRowPlatform.os = 'web';
        attachmentRowFocus.focusedTestIDs.length = 0;
    });

    it('uses disjoint 48dp Android frames for preview and removal instead of overlapping hit slop', async () => {
        attachmentRowPlatform.os = 'android';
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[
                    {
                        kind: 'badge',
                        key: 'issue',
                        label: 'Issue 42',
                        testID: 'android-badge',
                        onPress: () => {},
                        onRemove: () => {},
                    },
                    {
                        kind: 'media',
                        key: 'screenshot',
                        label: 'Screenshot',
                        media: 'image',
                        preview: { kind: 'image', uri: 'https://example.test/screenshot.png' },
                        onRemove: () => {},
                    },
                    {
                        kind: 'surface',
                        key: 'summary',
                        label: 'Incident summary',
                        sizing: 'content',
                        renderedContent: <View />,
                        testID: 'android-surface',
                        onPress: () => {},
                        onRemove: () => {},
                    },
                ] satisfies readonly AgentInputAttachmentsRowItem[]}
            />,
        );
        const pairs = [
            ['android-badge-preview', 'android-badge-remove'],
            ['agent-input-attachment-image:screenshot', 'agent-input-attachment-remove:screenshot'],
            ['android-surface-preview', 'android-surface-remove'],
        ] as const;

        for (const [previewTestID, removeTestID] of pairs) {
            const preview = screen.findAllByTestId(previewTestID).find((node) => typeof node.type === 'string');
            const remove = screen.findAllByTestId(removeTestID).find((node) => typeof node.type === 'string');
            expect(findNearestHostParent(preview)).toBe(findNearestHostParent(remove));
            expect(remove?.props.hitSlop).toBeUndefined();
            expect(flattenStyle(preview?.props.style).minHeight).toBeGreaterThanOrEqual(48);
            expect(flattenStyle(preview?.props.style).minWidth).toBeGreaterThanOrEqual(48);
            expect(flattenStyle(remove?.props.style).minHeight).toBeGreaterThanOrEqual(48);
            expect(flattenStyle(remove?.props.style).minWidth).toBeGreaterThanOrEqual(48);
        }
    });

    it('renders a host-projected staged-media thumbnail without requiring a direct image URI', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onPreview = vi.fn();

        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[{
                    kind: 'media',
                    key: 'composer-video',
                    label: 'Incident recording',
                    media: 'video',
                    renderedPreview: <View testID="host-staged-thumbnail" />,
                    onPress: onPreview,
                    onRemove: () => {},
                }] satisfies readonly AgentInputAttachmentsRowItem[]}
            />,
        );

        expect(screen.findByTestId('host-staged-thumbnail')).toBeDefined();
        await screen.pressByTestIdAsync('agent-input-attachment-media:composer-video');
        expect(onPreview).toHaveBeenCalledTimes(1);
    });

    it('moves focus to a surviving attachment and then the Composer after host removal', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const focusComposer = vi.fn();

        function Harness(): React.ReactElement {
            const [items, setItems] = React.useState<readonly AgentInputAttachmentsRowItem[]>([
                {
                    kind: 'badge',
                    key: 'first',
                    label: 'First attachment',
                    testID: 'focus-first',
                    onPress: () => {},
                    onRemove: () => {
                        setItems((current) => current.filter((item) => item.key !== 'first'));
                    },
                },
                {
                    kind: 'badge',
                    key: 'second',
                    label: 'Second attachment',
                    testID: 'focus-second',
                    onPress: () => {},
                    onRemove: () => {
                        setItems((current) => current.filter((item) => item.key !== 'second'));
                    },
                },
            ]);
            return (
                <AgentInputAttachmentsRow
                    items={items}
                    onRequestComposerFocus={focusComposer}
                />
            );
        }

        const screen = await renderScreen(<Harness />);

        await screen.pressByTestIdAsync('focus-first-remove');
        expect(attachmentRowFocus.focusedTestIDs).toEqual(['focus-second-preview']);
        expect(focusComposer).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('focus-second-remove');
        expect(focusComposer).toHaveBeenCalledTimes(1);
    });

    it('gives each plugin attachment removal a distinct localized name without opening its preview', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const { projectComposerAttachmentRowItems } = await import('../../composer/composerAttachmentProjection');
        const onRemove = vi.fn();
        const onPreview = vi.fn();
        const attachments = [
            {
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
            },
            {
                v: 1,
                instanceId: 'issue-43',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '43',
                value: { issueId: 43 },
                presentation: { label: 'Issue #43', typeLabel: 'Issue' },
                availability: { status: 'ready' },
            },
        ] satisfies readonly ComposerAttachmentViewV1[];
        const entry = {
            id: 'acme.issues/issue',
            pluginId: 'acme.issues',
            identity: { pluginId: 'acme.issues', localId: 'issue' },
            immutableGenerationId: 'issues-generation-7',
            definition: {
                id: 'issue',
                title: 'Issue',
                icon: 'file',
                cardinality: 'many' as const,
                valueSchema: { type: 'object' },
                preview: {
                    kind: 'surface' as const,
                    renderer: { renderer: 'issue-preview' },
                    presentation: 'popover' as const,
                },
            },
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        const items = projectComposerAttachmentRowItems({
            attachments,
            onRemove,
            entriesById: { [entry.id]: entry },
            resolveInteraction: () => ({ onPress: onPreview }),
        });
        const screen = await renderScreen(<AgentInputAttachmentsRow items={items} />);
        const removeLabels = ['Remove Issue: Issue #42', 'Remove Issue: Issue #43'];
        const removals = screen.tree.root.findAll((node: any) => (
            typeof node.type === 'string'
            && node.props.accessibilityRole === 'button'
            && removeLabels.includes(node.props.accessibilityLabel)
        ));

        expect(removals).toHaveLength(2);
        for (const remove of removals) {
            expect(flattenStyle(remove.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
            act(() => {
                remove.props.onPress?.({} as never);
            });
        }

        expect(onRemove).toHaveBeenCalledTimes(2);
        expect(onRemove).toHaveBeenCalledWith('issue-42');
        expect(onRemove).toHaveBeenCalledWith('issue-43');
        expect(onPreview).not.toHaveBeenCalled();
    });

    it('keeps compact badge/media/surface items in one rail and puts a content surface in the row-owned band', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onRemove = vi.fn();
        const items = [
            { kind: 'badge', key: 'browser', label: 'Browser context', testID: 'row-badge' },
            {
                kind: 'media',
                key: 'image',
                label: 'Screenshot',
                media: 'image',
                preview: { kind: 'image', uri: 'https://example.test/screenshot.png' },
                testID: 'row-media',
            },
            {
                kind: 'surface',
                key: 'compact',
                label: 'Compact attachment',
                sizing: 'compact',
                renderedContent: <View testID="row-surface-compact" />,
                testID: 'row-surface-compact-host',
            },
            {
                kind: 'surface',
                key: 'content',
                label: 'Content attachment',
                sizing: 'content',
                renderedContent: <View testID="row-surface-content" />,
                testID: 'row-surface-content-host',
                onRemove,
            },
        ] satisfies readonly AgentInputAttachmentsRowItem[];

        const screen = await renderScreen(<AgentInputAttachmentsRow items={items} />);
        const horizontalRails = screen.tree.root.findAll((node: any) => (
            node.type === 'ScrollView' && node.props.horizontal === true
        ));

        expect(horizontalRails).toHaveLength(1);
        expect(horizontalRails[0]?.findByProps({ testID: 'row-badge' })).toBeTruthy();
        expect(horizontalRails[0]?.findByProps({ testID: 'agent-input-attachment-image:image' })).toBeTruthy();
        expect(horizontalRails[0]?.findByProps({ testID: 'row-surface-compact' })).toBeTruthy();
        expect(() => horizontalRails[0]?.findByProps({ testID: 'row-surface-content' })).toThrow();
        expect(screen.findByTestId('row-surface-content')).toBeTruthy();
        expect(screen.findByTestId('row-surface-content-host-remove')).toBeTruthy();
    });

    it('mounts only visible content surface bodies while every host header remains reachable in the bounded attachment viewport', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const items = Array.from({ length: 64 }, (_value, index) => ({
            kind: 'surface' as const,
            key: `native-content-${index}`,
            label: `Native content attachment ${index}`,
            sizing: 'content' as const,
            renderedContent: <View testID={`native-content-body:${index}`} />,
            testID: `native-content-surface:${index}`,
        })) satisfies readonly AgentInputAttachmentsRowItem[];
        const render = (offset: number) => React.createElement(
            AgentInputAttachmentsRow,
            {
                items,
                verticalViewport: { offset, height: 48 },
            },
        );

        const screen = await renderScreen(render(0));

        expect(screen.findAllByTestId('native-content-surface:0')).toHaveLength(1);
        expect(screen.findAllByTestId('native-content-surface:63')).toHaveLength(1);
        expect(screen.findAllByTestId('native-content-body:0')).toHaveLength(0);
        expect(screen.findAllByTestId('native-content-body:63')).toHaveLength(0);

        const contentBand = screen.findByTestId('agent-input-attachment-content-surface-band');
        const firstSurface = screen.findByTestId('native-content-surface:0');
        const lastSurface = screen.findByTestId('native-content-surface:63');
        expect(contentBand).toBeTruthy();
        expect(firstSurface).toBeTruthy();
        expect(lastSurface).toBeTruthy();

        act(() => {
            contentBand?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 64 * 48 } } });
            firstSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
            lastSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 63 * 48, width: 320, height: 48 } } });
        });

        expect(screen.findAllByTestId('native-content-body:0')).toHaveLength(1);
        expect(screen.findAllByTestId('native-content-body:63')).toHaveLength(0);

        await act(async () => {
            screen.tree.update(render(63 * 48));
        });

        expect(screen.findAllByTestId('native-content-body:0')).toHaveLength(0);
        expect(screen.findAllByTestId('native-content-body:63')).toHaveLength(1);
    });

    it('requires the compact rail viewport as well as the attachment viewport before mounting compact surface bodies', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const items = [
            {
                kind: 'surface',
                key: 'compact-first',
                label: 'First compact surface',
                sizing: 'compact',
                renderedContent: <View testID="native-compact-body:first" />,
                testID: 'native-compact-surface:first',
            },
            {
                kind: 'surface',
                key: 'compact-second',
                label: 'Second compact surface',
                sizing: 'compact',
                renderedContent: <View testID="native-compact-body:second" />,
                testID: 'native-compact-surface:second',
            },
        ] satisfies readonly AgentInputAttachmentsRowItem[];
        const element = React.createElement(
            AgentInputAttachmentsRow,
            {
                items,
                verticalViewport: { offset: 0, height: 48 },
            },
        );
        const screen = await renderScreen(element);

        expect(screen.findAllByTestId('native-compact-body:first')).toHaveLength(0);
        expect(screen.findAllByTestId('native-compact-body:second')).toHaveLength(0);

        const compactViewport = screen.findByTestId('agent-input-attachment-compact-viewport');
        const firstSurface = screen.findByTestId('native-compact-surface:first');
        const secondSurface = screen.findByTestId('native-compact-surface:second');
        expect(compactViewport).toBeTruthy();
        expect(firstSurface).toBeTruthy();
        expect(secondSurface).toBeTruthy();

        act(() => {
            compactViewport?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 64, height: 48 } } });
            firstSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 64, height: 48 } } });
            secondSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 80, y: 0, width: 64, height: 48 } } });
        });

        expect(screen.findAllByTestId('native-compact-body:first')).toHaveLength(1);
        expect(screen.findAllByTestId('native-compact-body:second')).toHaveLength(0);

        act(() => {
            compactViewport?.props.onScroll?.({ nativeEvent: { contentOffset: { x: 80, y: 0 } } });
        });

        expect(screen.findAllByTestId('native-compact-body:first')).toHaveLength(0);
        expect(screen.findAllByTestId('native-compact-body:second')).toHaveLength(1);
    });

    it('keeps host-owned removal labelled, reachable, and minimum-sized for every row arm', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const removeBadge = vi.fn();
        const removeMedia = vi.fn();
        const removeSurface = vi.fn();
        const items = [
            {
                kind: 'badge',
                key: 'issue',
                label: 'Issue 42',
                testID: 'row-remove-badge',
                removeAccessibilityLabel: 'Remove issue 42',
                onRemove: removeBadge,
            },
            {
                kind: 'media',
                key: 'screenshot',
                label: 'Screenshot',
                media: 'image',
                preview: { kind: 'image', uri: 'https://example.test/screenshot.png' },
                removeAccessibilityLabel: 'Remove screenshot',
                onRemove: removeMedia,
            },
            {
                kind: 'surface',
                key: 'summary',
                label: 'Incident summary',
                sizing: 'content',
                renderedContent: <View testID="row-remove-surface-content" />,
                testID: 'row-remove-surface',
                removeAccessibilityLabel: 'Remove incident summary',
                onRemove: removeSurface,
            },
        ] satisfies readonly AgentInputAttachmentsRowItem[];

        const screen = await renderScreen(<AgentInputAttachmentsRow items={items} />);
        const removals = [
            ['row-remove-badge-remove', 'Remove issue 42', removeBadge],
            ['agent-input-attachment-remove:screenshot', 'Remove screenshot', removeMedia],
            ['row-remove-surface-remove', 'Remove incident summary', removeSurface],
        ] as const;

        for (const [testID, label, handler] of removals) {
            const remove = screen.findByTestId(testID);
            expect(remove?.props.accessibilityRole).toBe('button');
            expect(remove?.props.accessibilityLabel).toBe(label);
            const style = flattenStyle(remove?.props.style);
            expect(Math.max(Number(style.minHeight ?? 0), Number(style.height ?? 0))).toBeGreaterThanOrEqual(44);
            expect(Math.max(Number(style.minWidth ?? 0), Number(style.width ?? 0))).toBeGreaterThanOrEqual(44);
            await screen.pressByTestIdAsync(testID);
            expect(handler).toHaveBeenCalledTimes(1);
        }
    });

    it('keeps host removal available while an upload is in progress', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onRemove = vi.fn();
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[{
                    kind: 'media',
                    key: 'uploading-image',
                    label: 'Uploading screenshot',
                    media: 'image',
                    preview: { kind: 'image', uri: 'https://example.test/uploading.png' },
                    status: 'uploading',
                    uploadProgress: { uploadedBytes: 32, totalBytes: 100 },
                    onRemove,
                }]}
            />,
        );

        const remove = screen.findByTestId('agent-input-attachment-remove:uploading-image');
        expect(remove?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('agent-input-attachment-remove:uploading-image');
        expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('does not activate an attachment preview when its host removal is pressed', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onPress = vi.fn();
        const onRemove = vi.fn();
        const onFallbackPress = vi.fn();
        const onFallbackRemove = vi.fn();
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[
                    {
                        kind: 'badge',
                        key: 'previewable-badge',
                        label: 'Previewable context',
                        testID: 'previewable-badge',
                        onPress,
                        onRemove,
                    },
                    {
                        kind: 'media',
                        key: 'previewable-fallback',
                        label: 'Previewable fallback',
                        media: 'video',
                        testID: 'previewable-fallback',
                        removeTestID: 'previewable-fallback-remove',
                        onPress: onFallbackPress,
                        onRemove: onFallbackRemove,
                    },
                ]}
            />,
        );

        expect(screen.findByTestId('previewable-badge')?.props.accessibilityRole).not.toBe('button');
        expect(screen.findByTestId('previewable-badge-preview')?.props.accessibilityRole).toBe('button');
        expect(screen.findByTestId('previewable-fallback')?.props.accessibilityRole).not.toBe('button');
        expect(screen.findByTestId('previewable-fallback-preview')?.props.accessibilityRole).toBe('button');
        await screen.pressByTestIdAsync('previewable-badge-remove');
        await screen.pressByTestIdAsync('previewable-fallback-remove');

        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onPress).not.toHaveBeenCalled();
        expect(onFallbackRemove).toHaveBeenCalledTimes(1);
        expect(onFallbackPress).not.toHaveBeenCalled();
    });

    it('uses host preview affordances for adapter media and custom surfaces while retaining error feedback', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onMediaPreview = vi.fn();
        const onSurfacePreview = vi.fn();
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[
                    {
                        kind: 'media',
                        key: 'adapter-image',
                        label: 'Adapter image',
                        media: 'image',
                        preview: { kind: 'image', uri: 'https://example.test/adapter.png' },
                        onPress: onMediaPreview,
                    },
                    {
                        kind: 'surface',
                        key: 'preview-surface',
                        label: 'Incident summary',
                        sizing: 'content',
                        renderedContent: <View testID="row-preview-surface-content" />,
                        testID: 'row-preview-surface',
                        onPress: onSurfacePreview,
                    },
                    {
                        kind: 'badge',
                        key: 'stalled-badge',
                        label: 'Stalled context',
                        status: 'error',
                        error: 'Context could not be prepared',
                    },
                ] satisfies readonly AgentInputAttachmentsRowItem[]}
            />,
        );

        await screen.pressByTestIdAsync('agent-input-attachment-image:adapter-image');
        expect(onMediaPreview).toHaveBeenCalledTimes(1);

        await screen.pressByTestIdAsync('row-preview-surface-preview');
        expect(onSurfacePreview).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('agent-input-attachment-error:stalled-badge')).toBeTruthy();
    });

    it('announces unavailable or invalid attachments while retaining their localized removal affordance', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onRemove = vi.fn();
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[
                    {
                        kind: 'badge',
                        key: 'unavailable-issue',
                        label: 'Unavailable issue',
                        availability: 'unavailable',
                        testID: 'unavailable-issue',
                        removeAccessibilityLabel: 'Remove unavailable issue',
                        onRemove: () => onRemove('unavailable'),
                    },
                    {
                        kind: 'badge',
                        key: 'invalid-issue',
                        label: 'Invalid issue',
                        availability: 'invalid',
                        testID: 'invalid-issue',
                        removeAccessibilityLabel: 'Remove invalid issue',
                        onRemove: () => onRemove('invalid'),
                    },
                ] satisfies readonly AgentInputAttachmentsRowItem[]}
            />,
        );

        expect(screen.findByTestId('agent-input-attachment-error:unavailable-issue')?.props).toMatchObject({
            accessibilityLabel: 'common.unavailable',
            accessibilityRole: 'alert',
        });
        expect(screen.findByTestId('agent-input-attachment-error:invalid-issue')?.props).toMatchObject({
            accessibilityLabel: 'errors.invalidFormat',
            accessibilityRole: 'alert',
        });
        expect(screen.findByTestId('unavailable-issue-remove')?.props.accessibilityLabel)
            .toBe('Remove unavailable issue');
        expect(screen.findByTestId('invalid-issue-remove')?.props.accessibilityLabel)
            .toBe('Remove invalid issue');

        await screen.pressByTestIdAsync('unavailable-issue-remove');
        await screen.pressByTestIdAsync('invalid-issue-remove');

        expect(onRemove).toHaveBeenCalledWith('unavailable');
        expect(onRemove).toHaveBeenCalledWith('invalid');
    });

    it('closes a contentless attachment preview through dismissal and host removal', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const onRemove = vi.fn();
        const renderPreviewPopover = vi.fn((ctx: Readonly<{
            open: boolean;
            anchorRef: React.RefObject<any>;
            onRequestClose: () => void;
        }>) => ctx.open
            ? React.createElement('AttachmentPreviewPopover', {
                testID: 'row-rendered-preview-popover',
                anchorRef: ctx.anchorRef,
                onRequestClose: ctx.onRequestClose,
            })
            : null);
        const screen = await renderScreen(
            <AgentInputAttachmentsRow
                items={[{
                    kind: 'badge',
                    key: 'plugin-issue',
                    label: 'Issue 42',
                    testID: 'row-rendered-preview',
                    renderPreviewPopover,
                    onRemove,
                }]}
            />,
        );

        expect(screen.findByTestId('row-rendered-preview-popover')).toBeNull();
        const preview = screen.findByTestId('row-rendered-preview-preview');
        expect(preview).toBeTruthy();
        act(() => {
            preview?.props.onPress?.({} as never);
        });

        const popover = screen.findByTestId('row-rendered-preview-popover');
        expect(popover?.props.anchorRef).toBeTruthy();
        expect(renderPreviewPopover).toHaveBeenCalledWith(expect.objectContaining({ open: true }));
        act(() => {
            popover?.props.onRequestClose();
        });
        expect(screen.findByTestId('row-rendered-preview-popover')).toBeNull();

        act(() => {
            preview?.props.onPress?.({} as never);
        });
        expect(screen.findByTestId('row-rendered-preview-popover')).toBeTruthy();
        await screen.pressByTestIdAsync('row-rendered-preview-remove');
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('row-rendered-preview-popover')).toBeNull();
    });

    it('retires an open preview when the exact renderer interaction is replaced', async () => {
        const { AgentInputAttachmentsRow } = await import('./AgentInputAttachmentsRow');
        const renderPreviewPopoverA = vi.fn((ctx: Readonly<{
            open: boolean;
            anchorRef: React.RefObject<any>;
            onRequestClose: () => void;
        }>) => ctx.open
            ? React.createElement('AttachmentPreviewPopover', {
                testID: 'row-generation-a-preview',
                anchorRef: ctx.anchorRef,
                onRequestClose: ctx.onRequestClose,
            })
            : null);
        const renderPreviewPopoverB = vi.fn((ctx: Readonly<{
            open: boolean;
            anchorRef: React.RefObject<any>;
            onRequestClose: () => void;
        }>) => ctx.open
            ? React.createElement('AttachmentPreviewPopover', {
                testID: 'row-generation-b-preview',
                anchorRef: ctx.anchorRef,
                onRequestClose: ctx.onRequestClose,
            })
            : null);
        const item = (renderPreviewPopover: typeof renderPreviewPopoverA): AgentInputAttachmentsRowItem => ({
            kind: 'badge',
            key: 'plugin-issue',
            label: 'Issue 42',
            testID: 'row-generation-preview',
            renderPreviewPopover,
        });
        const screen = await renderScreen(
            <AgentInputAttachmentsRow items={[item(renderPreviewPopoverA)]} />,
        );

        act(() => {
            screen.findByTestId('row-generation-preview-preview')?.props.onPress?.({} as never);
        });
        expect(screen.findByTestId('row-generation-a-preview')).toBeTruthy();

        await act(async () => {
            screen.tree.update(
                <AgentInputAttachmentsRow items={[item(renderPreviewPopoverB)]} />,
            );
        });

        expect(screen.findByTestId('row-generation-a-preview')).toBeNull();
        expect(screen.findByTestId('row-generation-b-preview')).toBeNull();
        expect(renderPreviewPopoverB).not.toHaveBeenCalledWith(expect.objectContaining({ open: true }));
    });

});
