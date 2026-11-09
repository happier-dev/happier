import { describe, expect, it } from 'vitest';
import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  GROK_PREFLIGHT_SESSION_CONTROLS,
  parseGrokModelsOutput,
} from './models.js';

describe('parseGrokModelsOutput', () => {
  it('returns only provider-advertised model identities from the Grok models command', () => {
    expect(parseGrokModelsOutput(`
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
    grok-code-fast-1
`)).toEqual([
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
    ]);
  });

  it('fails closed for missing, malformed, or duplicate model rows', () => {
    expect(parseGrokModelsOutput('Available models:\n')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * ../../bad (default)')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * grok-4.5\n  grok-4.5')).toBeNull();
  });
});

describe('GROK_PREFLIGHT_SESSION_CONTROLS', () => {
  it.each([
    ['subscription', false], ['api-key', false], ['subscription', true],
  ] as const)('authenticates selected %s through ACP while withholding unverified rows (transport fails=%s)', async (mode, transportFails) => {
    const requests: unknown[] = [];
    const context: AgentPreflightSessionControlsProbeContextV1 = {
      cwd: '/fake-workspace', accountSettings: null, environment: {},
      nonblankEnvironment: { GROK_CONNECTED_ACCOUNT_MODE: true, GROK_OAUTH2_ISSUER: mode === 'subscription' },
      signal: new AbortController().signal,
      async resolveDeclaredSystemTool() { throw new Error('Unexpected resolution'); },
      async runDeclaredSystemToolCommand() { throw new Error('Selected mode must use ACP'); },
      async probeDeclaredAcpCatalogs() { throw new Error('Unexpected catalog request'); },
      async withDeclaredJsonRpcClient() { throw new Error('Unexpected raw client'); },
      async withDeclaredManagedService() { throw new Error('Unexpected managed service'); },
      async probeDeclaredAcpSessionControls(request) {
        requests.push(request);
        if (transportFails) throw new Error('Fake native transport unavailable');
        return { models: [{ id: 'bundled-unverified', name: 'Bundled model' }], modes: null, configOptions: null };
      },
    };
    const contribution: AgentPreflightSessionControlsContributionV1 = GROK_PREFLIGHT_SESSION_CONTROLS;
    if (!contribution.probeModels) throw new Error('Selected Grok model probe unavailable');
    expect(await contribution.probeModels(context)).toMatchObject({
      availableModels: [], source: 'unavailable', catalogObserved: true, refreshError: true,
    });
    expect(requests).toEqual([GROK_PREFLIGHT_SESSION_CONTROLS.catalogs.command]);
  });

  it('declares the native command while leaving execution to the host', () => {
    const models = GROK_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({
      toolId: 'grok-cli',
      args: ['models'],
      ci: 'omit',
    });
    expect(models?.parseOutput?.({
      ok: true,
      stdout: 'Available models:\n  * grok-4.5 (default)\n',
      stderr: '',
      exitCode: 0,
    })).toEqual([{ id: 'grok-4.5', name: 'Grok 4.5' }]);
  });
});
