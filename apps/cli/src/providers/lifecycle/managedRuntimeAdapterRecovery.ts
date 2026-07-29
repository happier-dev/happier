import { relative, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import type {
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import {
  inspectConnectedAccountRequestAuthCapabilityFile,
} from '@/daemon/connectedServices/requestAuth/capabilityFile';
import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import type {
  ManagedLocalServiceRunAttachmentV1,
} from '@/daemon/sessionRegistry';
import type {
  ManagedProviderRuntimeRecoveryHealthIdentity,
  ManagedProviderRuntimeAdapterV1,
} from '@/providers/managed/types';

function isInsideRoot(rootDir: string, path: string): boolean {
  const candidate = relative(rootDir, path);
  return candidate.length > 0
    && candidate !== '..'
    && !candidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export type ManagedProviderRuntimeRecoveryFacts = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  privateConfigPath: string;
  capabilityPath: string;
  expectedHealth: ManagedProviderRuntimeRecoveryHealthIdentity;
}>;

const RECOVERY_HEALTH_BODY_LIMIT_BYTES = 64 * 1024;

async function readBoundedHealthBody(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength
    && (
      !/^\d+$/u.test(declaredLength)
      || Number(declaredLength) > RECOVERY_HEALTH_BODY_LIMIT_BYTES
    )
  ) {
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > RECOVERY_HEALTH_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength,
  ))).toString('utf8');
}

export async function verifyManagedProviderRuntimeRecoveryHealth(input: Readonly<{
  runtimeAdapter: ManagedProviderRuntimeAdapterV1;
  facts: ManagedProviderRuntimeRecoveryFacts;
  host: '127.0.0.1' | '::1';
  port: number;
  path: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}>): Promise<boolean> {
  const verify = input.runtimeAdapter.verifyRecoveryHealth;
  if (
    !verify
    || !Number.isInteger(input.port)
    || input.port < 1
    || input.port > 65_535
    || !input.path.startsWith('/')
    || input.path.startsWith('//')
  ) {
    return false;
  }
  const host = input.host === '::1' ? '[::1]' : input.host;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? 500),
  );
  timeout.unref?.();
  try {
    const response = await (input.fetchFn ?? fetch)(
      `http://${host}:${input.port}${input.path}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (
      response.status !== 200
      || response.headers.get('content-type')?.split(';', 1)[0]?.trim()
        !== 'application/json'
    ) {
      return false;
    }
    const contents = await readBoundedHealthBody(response);
    return contents !== null
      && verify(contents, input.facts.expectedHealth) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Composes adapter-owned strict config parsing with the daemon-owned private
 * capability verifier. The returned facts are deliberately secret-free.
 */
export async function inspectManagedProviderRuntimeAdapterRecovery(input: Readonly<{
  runtimeAdapter: ManagedProviderRuntimeAdapterV1;
  attachment: ManagedLocalServiceRunAttachmentV1;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  protocols: readonly ProviderWireProtocol[];
  modelListEnabled: boolean;
}>): Promise<ManagedProviderRuntimeRecoveryFacts | null> {
  const inspectRecovery = input.runtimeAdapter.inspectRecovery;
  if (!inspectRecovery) return null;
  const materializedRootDir = resolve(input.attachment.materialization.rootDir);
  const capabilityPath =
    resolveConnectedAccountRequestAuthCapabilityPath(materializedRootDir);
  const adapterFacts = await inspectRecovery({
    materializedRootDir,
    materializationId: input.attachment.materialization.materializationId,
    capabilityPath,
    purposes: input.purposes,
    protocols: input.protocols,
    modelListEnabled: input.modelListEnabled,
  }, {
    read: readPrivateBearerFile,
  }).catch(() => null);
  if (
    !adapterFacts
    || resolve(adapterFacts.capabilityPath) !== capabilityPath
    || !isInsideRoot(materializedRootDir, resolve(adapterFacts.privateConfigPath))
  ) {
    return null;
  }
  const capabilityFacts = await inspectConnectedAccountRequestAuthCapabilityFile({
    path: capabilityPath,
    materializedRootDir,
  });
  if (
    !capabilityFacts
    || capabilityFacts.materializationId
      !== input.attachment.materialization.materializationId
  ) {
    return null;
  }
  return Object.freeze({
    materializedRootDir,
    materializationId: capabilityFacts.materializationId,
    privateConfigPath: resolve(adapterFacts.privateConfigPath),
    capabilityPath,
    expectedHealth: adapterFacts.expectedHealth,
  });
}
