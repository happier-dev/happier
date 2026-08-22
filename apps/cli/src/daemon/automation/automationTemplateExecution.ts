import { z } from 'zod';
import {
  AcpConfigOptionOverridesV1Schema,
  AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
  AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
  AutomationRunExecutionInputV1Schema,
  BackendTargetRefV2Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  materializeAutomationRunPromptV1,
  type CodexBackendMode,
  normalizeBackendTargetRefV2InputToV2,
  normalizeCodexBackendMode,
  normalizeAutomationTemplateEnvelopeStoredRead,
  openAccountScopedBlobCiphertext,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import {
  SpawnSessionPermissionModeSchema,
  SpawnSessionTerminalSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { decodeBase64, decryptLegacy } from '@/api/encryption';

const MAX_TEMPLATE_CIPHERTEXT_CHARS = 220_000;
const MAX_EXECUTION_INPUT_ENVELOPE_CHARS = MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES;
const UTF8_ENCODER = new TextEncoder();

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
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema).optional(),
  profileId: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  resume: z.string().optional(),
  permissionMode: SpawnSessionPermissionModeSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  modelSelection: SessionModelSelectionV1Schema.nullable().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
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

export type AutomationFrozenRunPayload = Readonly<{
  run: {
    id: string;
    automationId: string;
    executionInputEnvelope: string | null;
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

export type AutomationTemplateExecutionParseResult =
  | Readonly<{ ok: true; value: ParsedAutomationExecution }>
  | Readonly<{
      ok: false;
      code: 'invalid_template' | 'encryption_material_unavailable';
      error: string;
    }>;

function invalidAutomationTemplate(
  error: string,
): Extract<AutomationTemplateExecutionParseResult, { ok: false }> {
  return { ok: false, code: 'invalid_template', error };
}

type AutomationTemplatePromptMaterializationResult =
  | Readonly<{ ok: true; prompt?: string }>
  | Extract<AutomationTemplateExecutionParseResult, { ok: false }>;

/**
 * Renders a released V2 Definition's prompt through the one Protocol token
 * materializer. This adapter never carries trigger evidence: its only writer
 * freezes `scheduled`/`manual` Runs, which `parseAutomationRunExecutionInput`
 * rechecks before reaching here. The template is built locally, so the only
 * way it can fail the Protocol template shape is its prompt byte ceiling.
 */
export function materializeAutomationTemplatePrompt(params: Readonly<{
  prompt: string | undefined;
}>): AutomationTemplatePromptMaterializationResult {
  const materialized = materializeAutomationRunPromptV1({
    template: { v: 1, prompt: params.prompt ?? '' },
    triggerEvidence: null,
  });
  if (materialized.kind !== 'available') {
    switch (materialized.reason) {
      case 'malformedToken':
        return invalidAutomationTemplate('Invalid automation template: malformed token');
      case 'unsupportedToken':
        return invalidAutomationTemplate(
          `Invalid automation template: unsupported token ${materialized.token}`,
        );
      default:
        return invalidAutomationTemplate('Invalid automation template: materialized input exceeds its UTF-8 byte limit');
    }
  }

  return materialized.prompt.length > 0 ? { ok: true, prompt: materialized.prompt } : { ok: true };
}

export function parseAutomationTemplateExecution(
  payload: AutomationClaimedRunPayload,
  encryption?: AutomationTemplateEncryption,
): AutomationTemplateExecutionParseResult {
  if (payload.automation.templateCiphertext.length > MAX_TEMPLATE_CIPHERTEXT_CHARS) {
    return invalidAutomationTemplate('Invalid automation template: envelope too large');
  }

  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(payload.automation.templateCiphertext);
  } catch {
    return invalidAutomationTemplate('Invalid automation template JSON');
  }

  const storedRead = normalizeAutomationTemplateEnvelopeStoredRead(parsedEnvelope);
  if (!storedRead) {
    return invalidAutomationTemplate('Invalid automation template envelope');
  }
  if (
    payload.automation.targetType === 'new_session'
    && storedRead.legacyExistingSessionId
  ) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId is not allowed for new_session target');
  }
  const anyEnvelope = storedRead.envelope;

  let parsedPayload: unknown;
  if (anyEnvelope.kind === AUTOMATION_TEMPLATE_PLAIN_V1_KIND) {
    parsedPayload = anyEnvelope.payload;
  } else if (
    anyEnvelope.kind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND
  ) {
    if (!encryption) {
      return {
        ok: false,
        code: 'encryption_material_unavailable',
        error: 'Encrypted automation template cannot be decrypted without account encryption material',
      };
    }

    const opened = (() => {
      try {
        const opened = openAccountScopedBlobCiphertext({
          kind: 'automation_template_payload',
          material: encryption.type === 'legacy'
            ? { type: 'legacy', secret: encryption.secret }
            : { type: 'dataKey', machineKey: encryption.machineKey },
          ciphertext: anyEnvelope.payloadCiphertext,
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
        const ciphertextBytes = decodeBase64(anyEnvelope.payloadCiphertext, 'base64');
        const secret = encryption.type === 'legacy' ? encryption.secret : encryption.machineKey;
        const decrypted = decryptLegacy(ciphertextBytes, secret);
        if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
          return invalidAutomationTemplate('Invalid encrypted automation template payload');
        }
        parsedPayload = decrypted;
      } catch {
        return invalidAutomationTemplate('Invalid encrypted automation template payload');
      }
    }
  }

  const parsed = TemplateSchema.safeParse(parsedPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join('.') ?? 'template';
    return invalidAutomationTemplate(`Invalid automation template: ${path}`);
  }

  const template = parsed.data;
  const codexBackendMode = normalizeCodexBackendMode(template.codexBackendMode);

  if (payload.automation.targetType === 'existing_session' && !template.existingSessionId) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId is required for existing_session target');
  }
  if (
    payload.automation.targetType === 'existing_session'
    && storedRead.legacyExistingSessionId
    && storedRead.legacyExistingSessionId !== template.existingSessionId
  ) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId mismatch');
  }
  if (payload.automation.targetType === 'new_session' && template.existingSessionId) {
    return invalidAutomationTemplate('Invalid automation template: existingSessionId is not allowed for new_session target');
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
      ...(template.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: template.experimentalCodexAcp } : {}),
      ...(codexBackendMode !== null ? { codexBackendMode } : {}),
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

/**
 * V3 execution reads only the immutable Run recipe. Retained Runs without one
 * are deliberately not reconstructed from the current Automation definition.
 */
export function parseAutomationRunExecutionInput(
  payload: AutomationFrozenRunPayload,
  encryption?: AutomationTemplateEncryption,
): AutomationTemplateExecutionParseResult {
  const raw = payload.run.executionInputEnvelope;
  if (raw === null) {
    return invalidAutomationTemplate('Frozen automation execution input is unavailable');
  }
  if (
    raw.length > MAX_EXECUTION_INPUT_ENVELOPE_CHARS
    || UTF8_ENCODER.encode(raw).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    return invalidAutomationTemplate('Invalid frozen automation execution input: envelope too large');
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    return invalidAutomationTemplate('Invalid frozen automation execution input JSON');
  }
  const recipe = AutomationRunExecutionInputV1Schema.safeParse(parsedRaw);
  if (!recipe.success) {
    return invalidAutomationTemplate('Invalid frozen automation execution input');
  }
  // The only V2 writer freezes `scheduled`/`manual` Runs. Refuse any other
  // origin rather than silently materializing its evidence as empty input.
  if (recipe.data.origin.kind !== 'scheduled' && recipe.data.origin.kind !== 'manual') {
    return invalidAutomationTemplate('Invalid frozen automation execution input: unsupported origin');
  }

  const parsedTemplate = parseAutomationTemplateExecution({
    run: {
      id: payload.run.id,
      automationId: payload.run.automationId,
    },
    automation: {
      id: payload.run.automationId,
      name: 'Frozen automation execution input',
      enabled: true,
      targetType: recipe.data.targetType,
      templateCiphertext: recipe.data.templateCiphertext,
    },
  }, encryption);
  if (!parsedTemplate.ok) {
    return parsedTemplate;
  }

  const materialized = materializeAutomationTemplatePrompt({
    prompt: parsedTemplate.value.prompt,
  });
  if (!materialized.ok) {
    return materialized;
  }

  const { prompt: _prompt, ...executionWithoutPrompt } = parsedTemplate.value;
  return {
    ok: true,
    value: {
      ...executionWithoutPrompt,
      ...(materialized.prompt !== undefined ? { prompt: materialized.prompt } : {}),
    },
  };
}
