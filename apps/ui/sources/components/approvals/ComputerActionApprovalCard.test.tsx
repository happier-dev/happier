import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import { renderHook, renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useComputerApprovalChoice } from './useComputerApprovalChoice';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { applyComputerSelection, ComputerActionApprovalCard, describeComputerActionApproval } from './ComputerActionApprovalCard';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

const captureMedia = {
    mediaId: 'media_1', mediaKind: 'image', width: 1280, height: 800, sizeBytes: 2048,
    file: { sessionId: 'session_1', storage: 'daemon', path: 'media/capture.png', sha256: 'a'.repeat(64), mimeType: 'image/png' },
} as const;
const shared = { machineDisplayName: 'Studio laptop', requiresTargetSelection: false, target: { kind: 'window', title: 'Sign in to Lumen' }, captureMedia };
const unchosen = { machineDisplayName: 'Studio laptop', requiresTargetSelection: true };
const typeInput = { machineId: 'machine_1', captureId: 'capture_1', operation: { kind: 'type', text: 'ana@lumen.dev' } };

describe('describeComputerActionApproval', () => {
    it.each([
        { operation: { kind: 'element', elementId: 'button', action: 'click' }, act: 'click', sent: null },
        { operation: { kind: 'element', elementId: 'field', action: 'set_value', value: 'new value' },
            act: 'type', sent: { kind: 'text', value: 'new value' } },
    ])('describes native element input as the action the person approves: $act', ({ operation, act, sent }) => {
        expect(describeComputerActionApproval({ actionId: 'computer.input',
            actionArgs: { machineId: 'machine_1', captureId: 'capture_1', operation },
            preview: { computerApprovalDisplay: shared } })).toMatchObject({ act, sent });
    });

    it.each([
        { operation: { kind: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }, label: 'browserPresence.doing.drag' },
        { operation: { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 20 }, label: 'browserPresence.doing.scroll' },
    ])('renders a localized pointer-action description: $operation.kind', async ({ operation, label }) => {
        const presentation = describeComputerActionApproval({ actionId: 'computer.input',
            actionArgs: { machineId: 'machine_1', captureId: 'capture_1', operation },
            preview: { computerApprovalDisplay: shared } });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} />);
        expect(screen.getTextContent()).toContain(label);
    });

    describe('the picture a capture produced', () => {
        const captured = { target: { kind: 'display', displayId: ':0' }, sourceId: 'computer:1', status: 'captured', captureId: 'capture_2',
            geometry: { captureWidth: 1280, captureHeight: 800, nativeWidth: 1280, nativeHeight: 800, originX: 0, originY: 0, scaleX: 1, scaleY: 1,
                crop: { x: 0, y: 0, width: 1280, height: 800 } } };
        const produced = { ...captureMedia, mediaId: 'media_2' };
        const request = { actionId: 'computer.capture', actionArgs: { machineId: 'machine_1' } };

        it('replaces the picture from before the request', () => {
            expect(describeComputerActionApproval({ ...request, preview: { computerApprovalDisplay: shared },
                result: { ...captured, media: produced } })?.captureMedia?.mediaId).toBe('media_2');
        });

        it('settles a capture that asked for a window: it no longer reads as a choice still to make', () => {
            expect(describeComputerActionApproval({ ...request, preview: { computerApprovalDisplay: unchosen },
                result: { ...captured, media: produced } })).toMatchObject({ requiresTargetSelection: false, target: { kind: 'display' },
                captureMedia: { mediaId: 'media_2' } });
            expect(describeComputerActionApproval({ ...request, preview: { computerApprovalDisplay: unchosen },
                result: { ...captured, target: { kind: 'window', displayId: ':0', pid: 7, windowId: 9 }, media: produced } }))
                .toMatchObject({ requiresTargetSelection: false, target: null, captureMedia: { mediaId: 'media_2' } });
        });

        it.each([
            ['an ephemeral frame', { ...captured, frame: { mimeType: 'image/png', base64: 'aGVsbG8=' } }],
            ['a failed capture', { target: captured.target, sourceId: 'computer:1', status: 'failed', code: 'capture_failed' }],
            ['no result yet', undefined],
        ])('keeps what the request knew for %s', (_name, result) => {
            expect(describeComputerActionApproval({ ...request, preview: { computerApprovalDisplay: shared }, result })?.captureMedia?.mediaId).toBe('media_1');
        });

        it('reads a produced picture only from a capture', () => {
            expect(describeComputerActionApproval({ actionId: 'computer.query', actionArgs: { machineId: 'machine_1' },
                preview: { computerApprovalDisplay: shared }, result: { ...captured, media: produced } })?.captureMedia?.mediaId).toBe('media_1');
        });

        it('shows a window whose title the request never knew under the machine line', async () => {
            const presentation = describeComputerActionApproval({ ...request, preview: { computerApprovalDisplay: unchosen },
                result: { ...captured, target: { kind: 'window', displayId: ':0', pid: 7, windowId: 9 }, media: produced } });
            const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} media={<Text testID="picture">picture</Text>} />);
            expect(screen.findByTestId('picture')).not.toBeNull();
            expect(screen.getTextContent()).toContain('computerUse.approval.windowOn');
            expect(screen.getTextContent()).not.toContain('computerUse.approval.chooseFirst');
        });
    });

    it('describes omitted selection access by the request default rather than the previous share', () => {
        expect(describeComputerActionApproval({
            actionId: 'computer.target.select',
            actionArgs: { machineId: 'machine_1', requestedTarget: 'Editor' },
            preview: { computerApprovalDisplay: { ...shared, access: 'see' } },
        })).toMatchObject({ access: 'use', act: 'share' });
    });

    it('shows the saved see-only decision after reloading without changing the original input', async () => {
        const actionArgs = { machineId: 'machine_1', requestedTarget: 'Lumen', access: 'use' };
        const hook = await renderHook(() => useComputerApprovalChoice({
            actionId: 'computer.target.select', actionArgs,
            approvedInput: { ...actionArgs, access: 'see' },
            preview: { computerApprovalDisplay: unchosen }, sessionId: 'session_1',
            accountLifetime: null, resolveOpenPicker: () => () => {},
        }));
        expect(hook.getCurrent().presentation?.access).toBe('see');
        expect(hook.getCurrent().decisionOptions).toEqual({});
        expect(actionArgs.access).toBe('use');
    });
    it('shows confidential entry against the owner-reviewed window without displaying or retargeting a credential', async () => {
        const args = { serverId: 'home-1', sessionId: 'session_1', machineId: 'machine_1', purpose: 'Sign in',
            sourceId: 'source-1', target: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 }, captureId: 'capture-1',
            geometry: { captureWidth: 1280, captureHeight: 800, nativeWidth: 1280, nativeHeight: 800,
                originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 1280, height: 800 } },
            field: { fieldId: 'password', focusId: 'focus-1' } };
        const presentation = describeComputerActionApproval({ actionId: 'computer.secret.fill', actionArgs: args,
            preview: { computerApprovalDisplay: shared } });
        expect(presentation).toMatchObject({ access: 'use', act: 'fill', machineName: 'Studio laptop',
            target: shared.target, requiresTargetSelection: false, sent: null });
        expect(applyComputerSelection(presentation!, { ...shared, target: { kind: 'window', title: 'Another window' } })).toBe(presentation);
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} onChooseTarget={() => {}} testID="c" />);
        expect(screen.getTextContent()).toContain('Sign in to Lumen');
        expect(screen.findByTestId('c-choose')).toBeNull();
        expect(screen.getTextContent()).not.toContain(':77');
    });

    it('retains the human’s see-only choice and owner app name when approving a suggested target', async () => {
        // Public caller input: this test exercises the picker choice, not the
        // Account lifetime producer (the confidential owner suite keeps it real).
        const accountLifetime: ServerAccountScopeLifetime = { scope: { serverId: 'home-1', accountId: 'account-a' },
            isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) };
        let pickerInput: Parameters<typeof import('@/components/computer/openComputerTargetPickerForSession').openComputerTargetPickerForSession>[0] | undefined;
        const hook = await renderHook(() => useComputerApprovalChoice({
            actionId: 'computer.target.select', actionArgs: { machineId: 'machine_1', requestedTarget: 'Lumen' },
            preview: { computerApprovalDisplay: unchosen }, sessionId: 'session_1',
            accountLifetime,
            resolveOpenPicker: () => (params) => { pickerInput = params; },
        }));
        await act(async () => { hook.getCurrent().chooseTarget(); });
        const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
        await act(async () => { pickerInput?.onChosen?.({ target, title: 'Sign in to Lumen', appName: 'Lumen' }, 'see'); });
        expect(hook.getCurrent().decisionOptions).toEqual({ narrowedInput: {
            machineId: 'machine_1', requestedTarget: 'Lumen', target, access: 'see',
        } });
        expect(hook.getCurrent().presentation).toMatchObject({ access: 'see', appName: 'Lumen', requiresTargetSelection: false });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={hook.getCurrent().presentation!} />);
        expect(screen.getTextContent()).toContain('computerUse.approval.seeConsequence');
        expect(screen.getTextContent()).not.toContain('computerUse.picker.description');
    });

    it('reads where it lands from the computer owner’s display facts, never from the agent’s arguments', () => {
        expect(describeComputerActionApproval({
            actionId: 'computer.input', actionArgs: typeInput, preview: { computerApprovalDisplay: shared },
        })).toEqual({
            access: 'use', act: 'type', machineId: 'machine_1', machineName: 'Studio laptop',
            target: { kind: 'window', title: 'Sign in to Lumen' }, requiresTargetSelection: false, captureMedia,
            sent: { kind: 'text', value: 'ana@lumen.dev' },
        });
    });

    it('asks for the window first when none is shared yet, and keeps seeing distinct from using', () => {
        expect(describeComputerActionApproval({
            actionId: 'computer.capture', actionArgs: { machineId: 'machine_1' }, preview: { computerApprovalDisplay: unchosen },
        })).toEqual({
            access: 'see', act: 'see', machineId: 'machine_1', machineName: 'Studio laptop',
            target: null, requiresTargetSelection: true, captureMedia: null, sent: null,
        });
    });

    it('shows an agent’s window choice as a suggestion the person confirms, never as a chosen window', () => {
        expect(describeComputerActionApproval({
            actionId: 'computer.target.select',
            actionArgs: { machineId: 'machine_1', requestedTarget: 'Safari' },
            preview: { computerApprovalDisplay: unchosen },
        })).toEqual({
            access: 'use', act: 'share', machineId: 'machine_1', machineName: 'Studio laptop',
            target: null, requiresTargetSelection: true, captureMedia: null, sent: null, suggestion: 'Safari',
        });
    });

    it('describes nothing it cannot read', () => {
        // No owner display facts (a request from before the computer owner resolved them).
        expect(describeComputerActionApproval({ actionId: 'computer.input', actionArgs: typeInput, preview: {} })).toBeNull();
        // Input without the capture it refers to; forged authority labels; another family.
        expect(describeComputerActionApproval({
            actionId: 'computer.input', actionArgs: { machineId: 'machine_1', operation: { kind: 'click', x: 1, y: 1 } },
            preview: { computerApprovalDisplay: shared },
        })).toBeNull();
        expect(describeComputerActionApproval({
            actionId: 'computer.capture', actionArgs: { machineId: 'machine_1', sessionId: 'forged' }, preview: { computerApprovalDisplay: shared },
        })).toBeNull();
        expect(describeComputerActionApproval({ actionId: 'browser.navigate', actionArgs: {}, preview: {} })).toBeNull();
    });
});

