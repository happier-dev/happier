import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionHandoffProviderBundleSchema } from '@happier-dev/protocol';

import type { TransferPayloadSource } from '../../machines/transfer/transferPayloadSource';
import { createFileTransferPayloadSource } from '../../machines/transfer/transferPayloadSource';
import type { SessionHandoffProviderBundle } from './types';

const SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY = join(tmpdir(), 'happier-session-handoff-provider-bundles');

function assertCanonicalSessionHandoffProviderBundle(
  providerBundle: SessionHandoffProviderBundle,
): void {
  if (
    providerBundle.providerId === 'codex'
    && 'codexBackendMode' in (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown })
    && (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown }).codexBackendMode !== undefined
  ) {
    throw new Error('Invalid session handoff transfer payload');
  }
}

export async function createSessionHandoffProviderBundlePayloadSource(
  providerBundle: SessionHandoffProviderBundle,
): Promise<TransferPayloadSource> {
  assertCanonicalSessionHandoffProviderBundle(providerBundle);
  const normalizedProviderBundle = SessionHandoffProviderBundleSchema.parse(providerBundle);
  const payloadBuffer = Buffer.from(JSON.stringify(normalizedProviderBundle), 'utf8');

  await mkdir(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, { recursive: true });
  const filePath = join(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, `provider-bundle-${randomUUID()}.json`);
  await writeFile(filePath, payloadBuffer);

  return createFileTransferPayloadSource({
    filePath,
    sizeBytes: payloadBuffer.byteLength,
    manifestHash: `sha256:${createHash('sha256').update(payloadBuffer).digest('hex')}`,
    dispose: async () => {
      await rm(filePath, { force: true }).catch(() => undefined);
    },
  });
}

export async function readSessionHandoffProviderBundleFile(
  providerBundleFilePath: string,
): Promise<SessionHandoffProviderBundle> {
  const payload = JSON.parse(await readFile(providerBundleFilePath, 'utf8')) as unknown;
  const providerBundle = SessionHandoffProviderBundleSchema.parse(payload);
  assertCanonicalSessionHandoffProviderBundle(providerBundle);
  return providerBundle;
}
