import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionHandoffProviderBundleRecordExtractor } = vi.hoisted(() => ({
  getSessionHandoffProviderBundleRecordExtractor: vi.fn(),
}));

vi.mock('@/backends/catalog', () => ({
  getSessionHandoffProviderBundleRecordExtractor,
}));

import { readSessionHandoffProviderBundleRecords } from './records';

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
}

describe('readSessionHandoffProviderBundleRecords', () => {
  beforeEach(() => {
    getSessionHandoffProviderBundleRecordExtractor.mockReset();
    getSessionHandoffProviderBundleRecordExtractor.mockResolvedValue(null);
  });

  it('uses the provider-owned record extractor when the catalog provides one', async () => {
    const providerBundle = {
      providerId: 'opencode',
      remoteSessionId: 'oc-session-1',
      exportJsonBase64: encode({ id: 'provider-owned-export' }),
      affinity: {
        backendMode: null,
        serverBaseUrl: null,
        serverBaseUrlExplicit: false,
      },
    } as const;
    const extract = vi.fn(() => [{ id: 'from-provider-hook' }]);
    getSessionHandoffProviderBundleRecordExtractor.mockResolvedValueOnce(extract);

    expect(await readSessionHandoffProviderBundleRecords(providerBundle)).toEqual([{ id: 'from-provider-hook' }]);

    expect(getSessionHandoffProviderBundleRecordExtractor).toHaveBeenCalledWith('opencode');
    expect(extract).toHaveBeenCalledWith(providerBundle);
  });

  it('keeps provider-specific OpenCode parsing out of the generic CLI parser', () => {
    const source = readFileSync(new URL('./records.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/@happier-dev\/plugins-opencode/u);
    expect(source).not.toMatch(/parseOpenCode/u);
    expect(source).not.toMatch(/case ['"]opencode['"]/u);
  });

  it('keeps shared JSONL fallback parsing for generic provider bundles without a hook', async () => {
    expect(await readSessionHandoffProviderBundleRecords({
      providerId: 'claude',
      remoteSessionId: 'claude-session-1',
      transcriptBase64: encode('{"id":"message-1"}\nnot-json\n{"id":"message-2"}\n'),
    })).toEqual([
      { id: 'message-1' },
      { id: 'message-2' },
    ]);

    expect(await readSessionHandoffProviderBundleRecords({
      providerId: 'codex',
      remoteSessionId: 'codex-session-1',
      files: [
        {
          relativePath: 'rollout.jsonl',
          contentBase64: encode('{"id":"codex-message-1"}\n'),
        },
      ],
    })).toEqual([{ id: 'codex-message-1' }]);
  });
});
