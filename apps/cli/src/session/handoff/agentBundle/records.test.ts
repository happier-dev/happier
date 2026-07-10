import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionHandoffAgentBundleRecordExtractor } = vi.hoisted(() => ({
  getSessionHandoffAgentBundleRecordExtractor: vi.fn(),
}));

vi.mock('./catalogHooks', () => ({
  getSessionHandoffAgentBundleRecordExtractor,
}));

import { readSessionHandoffAgentBundleRecords } from './records';

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
}

describe('readSessionHandoffAgentBundleRecords', () => {
  beforeEach(() => {
    getSessionHandoffAgentBundleRecordExtractor.mockReset();
    getSessionHandoffAgentBundleRecordExtractor.mockResolvedValue(null);
  });

  it('uses the provider-owned record extractor when the catalog provides one', async () => {
    const agentBundle = {
      agentId: 'opencode',
      remoteSessionId: 'oc-session-1',
      exportJsonBase64: encode({ id: 'provider-owned-export' }),
      affinity: {
        backendMode: null,
        serverBaseUrl: null,
        serverBaseUrlExplicit: false,
      },
    } as const;
    const extract = vi.fn(() => [{ id: 'from-provider-hook' }]);
    getSessionHandoffAgentBundleRecordExtractor.mockResolvedValueOnce(extract);

    expect(await readSessionHandoffAgentBundleRecords(agentBundle)).toEqual([{ id: 'from-provider-hook' }]);

    expect(getSessionHandoffAgentBundleRecordExtractor).toHaveBeenCalledWith('opencode');
    expect(extract).toHaveBeenCalledWith(agentBundle);
  });

  it('keeps provider-specific OpenCode parsing out of the generic CLI parser', () => {
    const source = readFileSync(new URL('./records.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/@happier-dev\/plugins-opencode/u);
    expect(source).not.toMatch(/parseOpenCode/u);
    expect(source).not.toMatch(/case ['"]opencode['"]/u);
    expect(source).not.toMatch(/case ['"](claude|codex)['"]/u);
    expect(source).not.toMatch(/switch\s*\(\s*agentBundle\.providerId\s*\)/u);
  });

  it('parses JSONL bundle payloads by bundle shape instead of provider id', async () => {
    const transcriptBundle = {
      agentId: 'future-jsonl-provider',
      remoteSessionId: 'future-session-1',
      transcriptBase64: encode('{"id":"transcript-message-1"}\nnot-json\n'),
    } as unknown as Parameters<typeof readSessionHandoffAgentBundleRecords>[0];

    expect(await readSessionHandoffAgentBundleRecords(transcriptBundle)).toEqual([
      { id: 'transcript-message-1' },
    ]);

    const filesBundle = {
      agentId: 'future-files-provider',
      remoteSessionId: 'future-session-2',
      files: [
        {
          relativePath: 'rollout.jsonl',
          contentBase64: encode('{"id":"file-message-1"}\n'),
        },
      ],
    } as unknown as Parameters<typeof readSessionHandoffAgentBundleRecords>[0];

    expect(await readSessionHandoffAgentBundleRecords(filesBundle)).toEqual([
      { id: 'file-message-1' },
    ]);
  });

  it('keeps shared JSONL fallback parsing for generic provider bundles without a hook', async () => {
    expect(await readSessionHandoffAgentBundleRecords({
      agentId: 'claude',
      remoteSessionId: 'claude-session-1',
      transcriptBase64: encode('{"id":"message-1"}\nnot-json\n{"id":"message-2"}\n'),
    })).toEqual([
      { id: 'message-1' },
      { id: 'message-2' },
    ]);

    expect(await readSessionHandoffAgentBundleRecords({
      agentId: 'codex',
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
