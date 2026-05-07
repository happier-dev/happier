import { z } from 'zod';
import {
    BackendTargetRefSchema,
    SessionMcpSelectionV1Schema,
    WindowsRemoteSessionLaunchModeSchema,
    WindowsTerminalWindowNameSchema,
} from '@happier-dev/protocol';

import type { AutomationTemplate } from './automationTypes';

type AutomationTemplateCheckoutCreationDraft = NonNullable<AutomationTemplate['checkoutCreationDraft']>;

function normalizeCheckoutCreationDraft(value: {
    kind: 'git_worktree';
    displayName: string;
    baseRef?: string | null;
    branchMode?: 'new' | 'existing';
}): AutomationTemplateCheckoutCreationDraft {
    return {
        kind: value.kind,
        displayName: value.displayName.trim(),
        baseRef: typeof value.baseRef === 'string' ? value.baseRef.trim() : null,
        branchMode: value.branchMode === 'existing' ? 'existing' : 'new',
    };
}

const CheckoutCreationDraftSchema: z.ZodType<AutomationTemplateCheckoutCreationDraft> = z.object({
    kind: z.literal('git_worktree'),
    displayName: z.string().trim().min(1),
    baseRef: z.string().trim().min(1).nullable().optional(),
    branchMode: z.enum(['new', 'existing']).optional(),
}).strict().transform(normalizeCheckoutCreationDraft);

const AutomationTemplateSchema: z.ZodType<AutomationTemplate> = z.object({
    directory: z.string().trim().min(1),
    checkoutCreationDraft: CheckoutCreationDraftSchema.optional(),
    prompt: z.string().optional(),
    displayText: z.string().optional(),
    agent: z.string().optional(),
    backendTarget: BackendTargetRefSchema.optional(),
    connectedServices: z.unknown().optional(),
    transcriptStorage: z.enum(['persisted', 'direct']).optional(),
    profileId: z.string().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    resume: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    terminal: z.unknown().optional(),
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    windowsTerminalWindowName: WindowsTerminalWindowNameSchema.optional(),
    experimentalCodexAcp: z.boolean().optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
    agentModeId: z.string().optional(),
    existingSessionId: z.string().optional(),
    sessionEncryptionMode: z.enum(['e2ee', 'plain']).optional(),
    sessionEncryptionKeyBase64: z.string().optional(),
    sessionEncryptionVariant: z.literal('dataKey').optional(),
}).strict().transform(({ experimentalCodexAcp: _experimentalCodexAcp, codexBackendMode, ...template }) => ({
    ...template,
    ...(codexBackendMode ? { codexBackendMode } : _experimentalCodexAcp === true ? { codexBackendMode: 'acp' as const } : {}),
}));

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTemplate(template: AutomationTemplate): AutomationTemplate {
    return {
        ...template,
        directory: template.directory.trim(),
        ...(template.checkoutCreationDraft
            ? {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: template.checkoutCreationDraft.displayName.trim(),
                    baseRef: normalizeOptionalString(template.checkoutCreationDraft.baseRef) ?? null,
                    branchMode: template.checkoutCreationDraft.branchMode === 'existing' ? 'existing' : 'new',
                },
            }
            : {}),
        ...(normalizeOptionalString(template.prompt) ? { prompt: normalizeOptionalString(template.prompt) } : {}),
        ...(normalizeOptionalString(template.displayText) ? { displayText: normalizeOptionalString(template.displayText) } : {}),
        ...(normalizeOptionalString(template.agent) ? { agent: normalizeOptionalString(template.agent) } : {}),
        ...(template.backendTarget ? { backendTarget: template.backendTarget } : {}),
        ...(normalizeOptionalString(template.profileId) ? { profileId: normalizeOptionalString(template.profileId) } : {}),
        ...(normalizeOptionalString(template.resume) ? { resume: normalizeOptionalString(template.resume) } : {}),
        ...(normalizeOptionalString(template.permissionMode) ? { permissionMode: normalizeOptionalString(template.permissionMode) } : {}),
        ...(normalizeOptionalString(template.modelId) ? { modelId: normalizeOptionalString(template.modelId) } : {}),
        ...(normalizeOptionalString(template.agentModeId) ? { agentModeId: normalizeOptionalString(template.agentModeId) } : {}),
        ...(normalizeOptionalString(template.existingSessionId)
            ? { existingSessionId: normalizeOptionalString(template.existingSessionId) }
            : {}),
        ...(normalizeOptionalString(template.sessionEncryptionKeyBase64)
            ? { sessionEncryptionKeyBase64: normalizeOptionalString(template.sessionEncryptionKeyBase64) }
            : {}),
    };
}

export function encodeAutomationTemplate(template: AutomationTemplate): string {
    const normalized = normalizeTemplate(template);
    const parsed = AutomationTemplateSchema.parse(normalized);
    return JSON.stringify(parsed);
}

export function decodeAutomationTemplate(payload: string): AutomationTemplate | null {
    if (typeof payload !== 'string') return null;
    const trimmed = payload.trim();
    if (trimmed.length === 0) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return AutomationTemplateSchema.parse(parsed);
    } catch {
        return null;
    }
}
