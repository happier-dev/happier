import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'session.agentActivity.backgroundTask.statusWithDuration') {
                return `${String(params?.status)} · ${String(params?.duration)}`;
            }
            return key.split('.').pop() ?? key;
        },
    });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
    // The scale, mirrored: this detail is indented against the shared row geometry, which reads
    // `ICON_SIZE` through `itemDensityMetrics`, so a mock that stubs only the component leaves that
    // table undefined at module load. Importing the real module instead pulls the whole icon set in.
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join('');
    const record = value as { children?: unknown; props?: { children?: unknown } };
    if (record.props) return collectText(record.props.children);
    return collectText(record.children);
}

function record(overrides: Partial<SessionBackgroundTaskRecordV1> = {}): SessionBackgroundTaskRecordV1 {
    return {
        v: 1,
        taskId: 'task_1',
        kind: 'command',
        status: 'running',
        updatedAt: 1_700_000_010_000,
        ...overrides,
    } as SessionBackgroundTaskRecordV1;
}

async function render(props: Readonly<{
    record: SessionBackgroundTaskRecordV1;
    onOpenLaunchingCommand?: () => void;
}>) {
    const { BackgroundTaskDetail } = await import('./BackgroundTaskDetail');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            <BackgroundTaskDetail
                record={props.record}
                testID="bg"
                {...(props.onOpenLaunchingCommand
                    ? { onOpenLaunchingCommand: props.onOpenLaunchingCommand }
                    : null)}
            />,
        );
    });
    return tree as renderer.ReactTestRenderer;
}

function queryTestId(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAllByProps({ testID })[0] ?? null;
}

describe('BackgroundTaskDetail', () => {
    it('states the redacted label, the status and the total the record attests', async () => {
        const tree = await render({
            record: record({
                label: 'curl [REDACTED] https://example.test',
                status: 'succeeded',
                startedAt: 1_700_000_000_000,
                endedAt: 1_700_000_016_000,
                summary: 'Background command completed',
            }),
        });

        expect(collectText(queryTestId(tree, 'bg:label')?.props.children))
            .toBe('curl [REDACTED] https://example.test');
        expect(collectText(queryTestId(tree, 'bg:status')?.props.children)).toBe('succeeded · 0:16');
        expect(collectText(queryTestId(tree, 'bg:summary')?.props.children))
            .toBe('Background command completed');
        act(() => tree.unmount());
    });

    it('renders no duration at all when the record attests no start', async () => {
        // D-8: a terminal record whose start was never observed must show nothing, never `0:00`.
        const tree = await render({
            record: record({ status: 'succeeded', endedAt: 1_700_000_016_000 }),
        });

        const status = collectText(queryTestId(tree, 'bg:status')?.props.children);
        expect(status).toBe('succeeded');
        expect(status).not.toContain('0:00');
        act(() => tree.unmount());
    });

    it('says failed and stops there when no exit code exists', async () => {
        // Failed-without-a-code is the designed state: the record carries no exit code because no
        // producer for one exists, so nothing here may append or default one.
        const tree = await render({
            record: record({ status: 'failed', label: './deploy.sh' }),
        });

        const rendered = collectText(tree.toJSON());
        expect(collectText(queryTestId(tree, 'bg:status')?.props.children)).toBe('failed');
        expect(rendered).not.toMatch(/exit/i);
        act(() => tree.unmount());
    });

    it('never renders output, a working directory, or a retention promise', async () => {
        // The three fabrications §4.9 turned into binding negatives. The record has no field for
        // any of them, so the only way they could appear is if this view invented them.
        const tree = await render({
            record: record({
                label: 'grep -rn "thing" .',
                status: 'running',
                startedAt: 1_700_000_000_000,
                summary: 'Reading logs',
            }),
        });

        const rendered = collectText(tree.toJSON());
        expect(rendered).not.toMatch(/stdout|stderr/i);
        expect(rendered).not.toMatch(/cwd|directory/i);
        expect(rendered).not.toMatch(/hour|retain|expire/i);
        act(() => tree.unmount());
    });

    it('offers the launching Bash card only when there is one to open', async () => {
        const withoutLaunch = await render({ record: record({ label: 'sleep 60' }) });
        expect(queryTestId(withoutLaunch, 'bg:open-command')).toBeNull();
        act(() => withoutLaunch.unmount());

        const onOpen = vi.fn();
        const withLaunch = await render({
            record: record({ label: 'sleep 60' }),
            onOpenLaunchingCommand: onOpen,
        });
        const link = queryTestId(withLaunch, 'bg:open-command');
        expect(link).not.toBeNull();
        act(() => link!.props.onPress());
        expect(onOpen).toHaveBeenCalledTimes(1);
        act(() => withLaunch.unmount());
    });
});
