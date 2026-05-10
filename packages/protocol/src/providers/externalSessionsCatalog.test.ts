import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SESSIONS_PROVIDER_IDS,
  EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1,
  resolveExternalSessionsSourceKey,
} from './externalSessionsCatalog.js';

describe('externalSessionsCatalog', () => {
  it('exposes the canonical direct-session provider ids grouped by source kind', () => {
    expect(EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1).toEqual({
      claudeConfig: ['claude'],
      codexHome: ['codex'],
      opencodeServer: ['opencode'],
      ohMyPiAgentDir: ['ohMyPi'],
    });
  });

  it('flattens the source-kind groups into the canonical direct-session provider id list', () => {
    expect(EXTERNAL_SESSIONS_PROVIDER_IDS).toEqual([
      'claude',
      'codex',
      'opencode',
      'ohMyPi',
    ]);
  });

  it('resolves direct-session source keys through the canonical source-kind lookup', () => {
    expect(resolveExternalSessionsSourceKey({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/codex',
    } as any)).toBe('codexHome:user:::/tmp/codex');
  });
});
