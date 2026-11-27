import { resolveMachineRegistrationPath, type MachineRegistration } from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import type {
  HomeConnectionDescriptorV1,
  MachineReplacementReason,
} from '@happier-dev/protocol';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import tweetnacl from 'tweetnacl';

import { createTestTerminalAuth, type TestAuth } from './auth';

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

function decodeTokenPayload(token: string): unknown {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function readAccountIdFromToken(token: string): string | null {
  const decoded = decodeTokenPayload(token);
  if (!decoded || typeof decoded !== 'object' || !('sub' in decoded)) return null;
  const sub = decoded.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

/** The CLI refuses a stored Account bearer (`cli_relogin_required`); it reads the same unsigned marker. */
function isAccountBearer(token: string): boolean {
  const payload = decodeTokenPayload(token);
  return readAuthTokenProvenance(payload, { allowLegacyHome: true })?.provenance.kind === 'account';
}

async function seedCliCredentialsForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
  credentials: Readonly<Record<string, unknown>>;
  replacementCandidate?: SeedReplacementCandidate;
  homeConnectionDescriptor?: HomeConnectionDescriptorV1;
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

  const accountId = readAccountIdFromToken(params.token);
  const candidate = params.replacementCandidate;
  const registration: MachineRegistration = {
    machineId,
    ...(accountId ? { accountId } : {}),
    ...(accountId && candidate ? { replacementCandidates: { [accountId]: { ...candidate, createdAt: 0 } } } : {}),
  };
  await writeFile(resolveMachineRegistrationPath(join(params.cliHome, 'servers'), serverId),
    JSON.stringify(registration), { encoding: 'utf8', mode: CLI_HOME_FILE_MODE });

  // Seed the active profile before starting the detached daemon.
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
        // Mirrors what the CLI login owner persists after the same Home
        // identity authorizes the credential (apps/cli/src/ui/auth.ts).
        ...(params.homeConnectionDescriptor
          ? { homeConnectionDescriptor: params.homeConnectionDescriptor, homeConnectionDescriptorAuthority: 'exact' }
          : null),
      },
    },
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

export async function seedCliTokenOnlyAuthForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
}): Promise<{ serverId: string; machineId: string }> {
  return seedCliCredentialsForServer({
    ...params,
    credentials: { token: params.token },
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
  expectedHomeServerIdentityId?: string;
}): Promise<{ serverId: string; machineId: string; token: string }> {
  // A CLI signs in with a terminal credential. Exchange an Account bearer for one
  // through the real key-challenge sign-in, as `happier auth login` does.
  const auth = isAccountBearer(params.auth.token)
    ? await createTestTerminalAuth(params.serverUrl, params.auth)
    : params.auth;
  let homeConnectionDescriptor: HomeConnectionDescriptorV1 | undefined;
  if (params.expectedHomeServerIdentityId !== undefined) {
    // Only native fixtures that need a bound profile request an exact observation.
    const { observeServerFeaturesSnapshot } = await import('../../../../apps/cli/src/features/serverFeaturesClient');
    const features = await observeServerFeaturesSnapshot({ serverUrl: params.serverUrl, token: auth.token });
    if (features.status === 'ready' && features.provenance === 'authenticated') {
      homeConnectionDescriptor = features.features.homeConnectionDescriptor;
    }
    if (homeConnectionDescriptor?.homeServerIdentityId !== params.expectedHomeServerIdentityId) {
      throw new Error('Fixture terminal credential did not resolve its authenticated Home descriptor');
    }
  }
  const seeded = await seedCliCredentialsForServer({
    cliHome: params.cliHome,
    serverUrl: params.serverUrl,
    token: auth.token,
    credentials: buildTestAccountCliAuthCredentials({ auth, mode: params.mode }),
    replacementCandidate: params.replacementCandidate,
    homeConnectionDescriptor,
  });
  return { ...seeded, token: auth.token };
}
