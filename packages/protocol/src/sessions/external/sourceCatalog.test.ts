import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SESSIONS_AGENT_IDS,
  EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1,
  parseExternalSessionsSourceForDeclaration,
  resolveExternalSessionsSourceKeysForPersistedTagLookup,
  resolveExternalSessionsSourceKeyForDeclaration,
  resolveExternalSessionsSourceKey,
  resolveLegacyExternalSessionsSourceKey,
} from './sourceCatalog.js';

describe('sourceCatalog', () => {
  it('uses generated protocol-local source projections instead of provider source leaves', () => {
    const source = readFileSync(join(process.cwd(), 'src/sessions/external/sourceCatalog.ts'), 'utf8');

    expect(existsSync(join(process.cwd(), 'src/agents/generated/externalSession/sources.ts'))).toBe(true);
    expect(source).toContain('../../agents/generated/externalSession/sources.js');
    expect(source).not.toMatch(/\.\.\/\.\.\/providers\/(?:claude|codex|ohMyPi|opencode)\/externalSessions\.js/);
  });

  it('exposes the canonical external-session Agent ids grouped by source kind', () => {
    expect(EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1).toEqual({
      claudeConfig: ['claude'],
      codexHome: ['codex'],
      opencodeServer: ['opencode'],
      antigravityCliPrint: ['antigravity'],
      ohMyPiAgentDir: ['ohMyPi'],
      piAgentDir: ['pi'],
    });
  });

  it('flattens the source-kind groups into the canonical external-session Agent id list', () => {
    expect(EXTERNAL_SESSIONS_AGENT_IDS).toEqual([
      'claude',
      'codex',
      'opencode',
      'antigravity',
      'ohMyPi',
      'pi',
    ]);
  });

  it('compiles manifest source declarations without registering their ids in the protocol catalog', () => {
    const declaration = {
      sourceKind: 'syntheticSource',
      schema: {
        fields: [
          { name: 'kind', kind: 'literal', value: 'syntheticSource' },
          { name: 'scope', kind: 'string', min: 1 },
        ],
      },
      key: {
        segments: [
          { kind: 'literal', value: 'syntheticSource' },
          { kind: 'field', field: 'scope' },
        ],
      },
    } as const;

    expect(parseExternalSessionsSourceForDeclaration(declaration, {
      kind: 'syntheticSource',
      scope: 'team:one',
    })).toEqual({
      kind: 'syntheticSource',
      scope: 'team:one',
    });
    expect(parseExternalSessionsSourceForDeclaration(declaration, {
      kind: 'syntheticSource',
      scope: '',
    })).toBeNull();
    expect(resolveExternalSessionsSourceKeyForDeclaration(declaration, {
      kind: 'syntheticSource',
      scope: 'team:one',
    })).toBe('syntheticSource:team%3Aone');
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
    })).toBe('opencodeServer:http%3A//127.0.0.1%3A4096/:/tmp/repo');
    expect(resolveExternalSessionsSourceKey({
      kind: 'ohMyPiAgentDir',
      agentDir: 'C:\\Users\\alice\\repo%name',
    })).toBe('ohMyPiAgentDir:C%3A\\Users\\alice\\repo%25name');
  });

  it('retains the released legacy source key only for persisted-tag lookup', () => {
    const source = {
      kind: 'opencodeServer' as const,
      baseUrl: ' http://127.0.0.1:4096/ ',
      directory: ' /tmp/repo ',
    };

    expect(resolveLegacyExternalSessionsSourceKey(source)).toBe(
      'opencodeServer:http://127.0.0.1:4096/:/tmp/repo',
    );
    expect(resolveExternalSessionsSourceKeysForPersistedTagLookup(source)).toEqual([
      'opencodeServer:http%3A//127.0.0.1%3A4096/:/tmp/repo',
      'opencodeServer:http://127.0.0.1:4096/:/tmp/repo',
    ]);
  });

  it('does not add an unproven legacy lookup key for sources that released and predecessor tag writers did not support', () => {
    const source = {
      kind: 'ohMyPiAgentDir' as const,
      agentDir: 'C:\\Users\\alice\\repo%name',
    };

    expect(resolveLegacyExternalSessionsSourceKey(source)).toBe(
      'ohMyPiAgentDir:C:\\Users\\alice\\repo%name',
    );
    expect(resolveExternalSessionsSourceKeysForPersistedTagLookup(source)).toEqual([
      'ohMyPiAgentDir:C%3A\\Users\\alice\\repo%25name',
    ]);
  });

  it('does not collide when a colon moves across source-key segment boundaries', () => {
    const first = {
      kind: 'opencodeServer' as const,
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/repo',
    };
    const second = {
      kind: 'opencodeServer' as const,
      baseUrl: 'http://127.0.0.1',
      directory: '4096:/tmp/repo',
    };

    expect(resolveLegacyExternalSessionsSourceKey(first)).toBe(
      resolveLegacyExternalSessionsSourceKey(second),
    );
    expect(resolveExternalSessionsSourceKey(first)).not.toBe(
      resolveExternalSessionsSourceKey(second),
    );
  });
});
