import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  ConnectedServiceMaterializationIdentityV1Schema,
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
  parseSessionConnectedServiceMaterializationIdentityJson,
  serializeSessionConnectedServiceMaterializationIdentityForEnv,
} from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';

const MATERIALIZATION_ID_RANDOM_BYTES = 8;

type SpawnOptionsWithMaterializationIdentity = SpawnSessionOptions & Readonly<{
  connectedServiceMaterializationIdentityV1?: unknown;
}>;

export function readConnectedServiceMaterializationIdentityFromSpawnOptions(
  options: SpawnSessionOptions | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
  if (!options) return null;
  const candidate = options as SpawnOptionsWithMaterializationIdentity;
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(
    candidate.connectedServiceMaterializationIdentityV1,
  );
  return parsed.success ? parsed.data : null;
}

export function readConnectedServiceMaterializationIdentityFromEnvironment(
  env: Readonly<Record<string, string | undefined>> | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
  if (!env) return null;
  return parseSessionConnectedServiceMaterializationIdentityJson(
    env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] ?? null,
  );
}

export function readConnectedServiceMaterializationIdentityFromMetadata(
  metadata: unknown,
): ConnectedServiceMaterializationIdentityV1 | null {
  return readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
}

export function generateConnectedServiceMaterializationIdentityV1(params?: Readonly<{
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceMaterializationIdentityV1 {
  const now = Math.max(0, Math.trunc(params?.now?.() ?? Date.now()));
  const bytes = params?.randomBytes?.(MATERIALIZATION_ID_RANDOM_BYTES)
    ?? nodeRandomBytes(MATERIALIZATION_ID_RANDOM_BYTES);
  const hex = Buffer.from(bytes).toString('hex');
  return {
    v: 1,
    id: `csm_${now}_${hex}`,
    createdAt: now,
    source: 'first_spawn',
  };
}

export function resolveConnectedServiceMaterializationIdentityForSpawn(params: Readonly<{
  options: SpawnSessionOptions;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceMaterializationIdentityV1 {
  return readConnectedServiceMaterializationIdentityFromSpawnOptions(params.options)
    ?? readConnectedServiceMaterializationIdentityFromEnvironment(params.options.environmentVariables)
    ?? generateConnectedServiceMaterializationIdentityV1({
      now: params.now,
      randomBytes: params.randomBytes,
    });
}

export function withConnectedServiceMaterializationIdentityEnv(
  env: Readonly<Record<string, string>> | null | undefined,
  identity: ConnectedServiceMaterializationIdentityV1,
): Record<string, string> {
  const serialized = serializeSessionConnectedServiceMaterializationIdentityForEnv(identity);
  return {
    ...(env ?? {}),
    ...(serialized
      ? { [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: serialized }
      : {}),
  };
}
