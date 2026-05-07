import { z } from 'zod';
import { BackendTargetRefSchema, openAccountScopedBlobCiphertext, SessionMcpSelectionV1Schema } from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/agents';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  SpawnSessionPermissionModeSchema,
  SpawnSessionTerminalSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { decodeBase64, decryptLegacy } from '@/api/encryption';

const ENCRYPTED_TEMPLATE_ENVELOPE_KIND = 'happier_automation_template_encrypted_v1';
const PLAINTEXT_TEMPLATE_ENVELOPE_KIND = 'happier_automation_template_plain_v1';
const MAX_TEMPLATE_CIPHERTEXT_CHARS = 220_000;
const MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS = 200_000;
const MAX_TEMPLATE_PAYLOAD_PLAINTEXT_CHARS = 200_000;

const CheckoutCreationDraftSchema = z.object({
  kind: z.literal('git_worktree'),
  displayName: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable().optional(),
}).strict().transform((value) => ({
  kind: value.kind,
  displayName: value.displayName.trim(),
  baseRef: typeof value.baseRef === 'string' ? value.baseRef.trim() : null,
}));

const TemplateSchema = z.object({
  directory: z.string().trim().min(1),
  checkoutCreationDraft: CheckoutCreationDraftSchema.optional(),
  agent: z.string().trim().min(1).optional(),
  backendTarget: BackendTargetRefSchema.optional(),
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  resume: z.string().optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  connectedServices: z.unknown().optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
  terminal: SpawnSessionTerminalSchema.optional(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  windowsTerminalWindowName: z.string().optional(),
  experimentalCodexAcp: z.boolean().optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  agentModeId: z.string().optional(),
  existingSessionId: z.string().trim().min(1).optional(),
  sessionEncryptionMode: z.enum(['e2ee', 'plain']).optional(),
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

const PlainTemplateEnvelopeSchema = z.object({
  kind: z.literal(PLAINTEXT_TEMPLATE_ENVELOPE_KIND),
  payload: z.unknown(),
  existingSessionId: z.string().trim().min(1).optional(),
}).strict();

const AnyTemplateEnvelopeSchema = z.discriminatedUnion('kind', [
  TemplateEnvelopeSchema,
  PlainTemplateEnvelopeSchema,
]);

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
  checkoutCreationDraft?: {
    kind: 'git_worktree';
    displayName: string;
    baseRef: string | null;
  };
  backendTarget?: SpawnSessionOptions['backendTarget'];
  profileId?: string;
  environmentVariables?: Record<string, string>;
  resume?: string;
  permissionMode?: SpawnSessionOptions['permissionMode'];
  permissionModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  mcpSelection?: SpawnSessionOptions['mcpSelection'];
  connectedServices?: SpawnSessionOptions['connectedServices'];
  transcriptStorage?: SpawnSessionOptions['transcriptStorage'];
  terminal?: SpawnSessionOptions['terminal'];
  windowsRemoteSessionLaunchMode?: SpawnSessionOptions['windowsRemoteSessionLaunchMode'];
  windowsRemoteSessionConsole?: SpawnSessionOptions['windowsRemoteSessionConsole'];
  windowsTerminalWindowName?: SpawnSessionOptions['windowsTerminalWindowName'];
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
  agentModeId?: string;
  existingSessionId?: string;
  sessionEncryptionMode?: 'e2ee' | 'plain';
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
  const anyEnvelope = AnyTemplateEnvelopeSchema.safeParse(parsedEnvelope);
  if (!anyEnvelope.success) {
    return { ok: false, error: 'Invalid automation template envelope' };
  }
  if (anyEnvelope.data.kind === ENCRYPTED_TEMPLATE_ENVELOPE_KIND) {
    if (anyEnvelope.data.payloadCiphertext.length > MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS) {
      return { ok: false, error: 'Invalid automation template: payloadCiphertext too large' };
    }
  } else {
    const payloadJson = (() => {
      try {
        return JSON.stringify(anyEnvelope.data.payload);
      } catch {
        return null;
      }
    })();
    if (!payloadJson) {
      return { ok: false, error: 'Invalid automation template: payload must be JSON-serializable' };
    }
    if (payloadJson.length > MAX_TEMPLATE_PAYLOAD_PLAINTEXT_CHARS) {
      return { ok: false, error: 'Invalid automation template: payload too large' };
    }
  }

  if (payload.automation.targetType === 'existing_session') {
    if (!anyEnvelope.data.existingSessionId) {
      return { ok: false, error: 'Invalid automation template: existingSessionId is required for existing_session target' };
    }
  } else if (anyEnvelope.data.existingSessionId) {
    return { ok: false, error: 'Invalid automation template: existingSessionId is not allowed for new_session target' };
  }

  let parsedPayload: unknown;
  if (anyEnvelope.data.kind === PLAINTEXT_TEMPLATE_ENVELOPE_KIND) {
    parsedPayload = anyEnvelope.data.payload;
  } else {
    if (!encryption) {
      return { ok: false, error: 'Encrypted automation template cannot be decrypted without machine encryption context' };
    }

    const opened = (() => {
      try {
        const opened = openAccountScopedBlobCiphertext({
          kind: 'automation_template_payload',
          material: encryption.type === 'legacy'
            ? { type: 'legacy', secret: encryption.secret }
            : { type: 'dataKey', machineKey: encryption.machineKey },
          ciphertext: anyEnvelope.data.payloadCiphertext,
        });
        const decrypted = opened?.value;
        if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
          return null;
        }
        return decrypted;
      } catch {
        return null;
      }
    })();

    if (opened) {
      parsedPayload = opened;
    } else {
      // Legacy fallback: some older templates were sealed with a raw secretbox (base64 of encryptLegacy).
      try {
        const ciphertextBytes = decodeBase64(anyEnvelope.data.payloadCiphertext, 'base64');
        const secret = encryption.type === 'legacy' ? encryption.secret : encryption.machineKey;
        const decrypted = decryptLegacy(ciphertextBytes, secret);
        if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
          return { ok: false, error: 'Invalid encrypted automation template payload' };
        }
        parsedPayload = decrypted;
      } catch {
        return { ok: false, error: 'Invalid encrypted automation template payload' };
      }
    }
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
  if (payload.automation.targetType === 'existing_session' && anyEnvelope.data.existingSessionId !== template.existingSessionId) {
    return { ok: false, error: 'Invalid automation template: existingSessionId mismatch' };
  }

  return {
    ok: true,
    value: {
      targetType: payload.automation.targetType,
      directory: template.directory,
      ...(template.checkoutCreationDraft ? { checkoutCreationDraft: template.checkoutCreationDraft } : {}),
      ...(template.backendTarget
        ? { backendTarget: template.backendTarget satisfies NonNullable<SpawnSessionOptions['backendTarget']> }
        : template.agent
          ? { backendTarget: { kind: 'builtInAgent', agentId: template.agent } as const satisfies NonNullable<SpawnSessionOptions['backendTarget']> }
          : {}),
      ...(template.profileId ? { profileId: template.profileId } : {}),
      ...(template.environmentVariables ? { environmentVariables: template.environmentVariables } : {}),
      ...(template.resume ? { resume: template.resume } : {}),
      ...(template.permissionMode ? { permissionMode: template.permissionMode as SpawnSessionOptions['permissionMode'] } : {}),
      ...(typeof template.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: template.permissionModeUpdatedAt } : {}),
      ...(template.modelId ? { modelId: template.modelId } : {}),
      ...(typeof template.modelUpdatedAt === 'number' ? { modelUpdatedAt: template.modelUpdatedAt } : {}),
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
      ...(template.windowsTerminalWindowName
        ? { windowsTerminalWindowName: template.windowsTerminalWindowName }
        : {}),
      ...(template.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: template.experimentalCodexAcp } : {}),
      ...(template.codexBackendMode !== undefined ? { codexBackendMode: template.codexBackendMode } : {}),
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
