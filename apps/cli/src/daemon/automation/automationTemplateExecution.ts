import { z } from 'zod';
import {
  AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS,
  AutomationTemplatePayloadV1Schema,
  openAutomationTemplateStoredV1,
  readAutomationTemplateStoredEnvelopeV1,
  type SessionAuthoringCheckoutCreationDraftV1,
  type AutomationTemplateRetainedSessionV1,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import {
  SpawnSessionPermissionModeSchema,
  SpawnSessionTerminalSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from '@/rpc/handlers/spawnRuntimeSelection';

const TemplateSchema = AutomationTemplatePayloadV1Schema.omit({
  executionTarget: true, agentTarget: true, organizationPlacement: true,
}).extend({
  agent: z.string().trim().min(1).optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  terminal: SpawnSessionTerminalSchema.optional(),
});

export type AutomationTemplateEncryption =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export type AutomationTemplateExecutionInput = Readonly<{
  targetType: 'new_session' | 'existing_session';
  templateCiphertext: string;
}>;

export type ParsedAutomationExecution = Readonly<{
  targetType: 'new_session' | 'existing_session';
  directory: string;
  checkoutCreationDraft?: SessionAuthoringCheckoutCreationDraftV1;
  backendTarget?: SpawnSessionOptions['backendTarget'];
  profileId?: string;
  environmentVariables?: Record<string, string>;
  resume?: string;
  permissionMode?: SpawnSessionOptions['permissionMode'];
  permissionModeUpdatedAt?: number;
  modelSelection?: SpawnSessionOptions['modelSelection'];
  modelId?: string;
  modelUpdatedAt?: number;
  sessionConfigOptionOverrides?: SpawnSessionOptions['sessionConfigOptionOverrides'];
  mcpSelection?: SpawnSessionOptions['mcpSelection'];
  connectedServices?: SpawnSessionOptions['connectedServices'];
  transcriptStorage?: SpawnSessionOptions['transcriptStorage'];
  terminal?: SpawnSessionOptions['terminal'];
  windowsRemoteSessionLaunchMode?: SpawnSessionOptions['windowsRemoteSessionLaunchMode'];
  windowsRemoteSessionConsole?: SpawnSessionOptions['windowsRemoteSessionConsole'];
  windowsTerminalWindowName?: SpawnSessionOptions['windowsTerminalWindowName'];
  runtimeDescriptorV1?: SpawnSessionOptions['runtimeDescriptorV1'];
  agentModeId?: string;
  existingSessionId?: string;
  sessionEncryptionMode?: 'e2ee' | 'plain';
  sessionEncryptionKeyBase64?: string;
  sessionEncryptionVariant?: 'dataKey';
  prompt?: string;
  displayText?: string;
}>;

export type AutomationTemplateExecutionParseResult =
  | Readonly<{ ok: true; value: ParsedAutomationExecution }>
  | Readonly<{
      ok: false;
      code: 'invalid_template' | 'encryption_material_unavailable' | 'encryption_mode_mismatch' | 'session_key_required';
      error: string;
    }>;

function invalidAutomationTemplate(
  error: string,
): Extract<AutomationTemplateExecutionParseResult, { ok: false }> {
  return { ok: false, code: 'invalid_template', error };
}

export function parseAutomationTemplateExecution(
  payload: AutomationTemplateExecutionInput,
  encryption: AutomationTemplateEncryption | undefined,
  accountMode: 'plain' | 'e2ee',
  retainedSession?: AutomationTemplateRetainedSessionV1,
): AutomationTemplateExecutionParseResult {
  if (payload.templateCiphertext.length > AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS) {
    return invalidAutomationTemplate('Invalid automation template: envelope too large');
  }

  const storedRead = readAutomationTemplateStoredEnvelopeV1(payload.templateCiphertext);
  if (!storedRead) return invalidAutomationTemplate('Invalid automation template envelope');
  const opened = openAutomationTemplateStoredV1({
    templateCiphertext: payload.templateCiphertext,
    accountMode,
    ...(retainedSession && payload.targetType === 'existing_session' ? { retainedSession } : {}),
    ...(encryption ? { material: encryption } : {}),
  });
  if (!opened.ok) return { ok: false, code: opened.code, error: opened.code === 'encryption_material_unavailable'
    ? 'Encrypted automation template cannot be decrypted without account encryption material'
    : 'Invalid automation template: ' + opened.code };
  const parsedPayload = opened.template;

  const parsed = TemplateSchema.safeParse(parsedPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join('.') ?? 'template';
    return invalidAutomationTemplate(`Invalid automation template: ${path}`);
  }

  const template = parsed.data;
  const runtimeDescriptorV1 = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    agentId: template.backendTarget?.sourceKind === 'built_in'
      ? template.backendTarget.backendId
      : template.agent,
    codexBackendMode: template.codexBackendMode,
    experimentalCodexAcp: template.experimentalCodexAcp,
    runtimeDescriptorV1: template.runtimeDescriptorV1,
  }).runtimeDescriptorV1;

  if (payload.targetType === 'existing_session' && !template.existingSessionId) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId is required for existing_session target');
  }
  if (
    payload.targetType === 'existing_session'
    && storedRead.legacyExistingSessionId
    && storedRead.legacyExistingSessionId !== template.existingSessionId
  ) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId mismatch');
  }
  if (payload.targetType === 'new_session' && template.existingSessionId) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId is not allowed for new_session target');
  }

  return {
    ok: true,
    value: {
      targetType: payload.targetType,
      directory: template.directory,
      ...(template.checkoutCreationDraft ? { checkoutCreationDraft: template.checkoutCreationDraft } : {}),
      ...(template.backendTarget
        ? { backendTarget: template.backendTarget satisfies NonNullable<SpawnSessionOptions['backendTarget']> }
        : template.agent
          ? {
            backendTarget: {
              kind: 'backend',
              backendId: template.agent,
              sourceKind: 'built_in',
            } as const satisfies NonNullable<SpawnSessionOptions['backendTarget']>,
          }
          : {}),
      ...(template.profileId ? { profileId: template.profileId } : {}),
      ...(template.environmentVariables ? { environmentVariables: template.environmentVariables } : {}),
      ...(template.resume ? { resume: template.resume } : {}),
      ...(template.permissionMode ? { permissionMode: template.permissionMode as SpawnSessionOptions['permissionMode'] } : {}),
      ...(typeof template.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: template.permissionModeUpdatedAt } : {}),
      ...(template.modelSelection ? { modelSelection: template.modelSelection } : {}),
      ...(template.modelSelection === undefined && template.modelId ? { modelId: template.modelId } : {}),
      ...(template.modelSelection === undefined && typeof template.modelUpdatedAt === 'number'
        ? { modelUpdatedAt: template.modelUpdatedAt }
        : {}),
      ...(template.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: template.sessionConfigOptionOverrides } : {}),
      ...(template.mcpSelection ? { mcpSelection: template.mcpSelection } : {}),
      ...(template.connectedServices !== undefined ? { connectedServices: template.connectedServices } : {}),
      ...(template.transcriptStorage !== undefined ? { transcriptStorage: template.transcriptStorage } : {}),
      ...(template.terminal !== undefined ? { terminal: template.terminal as SpawnSessionOptions['terminal'] } : {}),
      ...(template.windowsRemoteSessionLaunchMode
        ? { windowsRemoteSessionLaunchMode: template.windowsRemoteSessionLaunchMode }
        : {}),
      ...(template.windowsRemoteSessionConsole
        ? { windowsRemoteSessionConsole: template.windowsRemoteSessionConsole }
        : {}),
      ...(typeof template.windowsTerminalWindowName === 'string'
        ? { windowsTerminalWindowName: template.windowsTerminalWindowName }
        : {}),
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
      ...(template.agentModeId ? { agentModeId: template.agentModeId } : {}),
      ...(template.existingSessionId ? { existingSessionId: template.existingSessionId } : {}),
      ...(template.sessionEncryptionMode ? { sessionEncryptionMode: template.sessionEncryptionMode } : {}),
      ...(template.sessionEncryptionKeyBase64 ? { sessionEncryptionKeyBase64: template.sessionEncryptionKeyBase64 } : {}),
      ...(template.sessionEncryptionVariant ? { sessionEncryptionVariant: template.sessionEncryptionVariant } : {}),
      ...(typeof template.prompt === 'string' && template.prompt.trim().length > 0 ? { prompt: template.prompt } : {}),
      ...(typeof template.displayText === 'string' && template.displayText.trim().length > 0
        ? { displayText: template.displayText }
        : {}),
    },
  };
}
