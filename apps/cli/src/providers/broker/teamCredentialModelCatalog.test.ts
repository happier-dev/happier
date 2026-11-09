import { describe, expect, it } from 'vitest';

import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';

import {
  createTeamCredentialExternalModelCatalog,
  createTeamCredentialModelCatalogResolver,
} from './teamCredentialModelCatalog';

const application = {
  agentTargetKey: 'agent:codex',
  implementationIdentity: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  endpointTemplateId: 'cliproxyapi-openai-responses',
  protocol: 'openai-responses',
} as const;

function row(input: Readonly<{
  modelId: string;
  aliases?: readonly string[];
  sourceRevision?: string;
}>): TeamCredentialProviderModelCatalogEntryV1 {
  return {
    selection: {
      kind: 'team_credential_provider_model',
      resourceId: 'resource-a',
      teamId: 'team-a',
      expectedResourceRevision: 7,
      agentTargetKey: application.agentTargetKey,
      modelId: input.modelId,
      deliveryMode: 'brokered',
    },
    descriptor: {
      id: input.modelId,
      name: input.modelId,
      aliases: [...(input.aliases ?? [])],
      capabilities: { reasoningControls: 'supported' },
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      }],
    },
    application,
    sourceRevision: input.sourceRevision ?? 'source-revision-a',
    availability: 'available',
  };
}

describe('createTeamCredentialModelCatalogResolver', () => {
  it('resolves an exact canonical model and an explicitly published alias', () => {
    const resolver = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 7,
      application,
      rows: [row({ modelId: 'gpt-5.3-codex', aliases: ['codex-current'] })],
    });

    expect(resolver?.resolveCanonicalModelId('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(resolver?.resolveCanonicalModelId('codex-current')).toBe('gpt-5.3-codex');
    expect(resolver?.resolveCanonicalModelId('unknown')).toBeNull();
  });

  it('fails closed for an ambiguous alias or a source revision collision', () => {
    expect(createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 7,
      application,
      rows: [
        row({ modelId: 'model-a', aliases: ['shared'] }),
        row({ modelId: 'model-b', aliases: ['shared'] }),
      ],
    })?.resolveCanonicalModelId('shared')).toBeNull();

    expect(createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 7,
      application,
      rows: [
        row({ modelId: 'model-a' }),
        row({ modelId: 'model-b', sourceRevision: 'source-revision-b' }),
      ],
    })).toBeNull();
  });

  it('rejects stale resource/application rows and preserves safe model facts', () => {
    const stale = row({ modelId: 'model-a' });
    expect(createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 8,
      application,
      rows: [stale],
    })).toBeNull();
    expect(createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 7,
      application: { ...application, endpointTemplateId: 'other' },
      rows: [stale],
    })).toBeNull();

    const resolver = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a',
      resourceRevision: 7,
      application,
      rows: [stale],
    });
    expect(resolver?.rows[0]?.descriptor).toEqual(stale.descriptor);
    expect(resolver?.rows[0]).not.toHaveProperty('connectionId');
    expect(resolver?.rows[0]).not.toHaveProperty('endpointUrl');
    expect(resolver?.rows[0]).not.toHaveProperty('credential');
  });
});

describe('createTeamCredentialExternalModelCatalog', () => {
  it('unions current exact-application catalogs and deduplicates byte-equivalent model ids', () => {
    const responses = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application,
      rows: [row({ modelId: 'shared' }), row({ modelId: 'responses-only' })],
    });
    const chatApplication = {
      ...application,
      endpointTemplateId: 'cliproxyapi-openai-chat',
      protocol: 'openai-chat' as const,
    };
    const chat = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application: chatApplication,
      rows: [
        { ...row({ modelId: 'shared' }), application: chatApplication },
        { ...row({ modelId: 'chat-only' }), application: chatApplication },
      ],
    });

    const catalog = createTeamCredentialExternalModelCatalog([responses!, chat!]);

    expect(catalog?.applications).toEqual([application, chatApplication]);
    expect(catalog?.models.map(({ id }) => id)).toEqual(['shared', 'responses-only', 'chat-only']);
    expect(catalog?.resolveCanonicalModelId('shared')).toBe('shared');
  });

  it('retains the same canonical model when protocol presentations use different labels', () => {
    const responses = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application,
      rows: [row({ modelId: 'conflict' }), row({ modelId: 'safe' })],
    })!;
    const chatApplication = {
      ...application,
      endpointTemplateId: 'cliproxyapi-openai-chat',
      protocol: 'openai-chat' as const,
    };
    const conflictingRow = {
      ...row({ modelId: 'conflict' }),
      descriptor: { ...row({ modelId: 'conflict' }).descriptor, name: 'Different bytes' },
      application: chatApplication,
    };
    const chat = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application: chatApplication,
      rows: [conflictingRow],
    })!;

    expect(createTeamCredentialExternalModelCatalog([responses, chat])?.models.map(({ id }) => id))
      .toEqual(['conflict', 'safe']);
    const conflictOnly = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application,
      rows: [row({ modelId: 'conflict' })],
    })!;
    expect(createTeamCredentialExternalModelCatalog([conflictOnly, chat])?.resolveCanonicalModelId('conflict'))
      .toBe('conflict');
  });

  it('keeps alias collision detection across every protocol presentation of a canonical model', () => {
    const responses = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application,
      rows: [row({ modelId: 'model-a', aliases: ['shared'] }), row({ modelId: 'model-b' })],
    })!;
    const chatApplication = { ...application, endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat' as const };
    const chat = createTeamCredentialModelCatalogResolver({
      resourceId: 'resource-a', resourceRevision: 7, application: chatApplication,
      rows: [{ ...row({ modelId: 'model-b', aliases: ['shared'] }), application: chatApplication }],
    })!;

    const catalog = createTeamCredentialExternalModelCatalog([responses, chat]);
    expect(catalog?.models.map(({ id }) => id)).toEqual(['model-a', 'model-b']);
    expect(catalog?.resolveCanonicalModelId('shared')).toBeNull();
  });
});
