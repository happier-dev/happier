import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ExecutionRunRow } from './ExecutionRunRow';

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
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ storage: { getState: () => ({ settingsScope: null, settings: {} }) } });
});
vi.mock('@/components/ui/text/Text', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});

const run = {
    runId: 'run_1',
    intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    status: 'running',
    display: { title: 'Reviewer A' },
} as const;

async function renderRow(onPress?: () => void) {
    return renderScreen(React.createElement(ExecutionRunRow, { run: run as any, onPress }));
}

describe('ExecutionRunRow', () => {
    it('shows the host-resolved provenance and model in the existing subtitle while retaining operational facts', async () => {
        const screen = await renderScreen(<ExecutionRunRow run={{ ...run,
            resolvedSelection: { source: 'inherited', modelId: 'applied-model', connectedServices: null },
        }} subtitle="Run run_1 · PID 123" />);
        expect(screen.getTextContent()).toContain('runPage.menu.selectionInherited · applied-model');
        expect(screen.getTextContent()).toContain('Run run_1 · PID 123');
        standardCleanup();
    });

    it('announces an actionable row as a button with its own title and an open hint', async () => {
        const screen = await renderRow(vi.fn());

        const row = screen.tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!;
        expect(row.props.accessibilityRole).toBe('button');
        expect(row.props.accessibilityLabel).toBe('Reviewer A');
        expect(row.props.accessibilityHint).toBe('runs.openRun');
        standardCleanup();
    });

    it('meets the shared platform interactive target on every platform when it is actionable', async () => {
        const originalPlatform = Platform.OS;
        try {
            for (const platform of ['android', 'ios', 'web'] as const) {
                Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
                const screen = await renderRow(vi.fn());
                const targetSize = resolveMinimumInteractiveTargetSize(platform);

                const style = flattenTestStyle(
                    screen.tree.root.findAll((node) => String(node.type) === 'Pressable')[0]?.props.style,
                );
                expect(style.minWidth).toBe(targetSize);
                expect(style.minHeight).toBe(targetSize);

                await screen.unmount();
            }
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
        standardCleanup();
    });

    /**
     * A row a host did not wire is a read-only summary. Promising a button role or
     * padding it to a touch target would announce an interaction that does not exist.
     */
    it('stays a plain summary without a button role or enlarged target when it is not actionable', async () => {
        const screen = await renderRow(undefined);

        const row = screen.tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!;
        expect(row.props.accessibilityRole).toBeUndefined();
        expect(row.props.accessibilityHint).toBeUndefined();
        expect(row.props.accessibilityState).toMatchObject({ disabled: true });
        const style = flattenTestStyle(row.props.style);
        expect(style.minWidth).toBeUndefined();
        expect(style.minHeight).toBeUndefined();
        standardCleanup();
    });

    it('says the run\'s state in the roster\'s words and tone, never the raw wire token', async () => {
        const failed = await renderScreen(React.createElement(ExecutionRunRow, { run: { ...run, status: 'timeout' } as any }));
        const text = failed.getTextContent();
        expect(text).toContain('sessionAgentActivity.status.timedOut');
        expect(text).not.toContain('timeout');
        standardCleanup();

        const crashed = await renderScreen(React.createElement(ExecutionRunRow, { run: { ...run, status: 'failed' } as any }));
        expect(crashed.findByTestId('execution-run-row-status:variant:danger')).not.toBeNull();
        standardCleanup();
    });
});
