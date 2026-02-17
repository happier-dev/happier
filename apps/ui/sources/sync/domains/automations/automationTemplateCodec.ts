import { z } from 'zod';

import type { AutomationTemplate } from './automationTypes';

const AutomationTemplateSchema = z.object({
    directory: z.string().trim().min(1),
    prompt: z.string().optional(),
    displayText: z.string().optional(),
    agent: z.string().optional(),
    profileId: z.string().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    resume: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    terminal: z.unknown().optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    experimentalCodexResume: z.boolean().optional(),
    experimentalCodexAcp: z.boolean().optional(),
    existingSessionId: z.string().optional(),
    sessionEncryptionKeyBase64: z.string().optional(),
    sessionEncryptionVariant: z.literal('dataKey').optional(),
}).strict();

function normalizeOptionalString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTemplate(template: AutomationTemplate): AutomationTemplate {
    return {
        ...template,
        directory: template.directory.trim(),
        ...(normalizeOptionalString(template.prompt) ? { prompt: normalizeOptionalString(template.prompt) } : {}),
        ...(normalizeOptionalString(template.displayText) ? { displayText: normalizeOptionalString(template.displayText) } : {}),
        ...(normalizeOptionalString(template.agent) ? { agent: normalizeOptionalString(template.agent) } : {}),
        ...(normalizeOptionalString(template.profileId) ? { profileId: normalizeOptionalString(template.profileId) } : {}),
        ...(normalizeOptionalString(template.resume) ? { resume: normalizeOptionalString(template.resume) } : {}),
        ...(normalizeOptionalString(template.permissionMode) ? { permissionMode: normalizeOptionalString(template.permissionMode) } : {}),
        ...(normalizeOptionalString(template.modelId) ? { modelId: normalizeOptionalString(template.modelId) } : {}),
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
