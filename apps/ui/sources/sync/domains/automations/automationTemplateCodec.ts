import { z } from 'zod';
import {
    AcpConfigOptionOverridesV1Schema,
    AgentExecutionTargetV1Schema,
    BackendTargetRefV2Schema,
    normalizeCodexBackendMode,
    readRuntimeDescriptorV1,
    RuntimeDescriptorV1Schema,
    SessionAuthoringCheckoutCreationDraftV1Schema,
    SessionExecutionTargetV1Schema,
    SessionOrganizationPlacementV1Schema,
    SessionModelSelectionV1Schema,
    SessionMcpSelectionV1Schema,
    WindowsRemoteSessionLaunchModeSchema,
    WindowsTerminalWindowNameSchema,
} from '@happier-dev/protocol';

import type { AutomationTemplate } from './automationTypes';

const AutomationTemplateSchema: z.ZodType<AutomationTemplate> = z.object({
    executionTarget: SessionExecutionTargetV1Schema.optional(),
    directory: z.string().trim().min(1),
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1Schema.optional(),
    organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
    prompt: z.string().optional(),
    displayText: z.string().optional(),
    agent: z.string().optional(),
    agentTarget: AgentExecutionTargetV1Schema.optional(),
    backendTarget: BackendTargetRefV2Schema.optional(),
    connectedServices: z.unknown().optional(),
    transcriptStorage: z.enum(['persisted', 'direct']).optional(),
    profileId: z.string().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    resume: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    modelSelection: SessionModelSelectionV1Schema.nullable().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    terminal: z.unknown().optional(),
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    windowsTerminalWindowName: WindowsTerminalWindowNameSchema.optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    /**
     * Released remote-dev V2 account-template ingress only. Current writers
     * use runtimeDescriptorV1. Remove when those stored templates are no longer
     * a supported input to the Automation editor.
     */
    experimentalCodexAcp: z.boolean().optional(),
    /** Same released remote-dev V2 account-template ingress as above. */
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
    agentModeId: z.string().optional(),
    existingSessionId: z.string().optional(),
    sessionEncryptionMode: z.enum(['e2ee', 'plain']).optional(),
    sessionEncryptionKeyBase64: z.string().optional(),
    sessionEncryptionVariant: z.literal('dataKey').optional(),
}).strict().transform(({ experimentalCodexAcp: _experimentalCodexAcp, codexBackendMode, ...template }) => {
    const normalizedCodexBackendMode = normalizeCodexBackendMode(codexBackendMode);
    const legacyRuntimeDescriptorV1 = normalizedCodexBackendMode || _experimentalCodexAcp === true
        ? readRuntimeDescriptorV1({
            v: 1,
            agentId: 'codex',
            agent: { backendMode: normalizedCodexBackendMode ?? 'acp' },
        }) ?? undefined
        : undefined;
    if (template.runtimeDescriptorV1 && legacyRuntimeDescriptorV1 && (
        template.runtimeDescriptorV1.agentId !== 'codex'
        || normalizeCodexBackendMode(template.runtimeDescriptorV1.agent.backendMode)
            !== normalizeCodexBackendMode(legacyRuntimeDescriptorV1.agent.backendMode)
    )) {
        throw new Error('Conflicting legacy Codex runtime selection');
    }
    return {
        ...template,
        ...(template.runtimeDescriptorV1 ?? legacyRuntimeDescriptorV1
            ? { runtimeDescriptorV1: template.runtimeDescriptorV1 ?? legacyRuntimeDescriptorV1 }
            : {}),
    };
});

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTemplate(template: AutomationTemplate): AutomationTemplate {
    const {
        modelId: legacyModelId,
        modelUpdatedAt: legacyModelUpdatedAt,
        ...canonicalTemplate
    } = template;
    return {
        ...canonicalTemplate,
        directory: template.directory.trim(),
        ...(template.checkoutCreationDraft
            ? {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: template.checkoutCreationDraft.displayName.trim(),
                    baseRef: normalizeOptionalString(template.checkoutCreationDraft.baseRef) ?? null,
                    // Omission stays omitted: the checkout materialization owner
                    // applies the single canonical branch-mode default.
                    ...(template.checkoutCreationDraft.branchMode
                        ? { branchMode: template.checkoutCreationDraft.branchMode }
                        : {}),
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
        ...(template.modelSelection === undefined && normalizeOptionalString(legacyModelId)
            ? {
                modelId: normalizeOptionalString(legacyModelId),
                ...(typeof legacyModelUpdatedAt === 'number' ? { modelUpdatedAt: legacyModelUpdatedAt } : {}),
            }
            : {}),
        ...(template.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: template.sessionConfigOptionOverrides } : {}),
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
