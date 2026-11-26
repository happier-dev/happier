import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { AGENT_DEFINITION } from './agent/definition.js';

describe('Antigravity plugin manifest', () => {
  it('round-trips through canonical Plugin Manifest v2 ingestion', () => {
    const objectIngestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const jsonIngestion = ingestPluginManifestV2(JSON.parse(JSON.stringify(PLUGIN_MANIFEST)));

    expect(objectIngestion, JSON.stringify(objectIngestion)).toMatchObject({ ok: true });
    expect(jsonIngestion).toEqual(objectIngestion);
  });

  it('declares host-owned ACP as the sole Antigravity session runtime', () => {
    expect(AGENT_DEFINITION.core.sessionCapabilities).toMatchObject({
      usageLimitRecovery: { checkNow: 'supported' },
    });
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.agent.antigravity',
      entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
      hostAccess: {
        required: expect.arrayContaining([expect.objectContaining({
          id: 'antigravity-external-session-transcripts',
          capability: 'filesystem',
          scope: {
            locations: [{ root: 'workspace' }],
            access: ['read'],
          },
        }), expect.objectContaining({
          id: 'antigravity-cli-process',
          capability: 'process',
          scope: {
            executables: [{ kind: 'systemTool', id: 'antigravity-cli' }],
            envKeys: ['GEMINI_HOME', 'GEMINI_API_KEY', 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'],
          },
        })]),
        optional: [],
      },
    });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    const [agent, ...others] = PLUGIN_MANIFEST.contributes.agents;
    expect(others).toEqual([]);
    expect(agent).toMatchObject({
      id: 'antigravity',
      title: 'Antigravity',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      connectedAccounts: [
        { purpose: 'model_upstream', service: 'antigravity-account', required: false, materializationKinds: ['files', 'environment'], credentialKinds: ['oauth'] },
        { purpose: 'gemini-api-key', required: false, materializationKinds: ['environment'], credentialKinds: ['token'] },
      ],
      capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, executionRunContext: { versions: [1] } } },
      surfaces: { externalSession: { externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [expect.objectContaining({ sourceKind: 'antigravityCliPrint', contentSearch: true })] } },
    });
  });

  it('runs only the user-installed agy CLI and declares no managed ACP server', () => {
    expect(PLUGIN_MANIFEST.contributes.managedDependencies ?? []).toEqual([]);
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toMatch(/agy-acp-server|agy_acp_server|managedDependency/u);
    expect(PLUGIN_MANIFEST.hostAccess.required.map(request => request.id)).not.toContain('antigravity-acp-process');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('agentSettings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('settings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
  });
});
