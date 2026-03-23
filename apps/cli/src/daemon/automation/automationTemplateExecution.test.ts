import { describe, expect, it } from 'vitest';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import {
  parseAutomationTemplateExecution,
  type AutomationClaimedRunPayload,
} from './automationTemplateExecution';

function buildEncryptedTemplateCiphertext(
  payload: Record<string, unknown>,
  secret: Uint8Array = new Uint8Array(32).fill(7),
  envelope?: { existingSessionId?: string },
): string {
  return JSON.stringify({
    kind: 'happier_automation_template_encrypted_v1',
    payloadCiphertext: encodeBase64(encryptLegacy(payload, secret)),
    ...(typeof envelope?.existingSessionId === 'string' && envelope.existingSessionId.trim().length > 0
      ? { existingSessionId: envelope.existingSessionId.trim() }
      : typeof payload.existingSessionId === 'string' && payload.existingSessionId.trim().length > 0
        ? { existingSessionId: payload.existingSessionId.trim() }
        : {}),
  });
}

function buildPlainTemplateCiphertext(
  payload: Record<string, unknown>,
  envelope?: { existingSessionId?: string },
): string {
  return JSON.stringify({
    kind: 'happier_automation_template_plain_v1',
    payload,
    ...(typeof envelope?.existingSessionId === 'string' && envelope.existingSessionId.trim().length > 0
      ? { existingSessionId: envelope.existingSessionId.trim() }
      : typeof payload.existingSessionId === 'string' && payload.existingSessionId.trim().length > 0
        ? { existingSessionId: payload.existingSessionId.trim() }
        : {}),
  });
}

function buildClaimedRun(override?: Partial<AutomationClaimedRunPayload>): AutomationClaimedRunPayload {
  return {
    run: {
      id: 'run-1',
      automationId: 'a1',
    },
    automation: {
      id: 'a1',
      name: 'Daily',
      enabled: true,
      targetType: 'new_session',
      templateCiphertext: buildEncryptedTemplateCiphertext({
        directory: '/tmp/project',
        agent: 'codex',
      }),
    },
    ...override,
  };
}

