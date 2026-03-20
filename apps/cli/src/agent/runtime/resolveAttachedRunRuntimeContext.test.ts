import { describe, expect, it } from 'vitest';

import { resolveAttachedRunRuntimeContext } from '@/agent/runtime/resolveAttachedRunRuntimeContext';

describe('resolveAttachedRunRuntimeContext', () => {
  it('prefers the attached session metadata snapshot over local startup metadata', () => {
    const attachedMetadata = {
      path: '/srv/attached-workspace',
      profileId: 'profile-attached',
    };

    const resolved = resolveAttachedRunRuntimeContext({
      session: {
        getMetadataSnapshot: () => attachedMetadata as any,
      } as any,
      metadata: {
        path: '/tmp/local-workspace',
        profileId: 'profile-local',
      } as any,
    });

    expect(resolved.sessionMetadataSnapshot).toMatchObject({ path: '/srv/attached-workspace' });
    expect(resolved.resolvedMetadata).toMatchObject({ path: '/srv/attached-workspace', profileId: 'profile-attached' });
    expect(resolved.runtimeDirectory).toBe('/srv/attached-workspace');
  });

  it('falls back to the provided fallback directory when no metadata path is available', () => {
    const resolved = resolveAttachedRunRuntimeContext({
      session: {
        getMetadataSnapshot: () => ({ profileId: 'profile-attached' }) as any,
      } as any,
      metadata: {
        profileId: 'profile-local',
      } as any,
      fallbackDirectory: '/fallback/runtime-dir',
    });

    expect(resolved.runtimeDirectory).toBe('/fallback/runtime-dir');
  });
});
