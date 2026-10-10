import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createSessionAgentActivityRowForTest, installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

const paints = new Map<string, number>();
installSessionSubagentCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: ({ children, ...props }: React.PropsWithChildren<{ testID?: string }>) => {
        if (props.testID?.startsWith('session-subagent-summary:')) paints.set(props.testID, (paints.get(props.testID) ?? 0) + 1);
        return React.createElement('View', props, children);
    } });
} });
const { SessionSubagentGroup } = await import('./SessionSubagentGroup');

describe('real subagent group stability', () => {
    it('keeps unchanged row callbacks and summary paints local when a sibling changes', async () => {
        const agent = (id: string): SessionSubagent => ({ id, kind: 'execution_run', status: 'running', display: { title: id },
            transcript: {}, recipient: { kind: 'execution_run', runId: id, label: id },
            runRef: { runId: id, backendId: 'codex', intent: 'review' }, timestamps: {},
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: false } });
        const a = createSessionAgentActivityRowForTest(agent('a'));
        const b = createSessionAgentActivityRowForTest(agent('b'));
        const actions = { onOpenPreview: vi.fn(), onOpenFull: vi.fn(), onOpenAdvanced: vi.fn() };
        const draw = (rows: readonly typeof a[]) => <SessionSubagentGroup sessionId="session" label={null} rows={rows}
            activityPreviewById={new Map()} {...actions} />;
        const screen = await renderScreen(draw([a, b]));
        const before = paints.get('session-subagent-summary:a');
        expect(before).toBeGreaterThan(0);
        const changed = createSessionAgentActivityRowForTest({ ...b.subagent, display: { ...b.subagent.display, title: 'Updated B' } }, { ...b.entry, title: 'Updated B' });
        await act(async () => screen.tree.update(draw([{ ...a }, changed])));
        expect(paints.get('session-subagent-summary:a')).toBe(before);
        expect(screen.getTextContent()).toContain('Updated B');
        await screen.pressByTestIdAsync('session-subagent-row:a');
        expect(actions.onOpenPreview).toHaveBeenCalledWith(a.subagent);
    });
});
