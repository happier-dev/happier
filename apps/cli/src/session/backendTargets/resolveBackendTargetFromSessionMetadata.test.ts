import { describe, expect, it } from 'vitest';

import {
  resolveBackendTargetFromSessionMetadata,
  resolveExplicitBackendTargetFromSessionMetadata,
} from './resolveBackendTargetFromSessionMetadata';

describe('resolveBackendTargetFromSessionMetadata', () => {
  it('prefers configured ACP backend metadata over runtime descriptor metadata', () => {
    expect(resolveBackendTargetFromSessionMetadata({
      acpConfiguredBackendV1: {
        v: 1,
        backendId: 'review-bot',
        title: 'Review Bot',
        updatedAt: 10,
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
    })).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('uses runtime descriptor provider metadata before legacy agent metadata', () => {
    expect(resolveBackendTargetFromSessionMetadata({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
        },
      },
      flavor: 'claude',
    })).toEqual({
      kind: 'backend',
      backendId: 'opencode',
      sourceKind: 'built_in',
    });
  });

  it('derives the Oh My Pi runtime target from structured durable identity', () => {
    expect(resolveBackendTargetFromSessionMetadata({
      runtimeDescriptorV1: {
        v: 1,
        agentIdentity: {
          pluginId: 'happier.agent.ohmypi',
          localId: 'ohmypi',
        },
        agent: {
          providerSessionId: 'omp_1',
        },
      },
      flavor: 'claude',
    })).toEqual({
      kind: 'backend',
      backendId: 'ohMyPi',
      sourceKind: 'built_in',
    });
  });

  it('does not invent a default target when explicit metadata is absent', () => {
    expect(resolveExplicitBackendTargetFromSessionMetadata({})).toBeNull();
    expect(resolveExplicitBackendTargetFromSessionMetadata({ flavor: 'claude' })).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
  });
});
