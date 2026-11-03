import {
    ComputerApprovalDisplayV1Schema,
    ComputerInputRequestV1Schema,
    ComputerTargetRequestV1Schema,
    ComputerTargetSelectRequestV1Schema,
    ComputerSecretFillRequestV1Schema,
    resolveComputerAccess,
    type ComputerApprovalDisplayV1,
    type ComputerInputOperationV1,
} from '@happier-dev/protocol/computer/v1';

/** Frozen owner-provided display facts, kept apart from the person's subsequent choice. */
export type ComputerActionApproval = Readonly<{
    access: 'see' | 'use';
    act: Exclude<ComputerInputOperationV1['kind'], 'element'> | 'see' | 'read' | 'share' | 'fill';
    machineId: string;
    machineName: string;
    appName?: string;
    target: ComputerApprovalDisplayV1['target'] | null;
    requiresTargetSelection: boolean;
    captureMedia: NonNullable<ComputerApprovalDisplayV1['captureMedia']> | null;
    sent: Readonly<{ kind: 'key' | 'text'; value: string }> | null;
    suggestion?: string | null;
}>;

export function isComputerApprovalAction(actionId: string): boolean {
    return actionId === 'computer.capture' || actionId === 'computer.query' || actionId === 'computer.input'
        || actionId === 'computer.target.select' || actionId === 'computer.secret.fill';
}

function readDisplay(preview: unknown): ComputerApprovalDisplayV1 | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const parsed = ComputerApprovalDisplayV1Schema.safeParse((preview as { computerApprovalDisplay?: unknown }).computerApprovalDisplay);
    return parsed.success ? parsed.data : null;
}

export function describeComputerActionApproval(input: Readonly<{ actionId: string; actionArgs: unknown; preview: unknown }>): ComputerActionApproval | null {
    if (!isComputerApprovalAction(input.actionId)) return null;
    const display = readDisplay(input.preview);
    if (!display) return null;
    const facts = {
        machineName: display.machineDisplayName,
        ...(display.appName ? { appName: display.appName } : {}),
        target: display.requiresTargetSelection ? null : display.target ?? null,
        requiresTargetSelection: display.requiresTargetSelection,
        captureMedia: display.requiresTargetSelection ? null : display.captureMedia ?? null,
    };
    if (input.actionId === 'computer.secret.fill') {
        const parsed = ComputerSecretFillRequestV1Schema.safeParse(input.actionArgs);
        if (!parsed.success || display.requiresTargetSelection || !display.target) return null;
        return { access: 'use', act: 'fill', machineId: parsed.data.machineId, ...facts, sent: null };
    }
    if (input.actionId === 'computer.target.select') {
        const parsed = ComputerTargetSelectRequestV1Schema.safeParse(input.actionArgs);
        if (!parsed.success) return null;
        return { access: resolveComputerAccess(parsed.data.access), act: 'share', machineId: parsed.data.machineId,
            ...facts, sent: null, suggestion: parsed.data.requestedTarget?.trim() || null };
    }
    if (input.actionId === 'computer.input') {
        const parsed = ComputerInputRequestV1Schema.safeParse(input.actionArgs);
        if (!parsed.success) return null;
        const operation = parsed.data.operation;
        const act = operation.kind === 'element' ? operation.action === 'click' ? 'click' : 'type' : operation.kind;
        return { access: 'use', act, machineId: parsed.data.machineId, ...facts,
            sent: operation.kind === 'type' ? { kind: 'text', value: operation.text }
                : operation.kind === 'element' && operation.action === 'set_value' ? { kind: 'text', value: operation.value }
                : operation.kind === 'press' ? { kind: 'key', value: operation.key } : null };
    }
    const parsed = ComputerTargetRequestV1Schema.safeParse(input.actionArgs);
    if (!parsed.success) return null;
    return { access: 'see', act: input.actionId === 'computer.capture' ? 'see' : 'read',
        machineId: parsed.data.machineId, ...facts, sent: null };
}

/** The owner's picker answer replaces the unchosen display, without retargeting confidential entry. */
export function applyComputerSelection(presentation: ComputerActionApproval, display: ComputerApprovalDisplayV1 | null): ComputerActionApproval {
    if (presentation.act === 'fill' || !display || display.requiresTargetSelection || !display.target) return presentation;
    return { ...presentation, machineName: display.machineDisplayName, appName: display.appName,
        ...(presentation.act === 'share' && display.access ? { access: display.access } : {}),
        target: display.target, requiresTargetSelection: false, captureMedia: display.captureMedia ?? null };
}
