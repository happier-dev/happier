import { describe, expect, it } from 'vitest';

import { resolveTranscriptComputerActionReference } from './transcriptComputerActionReference';

const display = { machineDisplayName: 'Studio laptop', requiresTargetSelection: true };
const target = { kind: 'window', displayId: ':77', pid: 1, windowId: 2 } as const;
const media = {
    mediaId: 'm1', mediaKind: 'image', width: 1280, height: 800, sizeBytes: 10,
    file: { sessionId: 'session_1', storage: 'daemon', path: 'media/c.png', sha256: 'a'.repeat(64), mimeType: 'image/png' },
} as const;
const geometry = { captureWidth: 1280, captureHeight: 800, nativeWidth: 1280, nativeHeight: 800, originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 1280, height: 800 } };

function call(actionId: string, input: unknown, result: unknown, state = 'completed') {
    // Runtime Actions reach agents through the generic first-party `action_execute` tool.
    return resolveTranscriptComputerActionReference({
        toolName: 'mcp__happier__action_execute', state, input: { actionId, input }, result: result === undefined ? undefined : JSON.stringify(result),
    });
}

describe('resolveTranscriptComputerActionReference', () => {
    it.each([
        { operation: { kind: 'element', elementId: 'button', action: 'click' }, verb: 'click' },
        { operation: { kind: 'element', elementId: 'field', action: 'set_value', value: 'private-value' }, verb: 'type' },
    ])('narrates native element input as $verb without carrying its value', ({ operation, verb }) => {
        const reference = call('computer.input', { machineId: 'machine_1', captureId: 'c', operation },
            { status: 'dispatched', target, sourceId: 's', targetLabel: 'Native control' });
        expect(reference).toMatchObject({ verb, targetLabel: 'Native control', outcome: 'done' });
        expect(JSON.stringify(reference)).not.toContain('private-value');
    });

    it('uses the native owner’s clicked or focused label, excluding typed values from narration', () => {
        const clicked = call('computer.input', { machineId: 'machine_1', captureId: 'c', operation: { kind: 'click', x: 1, y: 1 } },
            { status: 'dispatched', target, sourceId: 's', targetLabel: 'Sign in' });
        expect(clicked).toMatchObject({ verb: 'click', targetLabel: 'Sign in' });
        const typed = call('computer.input', { machineId: 'machine_1', captureId: 'c', operation: { kind: 'type', text: 'private-value' } },
            { status: 'dispatched', target, sourceId: 's', targetLabel: 'Email address' });
        expect(typed).toMatchObject({ verb: 'type', targetLabel: 'Email address' });
        expect(JSON.stringify(typed)).not.toContain('private-value');
    });

    it('turns an agent’s “choose a window first” result into the person’s choice, with the machine by name', () => {
        // The MCP text block the Happier tool surface records (`JSON.stringify(result)`).
        const result = { content: [{ type: 'text', text: JSON.stringify({ status: 'target_selection_required', approvalDisplay: display }) }] };
        expect(resolveTranscriptComputerActionReference({
            toolName: 'mcp__happier__action_execute', state: 'completed',
            input: { actionId: 'computer.capture', input: { machineId: 'machine_1' } }, result,
        })).toMatchObject({ actionId: 'computer.capture', machineId: 'machine_1', kind: 'choose', machineName: 'Studio laptop' });
    });

    it('says what the agent did on the shared window, with the screenshot it took, and never what it typed', () => {
        expect(call('computer.capture', { machineId: 'machine_1' }, { status: 'captured', target, sourceId: 's', captureId: 'c', geometry, media }))
            .toMatchObject({ kind: 'action', verb: 'capture', running: false, outcome: 'done', media });
        expect(call('computer.input', { machineId: 'machine_1', captureId: 'c', operation: { kind: 'click', x: 1, y: 1 } },
            { status: 'dispatched', target, sourceId: 's' })).toMatchObject({ kind: 'action', verb: 'click', outcome: 'done', watch: true });
        const typing = call('computer.input', { machineId: 'machine_1', captureId: 'c', operation: { kind: 'type', text: 'hunter2' } }, undefined, 'running');
        expect(typing).toMatchObject({ kind: 'action', verb: 'type', running: true });
        expect(JSON.stringify(typing)).not.toContain('hunter2');
        expect(call('computer.input', { machineId: 'machine_1', captureId: 'c', operation: { kind: 'press', key: 'Return' } },
            { status: 'interrupted', completion: 'unknown', target, sourceId: 's' })).toMatchObject({ verb: 'press', key: 'Return', outcome: 'mayHaveLanded' });
    });

    it('reads nothing from another server’s tool', () => {
        expect(resolveTranscriptComputerActionReference({
            toolName: 'mcp__othervendor__action_execute', state: 'completed', input: { actionId: 'computer.capture', input: { machineId: 'machine_1' } },
            result: JSON.stringify({ status: 'target_selection_required', approvalDisplay: display }),
        })).toBeNull();
    });
});