describe('parseAutomationTemplateExecution', () => {
  it('decrypts templates encrypted with protocol account-scoped v1 (legacy mode)', () => {
    const secret = new Uint8Array(32).fill(7);
    const payloadCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: { type: 'legacy', secret },
      payload: {
        directory: '/tmp/project',
        prompt: 'Run protocol template',
      },
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Protocol legacy',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_encrypted_v1',
            payloadCiphertext,
          }),
        },
      }),
      { type: 'legacy', secret },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Run protocol template');
  });

  it('decrypts templates encrypted with protocol account-scoped v1 (dataKey mode)', () => {
    const machineKey = new Uint8Array(32).fill(9);
    const payloadCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: { type: 'dataKey', machineKey },
      payload: {
        directory: '/tmp/project',
        prompt: 'Run protocol template (dataKey)',
      },
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Protocol dataKey',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: JSON.stringify({
            kind: 'happier_automation_template_encrypted_v1',
            payloadCiphertext,
          }),
        },
      }),
      { type: 'dataKey', machineKey },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Run protocol template (dataKey)');
  });

  it('rejects plaintext templates without encrypted envelope', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Plaintext payload',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: JSON.stringify({
            directory: '/tmp/project',
            agent: 'codex',
          }),
        },
      }),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/envelope/i);
  });

  it('parses plaintext envelope templates without requiring encryption context', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Plain envelope',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            prompt: 'Hello',
          }),
        },
      }),
      undefined,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Hello');
  });

  it('parses configured ACP backend targets from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'ACP backend',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            prompt: 'Use the ACP backend',
          }),
        },
      }),
      undefined,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.backendTarget).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    expect(parsed.value.prompt).toBe('Use the ACP backend');
  });

  it('parses mcpSelection from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Plain envelope',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            mcpSelection: {
              v: 1,
              managedServersEnabled: false,
              forceIncludeServerIds: ['server-portable'],
              forceExcludeServerIds: ['server-disabled'],
            },
          }),
        },
      }),
      undefined,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mcpSelection).toEqual({
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['server-portable'],
      forceExcludeServerIds: ['server-disabled'],
    });
  });

  it('parses agent mode from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Plain envelope',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            agentModeId: 'plan',
          }),
        },
      }),
      undefined,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.agentModeId).toBe('plan');
  });

  it('parses codexBackendMode from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Codex backend mode',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            codexBackendMode: 'appServer',
          }),
        },
      }),
      undefined,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.codexBackendMode).toBe('appServer');
  });

  it('rejects workspace-linked plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Workspace intent',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
            checkoutCreationDraft: {
              kind: 'git_worktree',
              displayName: 'feature/auth',
              baseRef: 'main',
            },
          }),
        },
      }),
      undefined,
    );

    expect(parsed.ok).toBe(false);
  });

  it('parses connectedServices and transcriptStorage from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Plain envelope',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                anthropic: { source: 'connected', profileId: 'work' },
              },
            },
            transcriptStorage: 'direct',
          }),
        },
      }),
      undefined,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', profileId: 'work' },
      },
    });
    expect(parsed.value.transcriptStorage).toBe('direct');
  });

  it('rejects templates with invalid permissionMode values', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Invalid permission mode',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            permissionMode: 'not-a-mode',
          }),
        },
      }),
      undefined,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/permissionMode/i);
  });

  it('rejects templates with invalid terminal spawn options', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Invalid terminal',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            terminal: 123,
          }),
        },
      }),
      undefined,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/terminal/i);
  });

  it('parses new-session encrypted templates and normalizes defaults', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun(),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.targetType).toBe('new_session');
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
  });

  it('rejects invalid template payloads', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Broken',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: '{not-json',
        },
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/template/i);
  });

  it('parses existing-session template prompts when provided', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Existing session',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: buildEncryptedTemplateCiphertext({
            directory: '/tmp/project',
            existingSessionId: 'session-1',
            sessionEncryptionKeyBase64: 'sV5GvMBrN+41qh6QleA1zoao46PdM6f95wo4keJ2H2Y=',
            sessionEncryptionVariant: 'dataKey',
            prompt: 'Run checks',
          }),
        },
      }),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.targetType).toBe('existing_session');
    expect(parsed.value.existingSessionId).toBe('session-1');
    expect(parsed.value.prompt).toBe('Run checks');
  });

  it('parses existing-session plaintext session encryption mode when present', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Existing plaintext session',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: buildEncryptedTemplateCiphertext({
            directory: '/tmp/project',
            existingSessionId: 'session-plain',
            sessionEncryptionMode: 'plain',
            prompt: 'Run checks',
          }),
        },
      }),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sessionEncryptionMode).toBe('plain');
    expect(parsed.value.sessionEncryptionKeyBase64).toBeUndefined();
  });

  it('rejects existing-session templates when envelope existingSessionId mismatches payload existingSessionId', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Existing session mismatch',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: buildEncryptedTemplateCiphertext(
            {
              directory: '/tmp/project',
              existingSessionId: 'session-1',
              prompt: 'Run checks',
            },
            new Uint8Array(32).fill(7),
            { existingSessionId: 'session-2' },
          ),
        },
      }),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Avoid brittle copy-policing; asserting invalid template failure is sufficient.
    expect(parsed.error).toMatch(/automation template/i);
  });

  it('rejects new-session templates when envelope includes existingSessionId', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'New session with existingSessionId',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildEncryptedTemplateCiphertext(
            {
              directory: '/tmp/project',
              prompt: 'Run checks',
            },
            new Uint8Array(32).fill(7),
            { existingSessionId: 'session-1' },
          ),
        },
      }),
      {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Avoid brittle copy-policing; asserting invalid template failure is sufficient.
    expect(parsed.error).toMatch(/automation template/i);
  });

  it('decrypts encrypted envelope templates when encryption credentials are provided', () => {
    const secret = new Uint8Array(32).fill(7);
    const encryptedPayload = encodeBase64(
      encryptLegacy(
        {
          directory: '/tmp/project',
          prompt: 'Run encrypted flow',
        },
        secret,
      ),
    );

    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Encrypted',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildEncryptedTemplateCiphertext({
            directory: '/tmp/project',
            prompt: 'Run encrypted flow',
          }, secret),
        },
      }),
      {
        type: 'legacy',
        secret,
      },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Run encrypted flow');
  });

  it('decrypts templates sealed with secretbox when daemon credentials are in dataKey mode', () => {
    const machineKey = new Uint8Array(32).fill(9);

    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'DataKey secretbox',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildEncryptedTemplateCiphertext(
            {
              directory: '/tmp/project',
              prompt: 'Run secretbox while in dataKey mode',
            },
            machineKey,
          ),
        },
      }),
      {
        // In dataKey mode, we still need to decrypt automation templates.
        // The UI seals templates using a symmetric secretbox key derived from the machine key.
        type: 'dataKey',
        machineKey,
      },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Run secretbox while in dataKey mode');
  });
});
