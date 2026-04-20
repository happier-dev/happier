import { describe, expect, it } from 'vitest';

import { getProviderMessageMetaEnricher, resolveProviderOutgoingMessageMetaExtras } from '../adjunctAdapters/messageMetaRegistry.js';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from './claudeRemote.js';

describe('getProviderMessageMetaEnricher', () => {
  it('projects the Claude message-meta enricher and keeps other providers empty', () => {
    const enricher = getProviderMessageMetaEnricher('claude');
    expect(enricher?.buildOutgoingMessageMetaExtras).toEqual(buildClaudeRemoteOutgoingMessageMetaExtras);
    expect(enricher?.buildOutgoingMessageMetaExtras?.({
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSourcesV2: ['user', 'project'],
    })).toEqual(
      buildClaudeRemoteOutgoingMessageMetaExtras({
        claudeRemoteAgentSdkEnabled: false,
        claudeRemoteSettingSourcesV2: ['user', 'project'],
      }),
    );
    expect(getProviderMessageMetaEnricher('codex')).toEqual({});
  });

  it('delegates provider extras resolution through the canonical enricher', () => {
    expect(resolveProviderOutgoingMessageMetaExtras({
      agentId: 'claude',
      settings: {
        claudeRemoteSettingSourcesV2: ['project'],
        claudeRemoteDebugCategories: ['api'],
      },
      session: {},
    })).toEqual(
      buildClaudeRemoteOutgoingMessageMetaExtras({
        claudeRemoteSettingSourcesV2: ['project'],
        claudeRemoteDebugCategories: ['api'],
      }),
    );
  });
});
