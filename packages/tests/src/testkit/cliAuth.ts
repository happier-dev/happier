import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeBase64 } from './messageCrypto';
import {
  createServerUrlComparableKey,
  type MachineReplacementReason,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import type { TestAuth } from './auth';

const CLI_HOME_DIR_MODE = 0o700;
const CLI_HOME_FILE_MODE = 0o600;

type SeedReplacementCandidate = Readonly<{
  machineId: string;
  replacementReason: MachineReplacementReason;
}>;

function deriveServerIdFromUrl(url: string): string {
  // Mirror apps/cli/src/configuration.ts deriveServerIdFromUrl for env-overridden servers.
  // Deterministic, filesystem-safe id for ad-hoc server URLs.
  const comparableKey = (() => {
    try {
      return createServerUrlComparableKey(url);
    } catch {
      return '';
    }
  })();
  const value = comparableKey || url;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function readAccountIdFromToken(token: string): string | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || !('sub' in decoded)) return null;
    const sub = decoded.sub;
    return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
  } catch {
    return null;
  }
}

function buildMachineReplacementCandidates(
  params: Readonly<{
    serverId: string;
    token: string;
    replacementCandidate?: SeedReplacementCandidate;
  }>,
): Record<string, Record<string, { machineId: string; replacementReason: MachineReplacementReason; createdAt: number }>> {
  const accountId = readAccountIdFromToken(params.token);
  if (!accountId || !params.replacementCandidate?.machineId) return {};
  return {
    [params.serverId]: {
      [accountId]: {
        machineId: params.replacementCandidate.machineId,
        replacementReason: params.replacementCandidate.replacementReason,
        createdAt: 0,
      },
    },
  };
}

async function seedCliCredentialsForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
  credentials: Readonly<Record<string, unknown>>;
  replacementCandidate?: SeedReplacementCandidate;
}): Promise<{ serverId: string; machineId: string }> {
  const serverId = deriveServerIdFromUrl(params.serverUrl);
  const machineId = randomUUID();
  const credentials = `${JSON.stringify(params.credentials, null, 2)}\n`;

  // Write both legacy (~/.happier/access.key) and per-server (~/.happier/servers/<id>/access.key) credentials.
  // The CLI prefers the per-server file when HAPPIER_SERVER_URL is set (env override selection).
  const perServerDir = join(params.cliHome, 'servers', serverId);
  await mkdir(perServerDir, { recursive: true, mode: CLI_HOME_DIR_MODE });
  await writeFile(join(params.cliHome, 'access.key'), credentials, { encoding: 'utf8', mode: CLI_HOME_FILE_MODE });
  await writeFile(join(perServerDir, 'access.key'), credentials, { encoding: 'utf8', mode: CLI_HOME_FILE_MODE });

  // Seed settings.json with an active server profile + machine id to keep daemon startup non-interactive.
  // This avoids races where the detached daemon reads settings before the foreground CLI finishes creating them.
  const machineReplacementCandidatesByServerIdByAccountId = buildMachineReplacementCandidates({
    serverId,
    token: params.token,
    replacementCandidate: params.replacementCandidate,
  });
  const seededSettings = {
    schemaVersion: 5,
    onboardingCompleted: true,
    activeServerId: serverId,
    servers: {
      [serverId]: {
        id: serverId,
        name: serverId,
        serverUrl: params.serverUrl,
        webappUrl: params.serverUrl,
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
    },
    machineIdByServerId: {
      [serverId]: machineId,
    },
    ...(Object.keys(machineReplacementCandidatesByServerIdByAccountId).length
      ? { machineReplacementCandidatesByServerIdByAccountId }
      : null),
    machineIdConfirmedByServerByServerId: {},
    lastChangesCursorByServerIdByAccountId: {},
  };
  await writeFile(join(params.cliHome, 'settings.json'), JSON.stringify(seededSettings, null, 2) + '\n', {
    encoding: 'utf8',
    mode: CLI_HOME_FILE_MODE,
  });

  return { serverId, machineId };
}

export async function seedCliAuthForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
  secret: Uint8Array;
  replacementCandidate?: SeedReplacementCandidate;
}): Promise<{ serverId: string; machineId: string }> {
  return seedCliCredentialsForServer({
    cliHome: params.cliHome,
    serverUrl: params.serverUrl,
    token: params.token,
    credentials: { token: params.token, secret: encodeBase64(params.secret) },
    replacementCandidate: params.replacementCandidate,
  });
}

export async function seedCliDataKeyAuthForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
  machineKey: Uint8Array;
  publicKey?: Uint8Array;
  replacementCandidate?: SeedReplacementCandidate;
}): Promise<{ serverId: string; machineId: string; publicKey: Uint8Array }> {
  const publicKey = params.publicKey ?? Uint8Array.from(
    tweetnacl.box.keyPair.fromSecretKey(params.machineKey).publicKey,
  );
  const seeded = await seedCliCredentialsForServer({
    cliHome: params.cliHome,
    serverUrl: params.serverUrl,
    token: params.token,
    credentials: {
      token: params.token,
      encryption: {
        publicKey: Buffer.from(publicKey).toString('base64'),
        machineKey: Buffer.from(params.machineKey).toString('base64'),
      },
    },
    replacementCandidate: params.replacementCandidate,
  });

  return { ...seeded, publicKey };
}

export type TestAccountCliAuthMode = 'legacy' | 'dataKey' | 'tokenOnly';

export type TestAccountCliAuthCredentials =
  | Readonly<{
      token: string;
      secret: string;
    }>
  | Readonly<{
      token: string;
      encryption: Readonly<{
        publicKey: string;
        machineKey: string;
      }>;
    }>
  | Readonly<{
      token: string;
    }>;

export function buildTestAccountCliAuthCredentials(params: Readonly<{
  auth: TestAuth;
  mode: TestAccountCliAuthMode;
}>): TestAccountCliAuthCredentials {
  if (params.mode === 'legacy') {
    return {
      token: params.auth.token,
      secret: encodeBase64(params.auth.accountSigningSeed),
    };
  }

  if (params.mode === 'dataKey') {
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(
      params.auth.accountMachineKey,
    ).publicKey;
    return {
      token: params.auth.token,
      encryption: {
        publicKey: encodeBase64(publicKey),
        machineKey: encodeBase64(params.auth.accountMachineKey),
      },
    };
  }

  return { token: params.auth.token };
}

export async function seedCliAuthForTestAccount(params: {
  cliHome: string;
  serverUrl: string;
  auth: TestAuth;
  mode: TestAccountCliAuthMode;
  replacementCandidate?: SeedReplacementCandidate;
}): Promise<{ serverId: string; machineId: string }> {
  return seedCliCredentialsForServer({
    cliHome: params.cliHome,
    serverUrl: params.serverUrl,
    token: params.auth.token,
    credentials: buildTestAccountCliAuthCredentials({ auth: params.auth, mode: params.mode }),
    replacementCandidate: params.replacementCandidate,
  });
}
