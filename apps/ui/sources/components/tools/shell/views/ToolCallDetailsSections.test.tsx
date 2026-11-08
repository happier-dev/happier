import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ToolCallDetailsSections } from './ToolCallDetailsSections';

afterEach(standardCleanup);

it.each([
    { source: { kind: 'artifact', serverId: 'home', artifactId: '80f7dabe-1f05-44b7-8e44-d98f2127f523' },
        expectedVersion: '1.0.10', creation: { directory: { kind: 'path', path: '~' } }, name: 'Coffee' },
    {},
])('shows a completed Copy refusal as history without approval instructions (%j)', async input => {
    const tool: ToolCall = {
        name: 'mcp__happier__action_execute', state: 'completed',
        input: { actionId: 'template.instantiate', input },
        createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        result: { ok: false, errorCode: 'invalid_request', error: 'invalid_request' },
    };
    const screen = await renderScreen(<ToolCallDetailsSections tool={tool} />);
    expect(screen.findAllByTestId('tool-details-failure-reason').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('approvals.unrepresentable-details')).toHaveLength(0);
    expect(screen.findAllByTestId('tool-details-approval-request')).toHaveLength(0);
    await screen.unmount();
});
