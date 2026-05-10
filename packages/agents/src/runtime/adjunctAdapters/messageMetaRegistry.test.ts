import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildClaudeRemoteOutgoingMessageMetaExtras } from '../../providers/claude/messageMeta.js';
import {
  getProviderMessageMetaEnricher,
  resolveProviderOutgoingMessageMetaExtras,
} from './messageMetaRegistry.js';

describe('getProviderMessageMetaEnricher', () => {
  it('keeps provider branching out of the shared message-meta registry', () => {
    const registrySource = readFileSync(
      fileURLToPath(new URL('./messageMetaRegistry.ts', import.meta.url)),
      'utf8',
    );

    expect(registrySource).not.toMatch(/\bswitch\s*\(/);
    expect(registrySource).not.toMatch(/\bcase\s+['"]claude['"]/);
    expect(registrySource).not.toMatch(/['"]claude['"]/);
    expect(registrySource).not.toMatch(/providers\//);
  });

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
