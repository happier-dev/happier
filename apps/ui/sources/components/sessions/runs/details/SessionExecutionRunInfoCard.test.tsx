import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: any) => values?.web ?? values?.default,
    },
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            settings: {
                acpCatalogSettingsV1: { v: 2, backends: [] },
            },
        }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#111',
                        surfaceHigh: '#222',
                        divider: '#333',
                        text: '#eee',
                        textSecondary: '#aaa',
                        accent: {
                            blue: '#06f',
                            green: '#0a0',
                            orange: '#f80',
                            red: '#f33',
                        },
                    },
                })
                : value,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/text', () => ({
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'session.subagents.intent.review') return 'Review';
        if (key === 'executionRuns.details.labels.backend' && values?.value) return `Backend: ${values.value}`;
        if (key === 'executionRuns.details.labels.permissions' && values?.value) return `Permissions: ${values.value}`;
        if (key === 'executionRuns.details.labels.mode' && values?.value) return `Mode: ${values.value}`;
        if (key === 'executionRuns.details.labels.runId' && values?.value) return `Run ID: ${values.value}`;
        if (key === 'executionRuns.details.labels.statusValue' && values?.value) return `Status: ${values.value}`;
        if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) return `${values.intent} Subagent`;
        return key;
    },
}));

describe('SessionExecutionRunInfoCard', () => {
    it('renders a user-facing title and labeled facts instead of a raw run-id header', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionExecutionRunInfoCard
                    run={{
                        runId: 'run_1',
                        callId: 'toolu_1',
                        sidechainId: 'toolu_1',
                        intent: 'review',
                        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                        permissionMode: 'safe_yolo',
                        runClass: 'bounded',
                        ioMode: 'streaming',
                        status: 'running',
                        startedAtMs: 1,
                    } as any}
                    daemonProcessLine="pid 123"
                />,
            );
        });

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Review Subagent');
        expect(text).toContain('Run ID: run_1');
        expect(text).toContain('Backend: codex');
        expect(text).toContain('Permissions: safe_yolo');
        expect(text).toContain('Mode: bounded · streaming');
        expect(text).toContain('Status: running');
    });
});
