import { describe, expect, it } from 'vitest';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
  AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED }
  from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import {
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import {
  parseAutomationTemplateExecution,
  type AutomationTemplateExecutionInput,
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

function buildClaimedRun(override?: Readonly<{ automation?: AutomationTemplateExecutionInput & {
  id: string; name: string; enabled: boolean;
} }>): AutomationTemplateExecutionInput {
  return override?.automation ?? {
    targetType: 'new_session',
    templateCiphertext: buildEncryptedTemplateCiphertext({
      directory: '/tmp/project',
      agent: 'codex',
    }),
  };
}

describe('parseAutomationTemplateExecution', () => {
  it('parses the retained E2EE Session branch without changing the authoritative plain Account mode', () => {
    const input = { targetType: 'existing_session' as const, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED };
    const retainedSession = { sessionId: 'session-old', encryptionMode: 'e2ee' as const,
      material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
    expect(parseAutomationTemplateExecution(input, undefined, 'plain', retainedSession))
      .toMatchObject({ ok: true, value: { existingSessionId: 'session-old', prompt: 'Review the release' } });
    expect(parseAutomationTemplateExecution(input, retainedSession.material, 'plain'))
      .toMatchObject({ ok: false, code: 'session_key_required' });
  });
  it.each([AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED])('executes exact 0.2 new-session writer bytes', (templateCiphertext) => {
    const parsed = parseAutomationTemplateExecution(buildClaimedRun({ automation: {
      id: 'a1', name: '0.2', enabled: true, targetType: 'new_session', templateCiphertext,
    } }), { type: 'legacy', secret: new Uint8Array(32).fill(7) }, templateCiphertext === AUTOMATION_TEMPLATE_V02_PLAIN || templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN ? 'plain' : 'e2ee');
    expect(parsed).toMatchObject({ ok: true, value: { directory: '/repo', prompt: 'Review the release',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, permissionMode: 'default' } });
  });
  it.each([AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED])('executes exact 0.2 existing-session writer bytes', (templateCiphertext) => {
    const parsed = parseAutomationTemplateExecution(buildClaimedRun({ automation: {
      id: 'a1', name: '0.2', enabled: true, targetType: 'existing_session', templateCiphertext,
    } }), { type: 'legacy', secret: new Uint8Array(32).fill(7) }, templateCiphertext === AUTOMATION_TEMPLATE_V02_PLAIN || templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN ? 'plain' : 'e2ee');
    expect(parsed).toMatchObject({ ok: true, value: { existingSessionId: 'session-old', directory: '/repo', prompt: 'Review the release' } });
  });
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
      { type: 'legacy', secret }, 'e2ee'
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
      { type: 'dataKey', machineKey }, 'e2ee'
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
      }, 'e2ee'
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
      undefined, 'plain'
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
            backendTarget: {
              kind: 'backend',
              backendId: 'review-bot',
              configuredBackendId: 'review-bot',
              sourceKind: 'configured',
            },
            prompt: 'Use the ACP backend',
          }),
        },
      }),
      undefined, 'plain'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
    expect(parsed.value.prompt).toBe('Use the ACP backend');
  });

  it('parses session config option overrides from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'ACP backend overrides',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            backendTarget: {
              kind: 'backend',
              backendId: 'review-bot',
              configuredBackendId: 'review-bot',
              sourceKind: 'configured',
            },
            sessionConfigOptionOverrides: {
              v: 1,
              updatedAt: 789,
              overrides: {
                reasoning: { updatedAt: 789, value: 'high' },
              },
            },
          }),
        },
      }),
      undefined, 'plain'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(expect.objectContaining({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 789,
        overrides: {
          reasoning: { updatedAt: 789, value: 'high' },
        },
      },
    }));
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
      undefined, 'plain'
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
      undefined, 'plain'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.agentModeId).toBe('plan');
  });

  it('preserves a provider-bound model selection from an automation template', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Provider model',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            modelSelection: {
              v: 1,
              updatedAt: 42,
              ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_work',
                modelId: 'default',
              },
            },
          }),
        },
      }),
      undefined, 'plain'
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        modelSelection: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: 'pc_work',
            modelId: 'default',
          },
        },
      },
    });
  });

  it('treats an explicit automatic selection as canonical over a legacy bare model', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Automatic model',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            modelSelection: null,
            modelId: 'legacy-native',
            modelUpdatedAt: 41,
          }),
        },
      }),
      undefined, 'plain'
    );

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('modelSelection');
    expect(parsed.value).not.toHaveProperty('modelId');
    expect(parsed.value).not.toHaveProperty('modelUpdatedAt');
  });

  it('parses runtimeDescriptorV1 from plaintext templates', () => {
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
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'codex',
              agent: { backendMode: 'appServer' },
            },
          }),
        },
      }),
      undefined, 'plain'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'appServer' },
    });
  });

  it('normalizes legacy codexBackendMode from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Legacy Codex backend mode',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            codexBackendMode: 'mcp',
          }),
        },
      }),
      undefined, 'plain'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'appServer' },
    });
  });

  it('carries the authored checkout branch mode through the canonical Session-authoring draft', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Existing branch checkout',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            checkoutCreationDraft: {
              kind: 'git_worktree',
              displayName: 'feature/auth',
              baseRef: 'main',
              branchMode: 'existing',
            },
          }),
        },
      }),
      undefined, 'plain'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.checkoutCreationDraft).toEqual({
      kind: 'git_worktree',
      displayName: 'feature/auth',
      baseRef: 'main',
      branchMode: 'existing',
    });
  });

  it('leaves an omitted checkout branch mode omitted for the materialization owner', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Default branch checkout',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            agent: 'codex',
            checkoutCreationDraft: {
              kind: 'git_worktree',
              displayName: 'feature/auth',
              baseRef: null,
            },
          }),
        },
      }),
      undefined, 'plain'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.checkoutCreationDraft).toEqual({
      kind: 'git_worktree',
      displayName: 'feature/auth',
      baseRef: null,
    });
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
      undefined, 'plain'
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
      undefined, 'plain'
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

  it('parses Windows Terminal window names from plaintext templates', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Windows Terminal run',
          enabled: true,
          targetType: 'new_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            windowsRemoteSessionLaunchMode: 'windows_terminal',
            windowsTerminalWindowName: 'happier',
          }),
        },
      }),
      undefined, 'plain'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    expect(parsed.value.windowsTerminalWindowName).toBe('happier');
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
      undefined, 'plain'
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
      undefined, 'plain'
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
      }, 'e2ee'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.targetType).toBe('new_session');
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.backendTarget).toEqual({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
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
      }), undefined, 'e2ee'
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/template/i);
  });

  it('distinguishes a retained encrypted template whose account material is unavailable', () => {
    const parsed = parseAutomationTemplateExecution(buildClaimedRun(), undefined, 'e2ee');

    expect(parsed).toEqual({
      ok: false,
      code: 'encryption_material_unavailable',
      error: 'Encrypted automation template cannot be decrypted without account encryption material',
    });
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
      }, 'e2ee'
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
      }, 'e2ee'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sessionEncryptionMode).toBe('plain');
    expect(parsed.value.sessionEncryptionKeyBase64).toBeUndefined();
  });

  it('reads the exact predecessor plain existing-session envelope after checking outer and payload agreement', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Predecessor plain existing session',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: buildPlainTemplateCiphertext({
            directory: '/tmp/project',
            existingSessionId: 'session-plain',
            sessionEncryptionMode: 'plain',
            prompt: 'Run checks',
          }),
        },
      }), undefined, 'plain'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.existingSessionId).toBe('session-plain');
    expect(parsed.value.prompt).toBe('Run checks');
  });

  it('rejects a predecessor plain existing-session envelope when outer and payload identifiers differ', () => {
    const parsed = parseAutomationTemplateExecution(
      buildClaimedRun({
        automation: {
          id: 'a1',
          name: 'Mismatched predecessor plain existing session',
          enabled: true,
          targetType: 'existing_session',
          templateCiphertext: buildPlainTemplateCiphertext(
            { directory: '/tmp/project', existingSessionId: 'session-inner' },
            { existingSessionId: 'session-outer' },
          ),
        },
      }), undefined, 'plain'
    );

    expect(parsed.ok).toBe(false);
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
      }, 'e2ee'
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
      }, 'e2ee'
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
      }, 'e2ee'
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
      }, 'e2ee'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.directory).toBe('/tmp/project');
    expect(parsed.value.prompt).toBe('Run secretbox while in dataKey mode');
  });

});
