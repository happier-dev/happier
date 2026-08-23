import { describe, expect, it } from 'vitest';
import {
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import { resolveLinkedExternalSessionQualifiedIdentity } from './qualifiedLinkIdentity';

const LEGACY_METADATA = {
  directSessionV1: {
    v: 1,
    providerId: 'claude',
    machineId: 'machine-legacy',
    remoteSessionId: 'remote-legacy',
    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
  },
};

const AGENT_IDENTITY: PluginContributionIdentityV1 = {
  pluginId: 'com.example.external-agent',
  localId: 'assistant',
};

describe('resolveLinkedExternalSessionQualifiedIdentity', () => {
  it('preserves a legacy link while unavailable and resolves the same stable identity after reinstall', async () => {
    const legacy = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(LEGACY_METADATA);
    expect(legacy).not.toBeNull();

    const unavailable = await resolveLinkedExternalSessionQualifiedIdentity(legacy!, {
      resolveCurrentAgent: async () => null,
    });
    expect(unavailable).toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    });
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(LEGACY_METADATA)).toEqual(legacy);

    const installed = await resolveLinkedExternalSessionQualifiedIdentity(legacy!, {
      resolveCurrentAgent: async () => ({
        identity: AGENT_IDENTITY,
        sourceKinds: ['claudeConfig'],
      }),
    });
    expect(installed).toEqual({
      ok: true,
      link: {
        ...legacy,
        qualifiedIdentity: {
          v: 1,
          agent: AGENT_IDENTITY,
          source: { kind: 'claudeConfig', contractVersion: 1 },
        },
      },
      writeForwardRequired: true,
    });
    if (!installed.ok) throw new Error('expected installed identity');

    const uninstalledAgain = await resolveLinkedExternalSessionQualifiedIdentity(installed.link, {
      resolveCurrentAgent: async () => null,
    });
    expect(uninstalledAgain).toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    });

    const reinstalled = await resolveLinkedExternalSessionQualifiedIdentity(installed.link, {
      resolveCurrentAgent: async () => ({
        identity: AGENT_IDENTITY,
        sourceKinds: ['claudeConfig'],
      }),
    });
    expect(reinstalled).toEqual({
      ok: true,
      link: installed.link,
      writeForwardRequired: false,
    });
  });

  it('does not let a different plugin claim a persisted qualified link', async () => {
    const legacy = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(LEGACY_METADATA)!;
    const qualified = await resolveLinkedExternalSessionQualifiedIdentity(legacy, {
      resolveCurrentAgent: async () => ({ identity: AGENT_IDENTITY, sourceKinds: ['claudeConfig'] }),
    });
    if (!qualified.ok) throw new Error('expected qualified identity');

    await expect(resolveLinkedExternalSessionQualifiedIdentity(qualified.link, {
      resolveCurrentAgent: async () => ({
        identity: { pluginId: 'com.example.replacement', localId: 'assistant' },
        sourceKinds: ['claudeConfig'],
      }),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_qualified_agent_unavailable',
    });
  });

  it('rejects a source kind that the current manifest Agent does not declare', async () => {
    const legacy = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(LEGACY_METADATA)!;

    await expect(resolveLinkedExternalSessionQualifiedIdentity(legacy, {
      resolveCurrentAgent: async () => ({ identity: AGENT_IDENTITY, sourceKinds: ['codexHome'] }),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_source_contract_unavailable',
    });
  });
});
