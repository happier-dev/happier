import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from './manifest.js';
import { AGENT_MODEL_CONFIG, getAgentStaticModels } from './models.js';
import { AGENT_SESSION_MODE_DESCRIPTORS } from './sessionModes.js';
import { AGENT_AUTH_PROBE_CONFIG } from './auth.js';
import { AGENT_LOCAL_CLI_CONFIG } from './localCli.js';
import { PROVIDER_CLI_RUNTIME_SPECS } from './providers/providerCliRuntime.js';
import { AGENT_IDS } from './types.js';

describe('agy shared agent facts (EU-3)', () => {
  it('registers agy as a canonical agent id', () => {
    expect((AGENT_IDS as readonly string[]).includes('agy')).toBe(true);
  });

  it('declares agy core resume/session facts without claiming shared ACP/CLI identity', () => {
    const core = AGENTS_CORE['agy' as keyof typeof AGENTS_CORE] as unknown as Record<string, unknown> | undefined;
    expect(core).toBeDefined();
    expect(core).toMatchObject({
      id: 'agy',
      resume: { vendorResume: 'supported', vendorResumeIdField: 'agySessionId' },
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: { sessionListing: 'unsupported' },
    });
  });

  it('keeps interactive agy CLI system-first with vendor install guidance', () => {
    const spec = PROVIDER_CLI_RUNTIME_SPECS['agy' as keyof typeof PROVIDER_CLI_RUNTIME_SPECS] as unknown as Record<string, unknown> | undefined;
    expect(spec).toMatchObject({
      id: 'agy',
      title: 'Antigravity CLI',
      binaryName: 'agy',
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
    });
  });

  it('authenticates the managed ACP server from the local login terminal', () => {
    const localCli = AGENT_LOCAL_CLI_CONFIG['agy' as keyof typeof AGENT_LOCAL_CLI_CONFIG] as unknown as Record<string, unknown> | undefined;
    expect(localCli).toMatchObject({
      agentId: 'agy',
      authSupport: 'login_terminal',
      authLaunches: [{ kind: 'primary', target: 'happier_cli', args: ['agy', 'auth', 'login'] }],
    });
  });

  it('declares agy auth probe without ambient background CLI invocation', () => {
    const auth = AGENT_AUTH_PROBE_CONFIG['agy' as keyof typeof AGENT_AUTH_PROBE_CONFIG] as unknown as Record<string, unknown> | undefined;
    expect(auth).toBeDefined();
  });

  it('derives agy models/modes from negotiated ACP state', () => {
    const model = AGENT_MODEL_CONFIG['agy' as keyof typeof AGENT_MODEL_CONFIG] as unknown as Record<string, unknown> | undefined;
    expect(model).toMatchObject({ supportsSelection: true, dynamicProbe: 'auto' });
    const descriptor = AGENT_SESSION_MODE_DESCRIPTORS['agy' as keyof typeof AGENT_SESSION_MODE_DESCRIPTORS] as unknown as Record<string, unknown> | undefined;
    expect(descriptor).toMatchObject({ source: 'none', semantics: 'none' });
  });

  it('defines static models for Antigravity (agy) with context window sizes', () => {
    const agyModels = getAgentStaticModels('agy');
    expect(agyModels.length).toBe(7);
    expect(agyModels.map((m) => m.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'gpt-oss-120b',
    ]);

    expect(agyModels.find((m) => m.id === 'gemini-3.8-flash')?.contextWindowTokens).toBe(1_048_576);
    expect(agyModels.find((m) => m.id === 'gemini-3.7-flash')?.contextWindowTokens).toBe(1_048_576);
    expect(agyModels.find((m) => m.id === 'gemini-3.6-flash')?.contextWindowTokens).toBe(1_048_576);
    expect(agyModels.find((m) => m.id === 'gemini-3.1-pro')?.contextWindowTokens).toBe(1_048_576);
    expect(agyModels.find((m) => m.id === 'claude-sonnet-5-5')?.contextWindowTokens).toBe(1_000_000);
    expect(agyModels.find((m) => m.id === 'claude-opus-5-5')?.contextWindowTokens).toBe(1_000_000);
    expect(agyModels.find((m) => m.id === 'gpt-oss-120b')?.contextWindowTokens).toBe(131_072);
  });
});
