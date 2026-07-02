import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SESSIONS_PROVIDER_IDS,
  EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1,
  resolveExternalSessionsSourceKey,
} from './sourceCatalog.js';

describe('sourceCatalog', () => {
  it('uses generated protocol-local source projections instead of provider source leaves', () => {
    const source = readFileSync(join(process.cwd(), 'src/sessions/external/sourceCatalog.ts'), 'utf8');

    expect(existsSync(join(process.cwd(), 'src/providers/generated/externalSession/sources.ts'))).toBe(true);
    expect(source).toContain('../../providers/generated/externalSession/sources.js');
    expect(source).not.toMatch(/\.\.\/\.\.\/providers\/(?:claude|codex|ohMyPi|opencode)\/externalSessions\.js/);
  });

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
    })).toBe('codexHome:user:::/tmp/codex');
    expect(resolveExternalSessionsSourceKey({
      kind: 'opencodeServer',
      baseUrl: ' http://127.0.0.1:4096/ ',
      directory: ' /tmp/repo ',
    })).toBe('opencodeServer:http://127.0.0.1:4096/:/tmp/repo');
  });
});
