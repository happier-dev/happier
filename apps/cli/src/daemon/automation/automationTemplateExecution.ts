import { z } from 'zod';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const ENCRYPTED_TEMPLATE_ENVELOPE_KIND = 'happier_automation_template_encrypted_v1';
const MAX_TEMPLATE_CIPHERTEXT_CHARS = 220_000;
const MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS = 200_000;

const TemplateSchema = z.object({
  directory: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
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
  existingSessionId: z.string().trim().min(1).optional(),
  sessionEncryptionKeyBase64: z.string().optional(),
  sessionEncryptionVariant: z.literal('dataKey').optional(),
  prompt: z.string().optional(),
  displayText: z.string().optional(),
}).strict();

const TemplateEnvelopeSchema = z.object({
  kind: z.literal(ENCRYPTED_TEMPLATE_ENVELOPE_KIND),
  payloadCiphertext: z.string().trim().min(1),
  existingSessionId: z.string().trim().min(1).optional(),
}).strict();

export type AutomationTemplateEncryption =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export type AutomationClaimedRunPayload = Readonly<{
  run: {
    id: string;
    automationId: string;
  };
  automation: {
    id: string;
    name: string;
    enabled: boolean;
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
  };
}>;

export type ParsedAutomationExecution = Readonly<{
  targetType: 'new_session' | 'existing_session';
  directory: string;
  agent?: SpawnSessionOptions['agent'];
  profileId?: string;
  environmentVariables?: Record<string, string>;
  resume?: string;
  permissionMode?: SpawnSessionOptions['permissionMode'];
  permissionModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  terminal?: SpawnSessionOptions['terminal'];
  windowsRemoteSessionConsole?: SpawnSessionOptions['windowsRemoteSessionConsole'];
  experimentalCodexResume?: boolean;
  experimentalCodexAcp?: boolean;
  existingSessionId?: string;
  sessionEncryptionKeyBase64?: string;
  sessionEncryptionVariant?: 'dataKey';
  prompt?: string;
  displayText?: string;
}>;

export function parseAutomationTemplateExecution(
  payload: AutomationClaimedRunPayload,
  encryption?: AutomationTemplateEncryption,
): { ok: true; value: ParsedAutomationExecution } | { ok: false; error: string } {
  if (payload.automation.templateCiphertext.length > MAX_TEMPLATE_CIPHERTEXT_CHARS) {
    return { ok: false, error: 'Invalid automation template: envelope too large' };
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(payload.automation.templateCiphertext);
  } catch {
    return { ok: false, error: 'Invalid automation template JSON' };
  }

  const envelope = TemplateEnvelopeSchema.safeParse(parsedEnvelope);
  if (!envelope.success) {
    return { ok: false, error: 'Invalid automation template envelope' };
  }
  if (envelope.data.payloadCiphertext.length > MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS) {
    return { ok: false, error: 'Invalid automation template: payloadCiphertext too large' };
  }

  if (payload.automation.targetType === 'existing_session') {
    if (!envelope.data.existingSessionId) {
      return { ok: false, error: 'Invalid automation template: existingSessionId is required for existing_session target' };
    }
  } else if (envelope.data.existingSessionId) {
    return { ok: false, error: 'Invalid automation template: existingSessionId is not allowed for new_session target' };
  }

  if (!encryption) {
    return { ok: false, error: 'Encrypted automation template cannot be decrypted without machine encryption context' };
  }

  let parsedPayload: unknown;
  try {
    const opened = openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: encryption.type === 'legacy'
        ? { type: 'legacy', secret: encryption.secret }
        : { type: 'dataKey', machineKey: encryption.machineKey },
      ciphertext: envelope.data.payloadCiphertext,
    });
    const decrypted = opened?.value;
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
      return { ok: false, error: 'Invalid encrypted automation template payload' };
    }
    parsedPayload = decrypted;
  } catch {
    return { ok: false, error: 'Invalid encrypted automation template payload' };
  }

  const parsed = TemplateSchema.safeParse(parsedPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join('.') ?? 'template';
    return { ok: false, error: `Invalid automation template: ${path}` };
  }

  const template = parsed.data;

  if (payload.automation.targetType === 'existing_session' && !template.existingSessionId) {
    return { ok: false, error: 'Invalid automation template: existingSessionId is required for existing_session target' };
  }
  if (payload.automation.targetType === 'existing_session' && envelope.data.existingSessionId !== template.existingSessionId) {
    return { ok: false, error: 'Invalid automation template: existingSessionId mismatch' };
  }

  return {
    ok: true,
    value: {
      targetType: payload.automation.targetType,
      directory: template.directory,
      ...(template.agent ? { agent: template.agent as SpawnSessionOptions['agent'] } : {}),
      ...(template.profileId ? { profileId: template.profileId } : {}),
      ...(template.environmentVariables ? { environmentVariables: template.environmentVariables } : {}),
      ...(template.resume ? { resume: template.resume } : {}),
      ...(template.permissionMode ? { permissionMode: template.permissionMode as SpawnSessionOptions['permissionMode'] } : {}),
      ...(typeof template.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: template.permissionModeUpdatedAt } : {}),
      ...(template.modelId ? { modelId: template.modelId } : {}),
      ...(typeof template.modelUpdatedAt === 'number' ? { modelUpdatedAt: template.modelUpdatedAt } : {}),
      ...(template.terminal !== undefined ? { terminal: template.terminal as SpawnSessionOptions['terminal'] } : {}),
      ...(template.windowsRemoteSessionConsole
        ? { windowsRemoteSessionConsole: template.windowsRemoteSessionConsole }
        : {}),
      ...(template.experimentalCodexResume !== undefined ? { experimentalCodexResume: template.experimentalCodexResume } : {}),
      ...(template.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: template.experimentalCodexAcp } : {}),
      ...(template.existingSessionId ? { existingSessionId: template.existingSessionId } : {}),
      ...(template.sessionEncryptionKeyBase64 ? { sessionEncryptionKeyBase64: template.sessionEncryptionKeyBase64 } : {}),
      ...(template.sessionEncryptionVariant ? { sessionEncryptionVariant: template.sessionEncryptionVariant } : {}),
      ...(typeof template.prompt === 'string' && template.prompt.trim().length > 0 ? { prompt: template.prompt } : {}),
      ...(typeof template.displayText === 'string' && template.displayText.trim().length > 0
        ? { displayText: template.displayText }
        : {}),
    },
  };
}
