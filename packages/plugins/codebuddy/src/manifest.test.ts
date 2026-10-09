import { describe, expect, it } from 'vitest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { PLUGIN_MANIFEST } from './manifest.js';
import { AGENT_DEFINITION } from './agent/definition.js';

describe('CodeBuddy plugin', () => {
  it('admits the full generic ACP runtime and native approval presets', () => {
    expect(parsePluginManifest(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    expect(agent).toMatchObject({
      id: 'codebuddy', primary: 'sessions',
      runtime: {
        kind: 'acp',
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'codebuddy-cli' }, args: ['--acp'] },
        definition: {
          modelConfigOptionId: 'model',
          permissionModeMapping: { default: null, 'read-only': 'dontAsk', 'safe-yolo': 'auto', yolo: 'bypassPermissions', plan: 'plan' },
          mcp: { policy: 'pass_through' },
        },
      },
      cli: {
        executable: { binaryName: 'codebuddy', sourcePreference: 'system-first' },
        install: { managed: { kind: 'managed_package', packageName: '@tencent-ai/codebuddy-code', binaryName: 'codebuddy' } },
        auth: { support: 'login_terminal', environmentVariables: ['CODEBUDDY_API_KEY'], missingCredentialState: 'unknown', loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login\r' }] },
      },
    });
    expect(agent).not.toHaveProperty('factory');
    expect(agent.cli.auth).not.toHaveProperty('probe');
    expect(agent.capabilities).toEqual(projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
      sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'followUp'], cancel: true, configuration: true, executionRunContext: { versions: [1] } },
    }));
    expect(agent.capabilities).toMatchObject({ surfaces: ['terminal'], tools: { delivery: 'native_mcp' } });
  });

  it('preserves experimental storage, model and media contracts through its definition', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      core: {
        resume: { vendorResume: 'supported', vendorResumeIdField: 'codebuddySessionId' },
        sessionStorage: { direct: false, persisted: true },
        sessionCapabilities: { sessionListing: 'unsupported' },
        tools: { delivery: 'native_mcp', support: 'experimental' },
        media: { acceptsImageInput: 'experimental', emitsSessionMedia: 'supported', nativeImageGeneration: 'unsupported' },
      },
      sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
      modelConfig: { supportsSelection: true, supportsFreeform: false, acpModelConfigOptionId: 'model', acpModelSetMethod: 'config_option' },
    });
  });
});
