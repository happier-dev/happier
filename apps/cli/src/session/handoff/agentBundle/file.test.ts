import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

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
      expect(JSON.parse(await readFile(source.filePath, 'utf8'))).toEqual({
        providerId: 'acme.sample.backend',
        remoteSessionId: 'remote-session-1',
        providerPayloadV1: {
          nested: true,
          records: [
            { id: 'record-1' },
          ],
        },
      });
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
});
