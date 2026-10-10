import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

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
        expect(hook.getCurrent().decisionOptions).toEqual({ computerTarget: target, computerAccess: 'see' });
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
