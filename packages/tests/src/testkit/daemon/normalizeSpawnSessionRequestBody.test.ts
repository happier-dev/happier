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
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    });
  });

  it('defaults the agent to claude when missing', () => {
    expect(normalizeSpawnSessionRequestBody({
      directory: '/tmp/workspace',
    })).toEqual({
      directory: '/tmp/workspace',
      agent: 'claude',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    });
  });

  it('canonicalizes explicit V1 backendTarget carriers to the daemon V2 transport shape', () => {
    expect(normalizeSpawnSessionRequestBody({
      directory: '/tmp/workspace',
      agent: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    })).toEqual({
      directory: '/tmp/workspace',
      agent: 'customAcp',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });
  });
});
