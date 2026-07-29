import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { resolveExternalSessionTagLookupCandidates } from './externalSessionTagLookupCandidates';

function tagFor(fingerprint: string): string {
  return `direct:v1:${createHash('sha256').update(fingerprint, 'utf8').digest('hex')}`;
}

describe('resolveExternalSessionTagLookupCandidates', () => {
  it('returns the canonical and released persisted tags from one bounded owner', () => {
    const source = {
      kind: 'opencodeServer' as const,
      baseUrl: 'http://127.0.0.1:4096/',
      directory: '/repo',
    };

    expect(resolveExternalSessionTagLookupCandidates({
      machineId: 'machine-1',
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
      source,
      releasedPersistedSource: source,
      sourceKey: 'opencodeServer:http%3A//127.0.0.1%3A4096:/repo',
      releasedSourceKeys: [
        'opencodeServer:http%3A//127.0.0.1%3A4096:/repo',
        'opencodeServer:http://127.0.0.1:4096/:/repo',
      ],
    })).toEqual([
      {
        kind: 'canonical',
        tag: tagFor(
          'machine-1|opencode|remote-1|opencodeServer:http%3A//127.0.0.1%3A4096:/repo',
        ),
        expectedSource: source,
      },
      {
        kind: 'released-source-key',
        tag: tagFor(
          'machine-1|opencode|remote-1|opencodeServer:http://127.0.0.1:4096/:/repo',
        ),
        expectedSource: source,
      },
    ]);
  });

  it('includes the current member Codex predecessor without exceeding four tags', () => {
    const source = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'member-a',
      connectedServiceGroupId: 'primary-pool',
      homePath: '/tmp/codex-home',
    };

    const candidates = resolveExternalSessionTagLookupCandidates({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'thread-1',
      source,
      releasedPersistedSource: source,
      sourceKey: 'codexHome:connectedService:openai-codex:group%3Aprimary-pool:/tmp/codex-home',
      releasedSourceKeys: [
        'codexHome:connectedService:openai-codex:group%3Aprimary-pool:/tmp/codex-home',
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toEqual({
      kind: 'codex-connected-service-predecessor',
      tag: tagFor(
        'machine-1|codex|thread-1|codexHome:connectedService:openai-codex:member-a:/tmp/codex-home',
      ),
      expectedSource: source,
      expectedConnectedServiceGroupId: 'primary-pool',
    });
    expect(candidates.length).toBeLessThanOrEqual(4);
  });
});
