import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '../sessionSubagentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('View', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'session.subagents.kind.execution_run') return 'Subagent';
                if (key === 'session.subagents.intent.review') return 'Review';
                if (key === 'session.subagents.panel.typeFact' && values?.value) return `Type: ${values.value}`;
                if (key === 'session.subagents.panel.backendFact' && values?.value) return `Backend: ${values.value}`;
                if (key === 'session.subagents.panel.intentFact' && values?.value) return `Intent: ${values.value}`;
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    surfaceHigh: '#222',
                    divider: '#333',
                    text: '#eee',
                    textSecondary: '#aaa',
                },
            },
        });
    },
});

describe('SessionSubagentOverviewCard', () => {
    it('renders the shared compact fact pills for execution runs', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const subagent: SessionSubagent = {
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_1' },
            transcript: { toolMessageRouteId: 'tool:toolu_1', toolId: 'toolu_1', sidechainId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex', intent: 'review', runClass: 'long_lived' },
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'run_1' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        const screen = await renderScreen(<SessionSubagentOverviewCard subagent={subagent} />);
        const textContent = screen.getTextContent();

        expect(textContent).toContain('Type: Subagent');
        expect(textContent).toContain('Backend: codex');
        expect(textContent).toContain('Intent: Review');
    });
});
