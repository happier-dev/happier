import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@happier-dev/session-core/messages';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { describeBrowserAction, readBrowserCallOutcome } from './browserActionPhrase';
import { resolveTranscriptBrowserActionReference } from './transcriptBrowserActionReference';

const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } as const;

function openCall(state: ToolCall['state'], result: unknown = null): ToolCall {
    return {
        name: 'mcp__happier__action_execute',
        state,
        input: { actionId: 'browser.view.open', input: { ...view,
            target: { kind: 'externalUrl', targetId: 'agent-target', url: 'https://en.wikipedia.org/wiki/Checkout' } } },
        createdAt: 1,
        startedAt: 1,
        completedAt: state === 'running' ? null : 2,
        description: null,
        result,
    };
}

function say(tool: ToolCall): string {
    const reference = resolveTranscriptBrowserActionReference({ toolName: tool.name, state: tool.state, input: tool.input, result: tool.result });
    if (!reference) throw new Error('expected a browser reference');
    return describeBrowserAction(reference, readBrowserCallOutcome(tool));
}

const asked = 'browserTool.present.opened:{"page":"en.wikipedia.org/wiki/Checkout"}';
const failed = `approvals.failureNamed:${JSON.stringify({ action: asked })}`;

describe('browser tool row phrase', () => {
    it('asks in the present while the call runs, and while it waits for a person to approve it', () => {
        expect(say(openCall('running'))).toBe(asked);
        expect(say(openCall('completed', { ok: true, result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'browser.view.open' } })))
            .toBe(asked);
    });

    it('says the call could not finish when it failed, whether the call or its result carries the failure', () => {
        expect(readBrowserCallOutcome(openCall('error'))).toBe('failed');
        expect(say(openCall('error'))).toBe(failed);
        expect(say(openCall('completed', { ok: false, error: { code: 'browser_view_unavailable', message: 'unavailable' } }))).toBe(failed);
    });

    it('tells the outcome in the past once the call completed', () => {
        expect(say(openCall('completed', { ok: true, result: { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } })))
            .toBe('browserTool.opened:{"page":"en.wikipedia.org/wiki/Checkout"}');
    });
});
