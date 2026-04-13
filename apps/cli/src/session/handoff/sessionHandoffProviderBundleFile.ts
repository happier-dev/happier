import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TransferPayloadSource } from '../../machines/transfer/transferPayloadSource';
import { createFileTransferPayloadSource } from '../../machines/transfer/transferPayloadSource';
import type { SessionHandoffProviderBundle } from './types';
import { parseCanonicalSessionHandoffProviderBundle } from './parseCanonicalSessionHandoffProviderBundle';

const SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY = join(tmpdir(), 'happier-session-handoff-provider-bundles');

export async function createSessionHandoffProviderBundlePayloadSource(
  providerBundle: SessionHandoffProviderBundle,
): Promise<TransferPayloadSource> {
  const normalizedProviderBundle = parseCanonicalSessionHandoffProviderBundle(providerBundle);
  // Avoid double-buffering large provider bundles. `writeFile` accepts strings, so compute size/hash
  // from the canonical JSON string and let Node stream/encode it directly to disk.
  const payloadJson = JSON.stringify(normalizedProviderBundle);
  const sizeBytes = Buffer.byteLength(payloadJson, 'utf8');
  const manifestHash = `sha256:${createHash('sha256').update(payloadJson, 'utf8').digest('hex')}`;

  await mkdir(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, { recursive: true });
  const filePath = join(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, `provider-bundle-${randomUUID()}.json`);
  await writeFile(filePath, payloadJson, 'utf8');

  return createFileTransferPayloadSource({
    filePath,
    sizeBytes,
    manifestHash,
    dispose: async () => {
      await rm(filePath, { force: true }).catch(() => undefined);
    },
  });
}

export async function readSessionHandoffProviderBundleFile(
  providerBundleFilePath: string,
): Promise<SessionHandoffProviderBundle> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(providerBundleFilePath, 'utf8')) as unknown;
  } catch {
    throw new Error('Invalid session handoff transfer payload');
  }
  return parseCanonicalSessionHandoffProviderBundle(payload);
}
