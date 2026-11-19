import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ToolCallDetailsSections } from './ToolCallDetailsSections';

afterEach(standardCleanup);

it('shows the applied retention period and hides an outdated result body', async () => {
    const tool = {
        name: 'unrecognized-tool', state: 'completed', input: { query: 'example input' }, description: null,
        createdAt: 1, startedAt: 1, completedAt: 2, result: 'outdated result body',
        toolOutputAvailability: { status: 'expired', days: 30 },
    } satisfies ToolCall;
    const screen = await renderScreen(<ToolCallDetailsSections tool={tool} />);
    expect(screen.findAllByTestId('tool-details-result-expired').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('Output expired after 30 days');
    expect(screen.getTextContent()).toContain('example input');
    expect(screen.getTextContent()).not.toContain('outdated result body');
    await screen.unmount();
});

it.each(['cancelled', 'interrupted', 'failed'] as const)('shows error details only for a real failure (%s)', async (status) => {
    const tool: ToolCall = { name: 'unrecognized-tool', state: 'error', input: {}, description: null,
        createdAt: 1, startedAt: 1, completedAt: 2, result: { status, error: 'Turn ended' } };
    const screen = await renderScreen(<ToolCallDetailsSections tool={tool} />);
    const errors = screen.findAllByTestId('tool-details-error');
    if (status === 'failed') expect(errors.length).toBeGreaterThan(0);
    else expect(errors).toHaveLength(0);
});

it.each([
    { source: { kind: 'artifact', serverId: 'home', artifactId: '80f7dabe-1f05-44b7-8e44-d98f2127f523' },
        expectedVersion: '1.0.10', creation: { directory: { kind: 'path', path: '~' } }, name: 'Coffee' },
    {},
])('keeps a completed approval handoff readable without new approval advice (%j)', async input => {
    const tool: ToolCall = {
        name: 'mcp__happier__action_execute', state: 'completed',
        input: { actionId: 'template.instantiate', input },
        createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        result: { content: [{ type: 'text', text: JSON.stringify({
            kind: 'approval_request_created', artifactId: '80f7dabe-1f05-44b7-8e44-d98f2127f523',
            actionId: 'template.instantiate',
        }) }], structuredContent: null },
    };
    const screen = await renderScreen(<ToolCallDetailsSections tool={tool} />);
    expect(screen.findAllByTestId('approvals.unrepresentable-details')).toHaveLength(0);
    expect(screen.getTextContent()).not.toContain('approvals.unsafeDetailsBody');
    expect(screen.findAllByTestId('tool-details-approval-request').length).toBeGreaterThan(0);
    if ('creation' in input) expect(screen.getTextContent()).toContain('~');
    await screen.unmount();
});

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

// SEE-B 11-17: a refused Agent Copy (stale `creation` shape) is history; it has nothing left to approve or deny.
it('shows a refused call its input as sent, without advice to deny or resend it', async () => {
    const refusal = JSON.stringify({ errorCode: 'invalid_parameters', error: 'invalid_parameters',
        details: { issues: [{ code: 'unrecognized_keys', path: ['creation'], message: 'Unrecognized input fields' }] } });
    const tool: ToolCall = {
        name: 'mcp__happier__action_execute', state: 'error',
        // The live Muse call (SEE-B 11-17): its input arrived as a JSON string, with `name` misplaced inside `creation`.
        input: { actionId: 'template.instantiate', input: JSON.stringify({ creation: { directory: { kind: 'path', path: '~' },
            name: 'Coffee copy' }, expectedVersion: '1.0.10', source: { artifactId: '00749bf1-5af6-4820-b331-618adcd7ac55',
            kind: 'artifact', serverId: 'home' } }) },
        createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        result: { text: `tool failed: ${refusal}`, status: 'failed', failureReason: refusal },
    };
    const screen = await renderScreen(<ToolCallDetailsSections tool={tool} />);
    expect(screen.findAllByTestId('approvals.unrepresentable-details')).toHaveLength(0);
    expect(screen.getTextContent()).not.toContain('approvals.unsafeDetailsBody');
    expect(screen.getTextContent()).toContain('Coffee copy');
    await screen.unmount();
});