describe('ComputerActionApprovalCard', () => {
    it('names the window and the machine, shows the exact text, and never a native id', async () => {
        const presentation = describeComputerActionApproval({
            actionId: 'computer.input',
            actionArgs: { ...typeInput, target: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } },
            preview: { computerApprovalDisplay: shared },
        });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} testID="c" />);
        const text = screen.getTextContent();
        expect(text).toContain('computerUse.approval.act.type');
        expect(text).toContain('computerUse.approval.targetOn');
        expect(text).toContain('Sign in to Lumen');
        expect(text).toContain('Studio laptop');
        expect(text).toContain('ana@lumen.dev');
        expect(text).not.toContain('456');
        expect(text).not.toContain(':77');
    });

    it('reads a display as the screen of its Machine and asks one act line, never the display id', async () => {
        const presentation = describeComputerActionApproval({
            actionId: 'computer.input',
            actionArgs: { machineId: 'machine_1', captureId: 'capture_1', operation: { kind: 'click', x: 640, y: 400 } },
            preview: { computerApprovalDisplay: { ...shared, target: { kind: 'display', title: 'primary' } } },
        });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} testID="c" />);
        const text = screen.getTextContent();
        expect(text).toContain('computerUse.approval.actOnScreen');
        expect(text).toContain('computerUse.approval.screenOf');
        expect(text).not.toContain('primary');
        expect(text).not.toContain('640');
    });

    it('starts at where when its host already asks the act line', async () => {
        const presentation = describeComputerActionApproval({
            actionId: 'computer.input', actionArgs: { machineId: 'machine_1', captureId: 'capture_1', operation: { kind: 'click', x: 1, y: 2 } },
            preview: { computerApprovalDisplay: shared },
        });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} titled testID="c" />);
        const text = screen.getTextContent();
        expect(text).not.toContain('computerUse.approval.actIn');
        expect(text).not.toContain('computerUse.approval.act.click');
        expect(text).toContain('computerUse.approval.targetOn');
    });

    it('leads with choosing the window when none is shared', async () => {
        const onChoose = vi.fn();
        const presentation = describeComputerActionApproval({
            actionId: 'computer.capture', actionArgs: { machineId: 'machine_1' }, preview: { computerApprovalDisplay: unchosen },
        });
        const screen = await renderScreen(<ComputerActionApprovalCard presentation={presentation!} onChooseTarget={onChoose} testID="c" />);
        expect(screen.getTextContent()).toContain('computerUse.approval.chooseFirst');
        await screen.pressByTestIdAsync('c-choose');
        expect(onChoose).toHaveBeenCalledTimes(1);
    });
});
