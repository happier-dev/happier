import * as React from 'react';
import { StyleSheet } from 'react-native';
import { HappierWorkSummary } from '@happier-dev/plugin-ui/presentation';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { NO_SESSION_AGENT_ACTIVITY_ATTENTION, type AgentActivityEntry } from '@/sync/domains/session/agentActivity';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SessionAgentActivitySummary } = await import('./SessionAgentActivitySummary');
const { resolveSessionAgentActivityPresentation } = await import('./sessionAgentActivityPresentation');
const { workStatusWordStyle } = await import('@/components/work/status/workStatusTreatment');

function entry(status: AgentActivityEntry['status']): AgentActivityEntry {
    return {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status,
        title: 'Review',
        metaDetail: null,
        startedAtMs: 1,
        endedAtMs: 2,
        provenance: 'merged',
        detailState: 'loaded',
        parentId: null,
        runId: 'run_1',
        sidechainId: null,
        subagentId: null,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

async function stateWordStyle(status: AgentActivityEntry['status']) {
    const presentation = resolveSessionAgentActivityPresentation({ entry: entry(status) });
    const screen = await renderScreen(<SessionAgentActivitySummary presentation={presentation} testID="row" />);
    return StyleSheet.flatten(screen.findHostByTestId('row:state:label')?.props.style) ?? {};
}

describe('SessionAgentActivitySummary', () => {
    it('words an ended unit in the one work-status treatment: a timeout asks for attention, a failure is trouble', async () => {
        // Ended work reads the same here as on the Work row, the run row and the worker card (INT T4).
        expect(await stateWordStyle('timedOut')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('attention')));
        expect(await stateWordStyle('failed')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('danger')));
        expect(await stateWordStyle('succeeded')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('neutral')));
    });

    it('draws through the shared Work summary leaf plugin authors use', async () => {
        const presentation = resolveSessionAgentActivityPresentation({ entry: entry('running') });
        const screen = await renderScreen(<SessionAgentActivitySummary presentation={presentation} testID="row" />);
        const shared = screen.findAll((node) => node.type === HappierWorkSummary
            || node.type === (HappierWorkSummary as unknown as { type?: unknown }).type);
        expect(shared).toHaveLength(1);
        expect(screen.findByTestId('row:live')).not.toBeNull();
    });
});
