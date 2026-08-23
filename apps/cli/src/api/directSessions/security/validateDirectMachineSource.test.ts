import { describe, expect, it } from 'vitest';

import { validateDirectMachineSource } from './validateDirectMachineSource';

describe('validateDirectMachineSource', () => {
  it('rejects Codex connectedService source ids with path traversal segments', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: '../escape',
        },
        env: {},
      }),
    ).toEqual({ ok: false, error: 'invalid connectedServiceId' });
  });

  it('accepts safe Codex connectedService source ids', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        env: {},
      }),
    ).toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });

  it('normalizes Claude configDir against env HOME before validating the source', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'claude',
        source: {
          kind: 'claudeConfig',
          configDir: '~/.claude',
        },
        env: {
          HOME: '/Users/tester',
          HAPPIER_CLAUDE_CONFIG_DIR: '~/.claude',
        },
      }),
    ).toEqual({
      ok: true,
      source: {
        kind: 'claudeConfig',
        configDir: '/Users/tester/.claude',
      },
    });
  });

  it('accepts a pi piAgentDir source and resolves the agentDir from PI_CODING_AGENT_DIR', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'pi',
        source: { kind: 'piAgentDir' },
        env: {
          HOME: '/Users/tester',
          PI_CODING_AGENT_DIR: '~/.pi/agent',
        },
      }),
    ).toEqual({
      ok: true,
      source: {
        kind: 'piAgentDir',
        agentDir: '/Users/tester/.pi/agent',
      },
    });
  });

  it('rejects a pi agentDir override that does not match the daemon-configured dir', () => {
    const result = validateDirectMachineSource({
      providerId: 'pi',
      source: { kind: 'piAgentDir', agentDir: '/etc/passwd' },
      env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent-configured' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('source agentDir override is not allowed');
    }
  });

  it('rejects a pi provider with a mismatched source kind', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'pi',
        source: { kind: 'claudeConfig', configDir: '/tmp/.claude' },
        env: {},
      }),
    ).toEqual({ ok: false, error: 'provider/source mismatch' });
  });
});
