import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { GEMINI_PLUGIN } from '../../manifest.js';

// Public host services are the boundary; the provider's ACP flag owner remains real.
describe('Gemini native preflight catalogs', () => {
  it('uses the observed native ACP flag through declared host execution', async () => {
    const activation = await createPluginTestkit({ manifest: GEMINI_PLUGIN.manifest, module: { activate: GEMINI_PLUGIN.activate } });
    const preflight: AgentPreflightSessionControlsContributionV1 | undefined = activation.registration('agents', 'gemini')?.preflightSessionControls;
    await activation.dispose();
    expect(preflight?.probeCatalogs).toBeTypeOf('function');
    const runDeclaredSystemToolCommand = vi.fn(async () => ({ ok: true, stdout: 'Usage: gemini --experimental-acp', stderr: '', exitCode: 0 }));
    const probeDeclaredAcpCatalogs = vi.fn(async () => ({ commands: [{ name: 'review', description: 'Review project' }], skills: null }));
    const context = {
      cwd: '/project', signal: new AbortController().signal, environment: { GEMINI_API_KEY: true }, accountSettings: null,
      runDeclaredSystemToolCommand, probeDeclaredAcpCatalogs,
      resolveDeclaredSystemTool: async () => { throw new Error('Native managed service is not used by this fixture'); },
      withDeclaredManagedService: async () => { throw new Error('Native managed service is not used by this fixture'); },
      withDeclaredJsonRpcClient: async () => { throw new Error('Provider does not own the ACP parser'); },
    } satisfies AgentPreflightSessionControlsProbeContextV1;
    await expect(preflight?.probeCatalogs?.(context)).resolves.toEqual({ commands: [{ name: 'review', description: 'Review project' }], skills: null });
    expect(runDeclaredSystemToolCommand).toHaveBeenCalledWith({ toolId: 'gemini-cli', args: ['--help'] });
    expect(probeDeclaredAcpCatalogs).toHaveBeenCalledWith({ toolId: 'gemini-cli', args: ['--experimental-acp'] });
  });
});
