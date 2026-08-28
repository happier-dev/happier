import { readFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSessionHandoffAgentBundlePayloadSource,
  readSessionHandoffAgentBundleFile,
} from './file';
import type { SessionHandoffAgentBundle } from '../types';

const handoffTypesSource = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');

describe('session handoff provider bundle file ABI', () => {
  it('round-trips provider-owned bundles without a closed first-party provider union', async () => {
    expect(handoffTypesSource).not.toMatch(/\bSESSION_HANDOFF_PROVIDER_BUNDLE_IDS_V1\b/u);
    expect(handoffTypesSource).not.toMatch(/\bSessionHandoffAgentBundleId\b/u);
    expect(handoffTypesSource).not.toMatch(/\b(Claude|Codex|OpenCode)SessionBundle\b/u);

    const bundle = {
      agentId: 'acme.sample.backend',
      remoteSessionId: 'remote-session-1',
      providerPayloadV1: {
        nested: true,
        records: [
          { id: 'record-1' },
        ],
      },
    } as unknown as SessionHandoffAgentBundle;

    const source = await createSessionHandoffAgentBundlePayloadSource(bundle);
    try {
      expect(source.kind).toBe('file');
      if (source.kind !== 'file') {
        throw new Error('Expected file-backed provider bundle payload');
      }
      await expect(readFile(source.filePath, 'utf8')).resolves.toMatch(/^HAPPIER_SESSION_HANDOFF_BUNDLE_V2/u);
      await expect(readSessionHandoffAgentBundleFile(source.filePath)).resolves.toEqual(bundle);
    } finally {
      await source.dispose?.();
    }
  });

  it('rejects conflicting canonical and deployed-compat bundle identities', async () => {
    await expect(createSessionHandoffAgentBundlePayloadSource({
      agentId: 'codex',
      providerId: 'claude',
      remoteSessionId: 'remote-session-conflict',
    })).rejects.toThrow('Invalid session handoff transfer payload');
  });

  it('reads the predecessor providerId identity from the shared binary artifact contract', async () => {
    const source = await createSessionHandoffAgentBundlePayloadSource({
      providerId: 'codex',
      remoteSessionId: 'predecessor-session-1',
      files: [],
    } as never);
    try {
      if (source.kind !== 'file') throw new Error('Expected file-backed provider bundle payload');
      await expect(readSessionHandoffAgentBundleFile(source.filePath)).resolves.toMatchObject({
        agentId: 'codex',
        remoteSessionId: 'predecessor-session-1',
      });
    } finally {
      await source.dispose?.();
    }
  });

  it('reads legacy JSON source artifacts written before binary persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-agent-bundle-legacy-'));
    const filePath = join(root, 'provider-bundle.json');
    try {
      await writeFile(filePath, JSON.stringify({
        providerId: 'codex',
        remoteSessionId: 'legacy-session-1',
        files: [],
      }), 'utf8');

      await expect(readSessionHandoffAgentBundleFile(filePath)).resolves.toMatchObject({
        agentId: 'codex',
        remoteSessionId: 'legacy-session-1',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packs large handoff files as raw artifact entries without serializing source paths or base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-agent-bundle-'));
    const sourcePath = join(root, 'rollout.jsonl');
    const contents = Buffer.alloc(5 * 1024 * 1024, 0x61);
    await writeFile(sourcePath, contents);
    const bundle = {
      agentId: 'codex',
      remoteSessionId: 'large-session',
      files: [{
        relativePath: 'sessions/rollout.jsonl',
        contentFile: {
          t: 'happier.handoff.file.v1',
          filePath: sourcePath,
          offsetBytes: 0,
          sizeBytes: contents.length,
        },
      }],
    } satisfies SessionHandoffAgentBundle;

    const source = await createSessionHandoffAgentBundlePayloadSource(bundle);
    try {
      if (source.kind !== 'file') throw new Error('Expected file-backed provider bundle payload');
      expect(source.sizeBytes).toBeLessThan(contents.length + 64 * 1024);
      const artifact = await readFile(source.filePath);
      expect(artifact.includes(Buffer.from(sourcePath, 'utf8'))).toBe(false);

      const imported = await readSessionHandoffAgentBundleFile(source.filePath);
      const file = (imported.files as Array<{ contentFile: {
        t: string;
        filePath: string;
        offsetBytes: number;
        sizeBytes: number;
      } }>)[0]?.contentFile;
      expect(file?.t).toBe('happier.handoff.file.v1');
      expect(file?.filePath).toBe(source.filePath);
      expect(file?.sizeBytes).toBe(contents.length);
      if (!file) throw new Error('Expected materialized handoff file entry');
      const artifactFile = await open(file.filePath, 'r');
      try {
        const copied = Buffer.alloc(file.sizeBytes);
        const { bytesRead } = await artifactFile.read(copied, 0, copied.length, file.offsetBytes);
        expect(bytesRead).toBe(contents.length);
        expect(copied.equals(contents)).toBe(true);
      } finally {
        await artifactFile.close();
      }
    } finally {
      await source.dispose?.();
    }
  });
});
