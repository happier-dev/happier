import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Grok plugin manifest', () => {
  it('declares the native Agent, exact system tool, environment access, and CLI setup facts', () => {
    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.grok');
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual([expect.objectContaining({
      capability: 'process',
      scope: {
        executables: [{ kind: 'systemTool', id: 'grok-cli' }],
        envKeys: ['XAI_API_KEY'],
      },
    })]);
    expect(PLUGIN_MANIFEST.contributes.systemTools).toEqual([{
      id: 'grok-cli', title: 'Grok Build CLI', executableNames: ['grok'],
    }]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'grok', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          conversationRollback: true,
        },
      },
      cli: {
        executable: { binaryName: 'grok', knownUserBinDirSuffixes: ['.grok/bin', '.local/bin'], sourcePreference: 'system-first' },
        auth: {
          support: 'login_terminal',
          probe: { parser: 'unknown', backgroundChecks: 'safe', statusArgs: null, envVars: ['XAI_API_KEY'] },
          loginLaunches: [{ kind: 'primary', args: ['login'] }, { kind: 'device_code', args: ['login', '--device-auth'] }],
        },
      },
    });
  });
});
