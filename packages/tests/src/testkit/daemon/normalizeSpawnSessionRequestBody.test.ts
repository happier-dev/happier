import { describe, expect, it } from 'vitest';

import { normalizeSpawnSessionRequestBody } from './normalizeSpawnSessionRequestBody';

describe('normalizeSpawnSessionRequestBody', () => {
  it('adds backendTarget for a built-in agent when missing', () => {
    expect(normalizeSpawnSessionRequestBody({
      directory: '/tmp/workspace',
      agent: 'codex',
      resume: true,
    })).toEqual({
      directory: '/tmp/workspace',
      agent: 'codex',
      resume: true,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
  });

  it('defaults the agent to claude when missing', () => {
    expect(normalizeSpawnSessionRequestBody({
      directory: '/tmp/workspace',
    })).toEqual({
      directory: '/tmp/workspace',
      agent: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('preserves explicit backendTarget as-is', () => {
    expect(normalizeSpawnSessionRequestBody({
      directory: '/tmp/workspace',
      agent: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    })).toEqual({
      directory: '/tmp/workspace',
      agent: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    });
  });
});
