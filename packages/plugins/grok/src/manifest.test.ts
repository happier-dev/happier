import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Grok plugin manifest', () => {
  it('publishes the xAI quota capability in the Connected Account manifest projection', () => {
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toContainEqual(expect.objectContaining({
      id: 'xai',
      capabilities: expect.arrayContaining(['usage']),
    }));
  });

  it('declares the native Agent, exact system tool, environment access, and CLI setup facts', () => {
    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.grok');
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([expect.objectContaining({
      capability: 'process',
      scope: {
        executables: [{ kind: 'systemTool', id: 'grok-cli' }],
        envKeys: expect.arrayContaining(['XAI_API_KEY']),
      },
    })]));
    expect(PLUGIN_MANIFEST.contributes.systemTools).toEqual([{
      id: 'grok-cli', title: 'Grok Build CLI', executableNames: ['grok'],
    }]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'grok', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: {
        skills: {
          delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
          nativeRoots: {
            user: [['.grok', 'skills'], ['.claude', 'skills'], ['.cursor', 'skills']],
            project: [['.grok', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.cursor', 'skills']],
          },
        },
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
          environmentVariables: ['XAI_API_KEY'],
          missingCredentialState: 'unknown',
          loginLaunches: [{ kind: 'primary', args: ['login'] }, { kind: 'device_code', args: ['login', '--device-auth'] }],
        },
      },
    });
  });
});
