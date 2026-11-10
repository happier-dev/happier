import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AcpConfigOptionOverridesV1Schema, normalizeCodexBackendMode } from '../sessions/metadata/metadataOverridesV1.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { BackendTargetRefV2Schema, normalizeBackendTargetRefV2InputToV2 } from '../backends/targets/backendTargetRefV2.js';
import { RuntimeDescriptorV1Schema, readRuntimeDescriptorV1 } from '../sessions/metadata/runtimeDescriptorV1.js';
import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../sessions/authoring/creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from '../sessions/creation/sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import { readCapabilitySelectionCarrierV1, SessionCapabilitySelectionAuthoringV1Schema } from '../reach/sessionCapabilitySelectionV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../sessions/metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../sessions/metadata/windowsTerminalWindowName.js';

/** The released Account Automation payload codec; hosts add execution-boundary validation. */
export const AutomationTemplatePayloadV1Schema = lazyZodSchema(() => z.strictObject({
    executionTarget: z.optional(SessionExecutionTargetV1Schema),
    directory: z.string().check(z.trim(), z.minLength(1)),
    checkoutCreationDraft: z.optional(SessionAuthoringCheckoutCreationDraftV1Schema),
    organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
    prompt: z.optional(z.string()),
    displayText: z.optional(z.string()),
    agent: z.optional(z.string()),
    agentTarget: z.optional(AgentExecutionTargetV1Schema),
    backendTarget: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), BackendTargetRefV2Schema)),
    connectedServices: z.optional(z.unknown()),
    transcriptStorage: z.optional(z.enum(['persisted', 'direct'])),
    profileId: z.optional(z.string()),
    environmentVariables: z.optional(z.record(z.string(), z.string())),
    resume: z.optional(z.string()),
    permissionMode: z.optional(z.string()),
    permissionModeUpdatedAt: z.optional(z.number().check(z.int())),
    modelSelection: z.optional(z.nullable(SessionModelSelectionV1Schema)),
    modelId: z.optional(z.string()),
    modelUpdatedAt: z.optional(z.number().check(z.int())),
    sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
    capabilitySelection: z.optional(SessionCapabilitySelectionAuthoringV1Schema),
    terminal: z.optional(z.unknown()),
    windowsRemoteSessionLaunchMode: z.optional(WindowsRemoteSessionLaunchModeSchema),
    windowsRemoteSessionConsole: z.optional(z.enum(['hidden', 'visible'])),
    windowsTerminalWindowName: z.optional(WindowsTerminalWindowNameSchema),
    runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
    /**
     * Released remote-dev V2 account-template ingress only. Current writers
     * use runtimeDescriptorV1. Remove when those stored templates are no longer
     * a supported input to the Automation editor.
     */
    experimentalCodexAcp: z.optional(z.boolean()),
    /** Same released remote-dev V2 account-template ingress as above. */
    codexBackendMode: z.optional(z.enum(['mcp', 'acp', 'appServer'])),
    agentModeId: z.optional(z.string()),
    existingSessionId: z.optional(z.string()),
    sessionEncryptionMode: z.optional(z.enum(['e2ee', 'plain'])),
    sessionEncryptionKeyBase64: z.optional(z.string()),
    sessionEncryptionVariant: z.optional(z.literal('dataKey')),
}));
export type AutomationTemplatePayloadV1 = z.infer<typeof AutomationTemplatePayloadV1Schema>;
type AutomationTemplate = AutomationTemplatePayloadV1;

const AutomationTemplateSchema = lazyZodSchema(() => z.pipe(AutomationTemplatePayloadV1Schema, z.transform(({ experimentalCodexAcp: _experimentalCodexAcp, codexBackendMode, ...template }) => {
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
})));

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
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const { mcpSelection, ...canonical } = parsed as Record<string, unknown>;
        const capabilitySelection = readCapabilitySelectionCarrierV1(parsed);
        return createStoredReadSchema(AutomationTemplateSchema).parse({
            ...canonical,
            ...(capabilitySelection ? { capabilitySelection } : canonical.capabilitySelection === undefined && mcpSelection != null
                ? { capabilitySelection: { mcp: mcpSelection } } : {}),
        });
    } catch {
        return null;
    }
}
