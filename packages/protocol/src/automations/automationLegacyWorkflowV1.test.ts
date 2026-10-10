import { describe, expect, it } from 'vitest';
import { openAutomationTemplateStoredV1 } from './automationTemplateStoredV1.js';
import { AUTOMATION_TEMPLATE_V02_PLAIN } from './automationTemplateV02.testFixtures.js';
import {
  convertLegacyAutomationRecipeToInlineWorkflowV1,
} from './automationLegacyWorkflowV1.js';

describe('canonical legacy Automation inline conversion', () => {
  it.each([undefined, 'release-model'])('converts the real 0.2 omitted-Agent new-Session shape with model %s', (modelId) => {
    // ../0.2 e087d15a2f0cce1de6de8ef0895d9c8bcc035056: both codec and
    // execution parser allow omitted agent/backendTarget; spawn uses the catalog default.
    const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', prompt: 'Review',
        ...(modelId === undefined ? {} : { modelId, modelUpdatedAt: 13 }) },
    } });
    expect(converted).toMatchObject({ kind: 'available', project: { machineId: 'machine-1', directory: '/repo' },
      definition: { defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        conversation: { kind: 'fresh' },
        ...(modelId === undefined ? {} : { modelSelection: { v: 1, updatedAt: 13,
          ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId } } }),
      }, blocks: [{ document: { text: 'Review' } }] } });
  });
  it('retains the authenticated existing Session Agent and model qualification when the template omits its Agent', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'existing_session', template: { directory: '/ignored', existingSessionId: 'session-1', prompt: 'Review', modelId: 'codex-model' },
    }, session: { project: { machineId: 'machine-1', directory: '/actual' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    } } })).toMatchObject({ kind: 'available', definition: { defaults: {
      agentTarget: { identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { ref: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'codex-model' } },
    } } });
  });
  it('does not use default-Agent resolution to admit explicit unsupported spawn settings', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', prompt: 'Review',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    } })).toMatchObject({ kind: 'unavailable', code: 'legacy_conversion_unsupported', reason: 'spawn_unrepresentable' });
  });
  it.each(['new_session', 'existing_session'] as const)('refuses frozen %s framing that contradicts the template Session target', (targetType) => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType, template: { directory: '/repo', agent: 'claude', prompt: 'Review',
        ...(targetType === 'new_session' ? { existingSessionId: 'session-1' } : {}) },
    }, session: { project: { machineId: 'machine-1', directory: '/actual' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } } })).toMatchObject({ kind: 'unavailable', code: 'legacy_conversion_unsupported', reason: 'conversation_unrepresentable' });
  });
  it('preserves predecessor offline launch overrides for the existing Session owner', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'existing_session', template: { directory: '/ignored', agent: 'claude', existingSessionId: 'session-1', prompt: 'Review',
        profileId: 'incoming-profile', mcpSelection: { v: 1, managedServersEnabled: false,
          forceIncludeServerIds: ['release-server'], forceExcludeServerIds: [] },
        connectedServices: { v: 2, bindingsByServiceId: {} }, transcriptStorage: 'direct', terminal: { mode: 'plain' },
        windowsRemoteSessionLaunchMode: 'console', windowsRemoteSessionConsole: 'visible',
        windowsTerminalWindowName: 'Release', agentModeId: 'review' },
    }, session: { project: { machineId: 'machine-1', directory: '/actual' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, profileId: 'stale-profile',
    } } })).toMatchObject({ kind: 'available', project: { machineId: 'machine-1', directory: '/actual' }, definition: { defaults: {
      profileId: 'incoming-profile', mcpSelection: { managedServersEnabled: false, forceIncludeServerIds: ['release-server'] },
      connectedServices: { v: 2, bindingsByServiceId: {} }, transcriptStorage: 'direct', terminal: { mode: 'plain' },
      windowsRemoteSessionLaunchMode: 'console', windowsRemoteSessionConsole: 'visible', windowsTerminalWindowName: 'Release',
      acpSessionModeId: 'review',
    } } });
  });
  it('reacquires an inputless predecessor existing Session without manufacturing a turn', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'existing_session', template: { directory: '/repo', agent: 'claude', existingSessionId: 'session-1' },
    }, session: { project: { machineId: 'machine-1', directory: '/actual' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } } })).toMatchObject({ kind: 'available', definition: { blocks: [{ inputMode: 'none', document: { text: '' } }] } });
  });
  it('creates an inputless predecessor Session without manufacturing a prompt', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', agent: 'claude' },
    } })).toMatchObject({ kind: 'available', definition: { blocks: [{ inputMode: 'none', document: { text: '' } }] } });
  });
  it('preserves timestamped incoming controls for the existing Session runtime owner', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'existing_session', template: { directory: '/repo', agent: 'claude', existingSessionId: 'session-1', prompt: 'Review',
        permissionMode: 'acceptEdits', permissionModeUpdatedAt: 12, modelId: 'incoming-model', modelUpdatedAt: 13 },
    }, session: { project: { machineId: 'machine-1', directory: '/actual' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      permissionMode: 'read-only',
    } } })).toMatchObject({ kind: 'available', definition: { defaults: { permissionMode: 'acceptEdits', permissionModeUpdatedAt: 12,
      modelSelection: { ref: { modelId: 'incoming-model' }, updatedAt: 13 } } } });
  });
  it('keeps retained 0.2 prompt placeholders literal during Workflow conversion', () => {
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, accountMode: 'plain' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const prompt = 'Review {{input}} and preserve unmatched }} literally';
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { ...opened.template, prompt },
    } })).toMatchObject({ kind: 'available', definition: { blocks: [{ document: { text: prompt } }] } });
  });
  it('retains explicit automatic model selection rather than reviving a stale legacy model', () => {
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, accountMode: 'plain' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { ...opened.template, modelSelection: null, modelId: 'stale-model', modelUpdatedAt: 10 },
    } })).toMatchObject({ kind: 'available', definition: { defaults: { modelSelection: null } } });
  });
  it('preserves predecessor spawn environment through the canonical launch environment', () => {
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, accountMode: 'plain' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { ...opened.template, environmentVariables: { RELEASE_TOKEN: 'fixture' } },
    } })).toMatchObject({ kind: 'available', definition: { defaults: {
      launchEnvironment: { values: { RELEASE_TOKEN: 'fixture' }, unset: [] },
    } } });

  });
  it('resumes the native Agent conversation in a fresh Happier Session and preserves worktree creation', () => {
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, accountMode: 'plain' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Fields from the actual ../0.2 TemplateSchema and parseAutomationTemplateExecution at
    // dd2c54873fb2aca64a63c8c64cc256be35c9db7f; resume is passed to SpawnSessionOptions.resume.
    const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { ...opened.template, resume: 'native-agent-session',
        checkoutCreationDraft: { kind: 'git_worktree', displayName: 'release-check', baseRef: 'release/stable' },
        profileId: 'release-profile', transcriptStorage: 'direct', windowsRemoteSessionLaunchMode: 'console',
        windowsRemoteSessionConsole: 'visible', windowsTerminalWindowName: 'Release', agentModeId: 'review',
      },
    } });
    expect(converted).toMatchObject({ kind: 'available', definition: { defaults: {
      conversation: { kind: 'fresh' }, providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-agent-session' },
      workspace: { kind: 'new_worktree', source: { kind: 'original' }, displayName: 'release-check', baseRef: 'release/stable' },
      profileId: 'release-profile', transcriptStorage: 'direct', windowsRemoteSessionLaunchMode: 'console',
      windowsRemoteSessionConsole: 'visible', windowsTerminalWindowName: 'Release', acpSessionModeId: 'review',
    } } });
  });
  it('keeps an empty predecessor resume token equivalent to no native continuation', () => {
    const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', agent: 'claude', prompt: 'Review', resume: '' },
    } });
    expect(converted.kind).toBe('available');
    if (converted.kind !== 'available') return;
    expect(converted.definition.defaults.providerSessionResume).toBeUndefined();
  });
  it('maps the real 0.2 plain writer bytes to a validated inline target', () => {
    const opened = openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, accountMode: 'plain' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: opened.template,
    } })).toMatchObject({ kind: 'available', executionTarget: { kind: 'session' },
      project: { machineId: 'machine-1', directory: '/repo' }, definition: { version: 1,
        blocks: [{ document: { text: 'Review the release' } }] } });
  });
  it('preserves a separate display text without replacing the Agent prompt', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', agent: 'claude', prompt: 'native prompt', displayText: 'visible prompt' },
    } })).toMatchObject({ kind: 'available', definition: { blocks: [{ document: { text: 'native prompt', displayText: 'visible prompt' } }] } });
  });
  it.each([
    { field: 'resume', fields: { resume: 'native-session' } },
    { field: 'environmentVariables', fields: { environmentVariables: { TOKEN: 'retained-value' } } },
    { field: 'checkoutCreationDraft', fields: { checkoutCreationDraft: { kind: 'git_worktree', displayName: 'review', baseRef: 'main' } } },
  ] as const)('preserves existing Session $field launch intent through its canonical resume owner', ({ fields }) => {
    const converted = convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'existing_session', template: { directory: '/repo', agent: 'claude', prompt: 'Review',
        existingSessionId: 'session-1', ...fields },
    }, session: { project: { machineId: 'machine-1', directory: '/actual-session-cwd' }, executionSelection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } } });
    if ('checkoutCreationDraft' in fields) {
      expect(converted).toMatchObject({ kind: 'available', project: { directory: '/actual-session-cwd' } });
      if (converted.kind === 'available') expect(converted.definition.defaults.workspace).toBeUndefined();
    }
    else expect(converted).toMatchObject({ kind: 'available', definition: { defaults: {
      ...('resume' in fields ? { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: fields.resume } }
        : { launchEnvironment: { values: fields.environmentVariables, unset: [] } }),
    } } });
  });
  it.each(['mcp', 'acp', 'appServer'] as const)('preserves the predecessor Codex mode %s in the canonical runtime selection', (codexBackendMode) => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', agent: 'codex', prompt: 'Review', codexBackendMode },
    } })).toMatchObject({ kind: 'available', definition: { defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: codexBackendMode === 'mcp' ? 'appServer' : codexBackendMode } },
    } } });
  });
  it('normalizes the predecessor experimental Codex flag through the existing runtime descriptor owner', () => {
    expect(convertLegacyAutomationRecipeToInlineWorkflowV1({ machineId: 'machine-1', legacyTemplate: {
      targetType: 'new_session', template: { directory: '/repo', agent: 'codex', prompt: 'Review', experimentalCodexAcp: true },
    } })).toMatchObject({ kind: 'available', definition: { defaults: {
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
    } } });
  });
});
