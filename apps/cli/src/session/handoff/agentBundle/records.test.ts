import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCurrentExecutionSurfacesForCatalogAgent } = vi.hoisted(() => ({
  resolveCurrentExecutionSurfacesForCatalogAgent: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveCurrentExecutionSurfacesForCatalogAgent,
  }),
}));

import { readSessionHandoffAgentBundleRecords } from './records';

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
}

describe('readSessionHandoffAgentBundleRecords', () => {
  beforeEach(() => {
    resolveCurrentExecutionSurfacesForCatalogAgent.mockReset();
    resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValue(null);
  });

  it('uses the current Agent handoff leaf to decode opaque bundle records', async () => {
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
    const extractMediaScannableRecords = vi.fn(async () => [{ id: 'from-agent-leaf' }]);
    resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
      agentId: 'opencode',
      backendId: 'opencode.runtime',
      executionSurfaces: {
        handoff: { extractMediaScannableRecords },
      },
    });

    expect(await readSessionHandoffAgentBundleRecords(agentBundle)).toEqual([{ id: 'from-agent-leaf' }]);

    expect(resolveCurrentExecutionSurfacesForCatalogAgent).toHaveBeenCalledWith('opencode');
    expect(extractMediaScannableRecords).toHaveBeenCalledWith({ bundle: agentBundle });
  });

  it('keeps provider-specific OpenCode parsing out of the generic CLI parser', () => {
    const source = readFileSync(new URL('./records.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/@happier-dev\/plugins-opencode/u);
    expect(source).not.toMatch(/parseOpenCode/u);
    expect(source).not.toMatch(/case ['"]opencode['"]/u);
    expect(source).not.toMatch(/case ['"](claude|codex)['"]/u);
    expect(source).not.toMatch(/switch\s*\(\s*agentBundle\.providerId\s*\)/u);
    expect(source).not.toMatch(/catalogHooks/u);
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

  it('streams file-backed JSONL bundle fields through the generic shape fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-records-'));
    const filePath = join(root, 'rollout.jsonl');
    const contents = '{"id":"file-backed-message-1"}\nnot-json\n';
    await writeFile(filePath, contents, 'utf8');

    expect(await readSessionHandoffAgentBundleRecords({
      agentId: 'future-files-provider',
      files: [{
        contentFile: {
          t: 'happier.handoff.file.v1',
          filePath,
          offsetBytes: 0,
          sizeBytes: Buffer.byteLength(contents),
        },
      }],
    })).toEqual([{ id: 'file-backed-message-1' }]);
  });
});
