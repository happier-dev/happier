import { describe, expect, it } from 'vitest';

import type { SystemTaskJsonObject } from './spec.js';

describe('system task prompt payload contracts', () => {
  it('parses release-channel setup prompts and filters invalid managed installations', async () => {
    const {
      parseReleaseChannelSwitchForSetupPromptData,
    } = await import('./promptPayloadContracts.js');

    expect(parseReleaseChannelSwitchForSetupPromptData({
      targetReleaseChannel: ' preview ',
      currentDefaultReleaseChannel: ' stable ',
      targetServerUrl: ' https://relay.example.test ',
      managedReleaseChannels: [
        {
          releaseChannel: 'preview',
          label: 'Preview',
          version: '0.2.3-preview.1',
          installationId: 'preview-install',
          installationPath: '/managed/preview',
          invokerName: 'hprev',
          isDefault: false,
          onPath: true,
        },
        {
          releaseChannel: 'stable',
          label: '',
          installationId: 'stable-install',
          installationPath: '/managed/stable',
          invokerName: 'happier',
        },
      ],
    } satisfies SystemTaskJsonObject)).toEqual({
      targetReleaseChannel: 'preview',
      currentDefaultReleaseChannel: 'stable',
      targetServerUrl: 'https://relay.example.test',
      managedReleaseChannels: [{
        releaseChannel: 'preview',
        label: 'Preview',
        version: '0.2.3-preview.1',
        installationId: 'preview-install',
        installationPath: '/managed/preview',
        invokerName: 'hprev',
        isDefault: false,
        onPath: true,
      }],
    });
  });

  it('parses local background-service replacement prompts and filters invalid services', async () => {
    const {
      parseReplaceLocalBackgroundServicesPromptData,
    } = await import('./promptPayloadContracts.js');

    expect(parseReplaceLocalBackgroundServicesPromptData({
      targetServerUrl: ' https://relay.example.test ',
      targetReleaseChannel: ' preview ',
      services: [
        {
          label: 'com.happier.cli.daemon.preview.default',
          releaseChannel: 'preview',
          targetMode: 'default-following',
          running: true,
          serverUrl: 'https://relay.example.test',
        },
        {
          label: '',
          releaseChannel: 'stable',
        },
      ],
    } satisfies SystemTaskJsonObject)).toEqual({
      targetServerUrl: 'https://relay.example.test',
      targetReleaseChannel: 'preview',
      services: [{
        label: 'com.happier.cli.daemon.preview.default',
        releaseChannel: 'preview',
        targetMode: 'default-following',
        running: true,
        serverUrl: 'https://relay.example.test',
      }],
    });
  });

  it('parses manual relay-runtime takeover prompts for local setup', async () => {
    const {
      parseTakeOverManualRelayRuntimeForSetupPromptData,
    } = await import('./promptPayloadContracts.js');

    expect(parseTakeOverManualRelayRuntimeForSetupPromptData({
      targetServerUrl: ' https://relay.example.test ',
      targetReleaseChannel: ' preview ',
      currentReleaseChannel: ' stable ',
      currentCliVersion: ' 0.2.0 ',
    } satisfies SystemTaskJsonObject)).toEqual({
      targetServerUrl: 'https://relay.example.test',
      targetReleaseChannel: 'preview',
      currentReleaseChannel: 'stable',
      currentCliVersion: '0.2.0',
    });
  });

  it('parses remote provisioning prompt payloads', async () => {
    const {
      parseApproveRemoteProvisioningPromptData,
      parseReplaceRemoteBackgroundServicesPromptData,
      parseSshPasswordPromptData,
      parseSshTrustPromptData,
    } = await import('./promptPayloadContracts.js');

    expect(parseSshTrustPromptData('ssh.replaceHostKey', {
      host: ' remote.example.test ',
      keyType: ' ssh-ed25519 ',
      fingerprint: ' SHA256:new ',
      existingFingerprint: ' SHA256:old ',
    } satisfies SystemTaskJsonObject)).toEqual({
      kind: 'ssh.replaceHostKey',
      host: 'remote.example.test',
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:new',
      existingFingerprint: 'SHA256:old',
    });

    expect(parseApproveRemoteProvisioningPromptData({
      publicKey: ' ssh-ed25519 AAAA... ',
    } satisfies SystemTaskJsonObject)).toEqual({
      publicKey: 'ssh-ed25519 AAAA...',
    });

    expect(parseSshPasswordPromptData({
      target: ' remote-user@remote.example.test ',
    } satisfies SystemTaskJsonObject)).toEqual({
      target: 'remote-user@remote.example.test',
    });

    expect(parseReplaceRemoteBackgroundServicesPromptData({
      targetServerUrl: ' https://relay.example.test ',
      targetReleaseChannel: ' dev ',
      services: [{
        label: 'happier-daemon.dev.default',
        releaseChannel: 'dev',
        targetMode: 'pinned',
        running: false,
      }],
    } satisfies SystemTaskJsonObject)).toEqual({
      targetServerUrl: 'https://relay.example.test',
      targetReleaseChannel: 'dev',
      services: [{
        label: 'happier-daemon.dev.default',
        releaseChannel: 'dev',
        targetMode: 'pinned',
        running: false,
      }],
    });
  });

  it('parses SSH passphrase and keyboard-interactive prompt payloads', async () => {
    const {
      parseSshKeyboardInteractivePromptData,
      parseSshPrivateKeyPassphrasePromptData,
    } = await import('./promptPayloadContracts.js');

    expect(parseSshPrivateKeyPassphrasePromptData({
      promptId: ' prompt-1 ',
      host: ' example.test ',
      port: 2222,
      username: ' dev ',
      keyLabel: ' id_ed25519 ',
      attemptsRemaining: 2,
    } satisfies SystemTaskJsonObject)).toEqual({
      promptId: 'prompt-1',
      host: 'example.test',
      port: 2222,
      username: 'dev',
      keyLabel: 'id_ed25519',
      attemptsRemaining: 2,
    });

    expect(parseSshKeyboardInteractivePromptData({
      promptId: ' prompt-2 ',
      host: ' example.test ',
      port: 22,
      username: ' dev ',
      name: ' MFA ',
      instruction: ' Enter code ',
      prompts: [
        { id: '0', label: ' OTP ', echo: false },
        { id: '1', label: ' visible ', echo: true },
        { id: '', label: 'invalid', echo: true },
      ],
    } satisfies SystemTaskJsonObject)).toEqual({
      promptId: 'prompt-2',
      host: 'example.test',
      port: 22,
      username: 'dev',
      name: 'MFA',
      instruction: 'Enter code',
      prompts: [
        { id: '0', label: 'OTP', echo: false },
        { id: '1', label: 'visible', echo: true },
      ],
    });
  });
});
