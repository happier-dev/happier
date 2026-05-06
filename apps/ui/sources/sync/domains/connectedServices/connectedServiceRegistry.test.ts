import { describe, expect, it } from 'vitest';

import * as protocol from '@happier-dev/protocol';

import { getConnectedServiceRegistryEntry } from './connectedServiceRegistry';

const protocolDescriptors = protocol as typeof protocol & Readonly<{
  getConnectedAccountDescriptor?: (id: string) => Readonly<{
    displayKey?: string;
    tokenSetup?: { tokenKind: 'api-key' | 'setup-token' | 'personal-access-token' | 'api-token'; setupUrl?: string };
    ui: { connectCommand: string };
  }> | null;
}>;

describe('connectedServiceRegistry', () => {
  it('exposes an explicit in-app browser oauth method for openai-codex (native)', () => {
    const entry = getConnectedServiceRegistryEntry('openai-codex');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('device');
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
  });

  it('exposes an explicit in-app browser oauth method for claude-subscription (native)', () => {
    const entry = getConnectedServiceRegistryEntry('claude-subscription');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
    expect(entry.displayNameKey).toBe('connectedServices.serviceNames.claudeSubscription');
    expect(entry.oauthPasteCopyKeyPrefix).toBe('connectedServices.oauthPaste.providerOverrides.claudeSubscription');
  });

  it('exposes an explicit in-app browser oauth method for gemini (native)', () => {
    const entry = getConnectedServiceRegistryEntry('gemini');
    expect(entry.supportsOauth).toBe(true);
    expect(entry.oauthAddActionModes ?? []).toContain('paste');
    expect(entry.oauthAddActionModes ?? []).toContain('browser');
  });

  it('projects service UI metadata from connected account descriptors', () => {
    const descriptor = protocolDescriptors.getConnectedAccountDescriptor?.('openai');
    const entry = getConnectedServiceRegistryEntry('openai');

    expect(entry.connectCommand).toBe(descriptor?.ui.connectCommand);
    expect(entry.displayNameKey).toBe(descriptor?.displayKey);
    expect(entry.supportsToken).toBe(true);
    expect(entry.tokenKind).toBe(descriptor?.tokenSetup?.tokenKind);
  });

  it('projects GitHub PAT setup metadata from descriptors', () => {
    const descriptor = protocolDescriptors.getConnectedAccountDescriptor?.('github');
    const entry = getConnectedServiceRegistryEntry('github');

    expect(entry.connectCommand).toBe('happier connect github --token');
    expect(entry.displayNameKey).toBe(descriptor?.displayKey);
    expect(entry.supportsOauth).toBe(false);
    expect(entry.supportsToken).toBe(true);
    expect(entry.tokenKind).toBe('personal-access-token');
    expect(entry.tokenSetupUrl).toBe(descriptor?.tokenSetup?.setupUrl);
    expect(entry).toMatchObject({
      tokenPromptLabelKey: descriptor?.tokenSetup?.promptLabelKey,
      tokenMissingValueErrorKey: descriptor?.tokenSetup?.missingValueErrorKey,
    });
  });

  it('projects Bitbucket API-token setup metadata from descriptors', () => {
    const descriptor = protocolDescriptors.getConnectedAccountDescriptor?.('bitbucket');
    const entry = getConnectedServiceRegistryEntry('bitbucket');

    expect(entry.connectCommand).toBe('happier connect bitbucket --token');
    expect(entry.displayNameKey).toBe(descriptor?.displayKey);
    expect(entry.supportsOauth).toBe(false);
    expect(entry.supportsToken).toBe(true);
    expect(entry.tokenKind).toBe('api-token');
    expect(entry.tokenSetupUrl).toBe(descriptor?.tokenSetup?.setupUrl);
    expect(entry).toMatchObject({
      tokenPromptLabelKey: descriptor?.tokenSetup?.promptLabelKey,
      tokenMissingValueErrorKey: descriptor?.tokenSetup?.missingValueErrorKey,
    });
  });
});
