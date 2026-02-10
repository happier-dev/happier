import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeBase64 } from './messageCrypto';

const CLI_HOME_DIR_MODE = 0o700;
const CLI_HOME_FILE_MODE = 0o600;

function deriveServerIdFromUrl(url: string): string {
  // Mirror apps/cli/src/configuration.ts deriveServerIdFromUrl for env-overridden servers.
  // Deterministic, filesystem-safe id for ad-hoc server URLs.
  let h = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

export async function seedCliAuthForServer(params: {
  cliHome: string;
  serverUrl: string;
  token: string;
  secret: Uint8Array;
}): Promise<{ serverId: string; machineId: string }> {
  const serverId = deriveServerIdFromUrl(params.serverUrl);
  const machineId = randomUUID();

  const credentials = `${JSON.stringify({ token: params.token, secret: encodeBase64(params.secret) }, null, 2)}\n`;

  // Write both legacy (~/.happier/access.key) and per-server (~/.happier/servers/<id>/access.key) credentials.
  // The CLI prefers the per-server file when HAPPIER_SERVER_URL is set (env override selection).
  const perServerDir = join(params.cliHome, 'servers', serverId);
  await mkdir(perServerDir, { recursive: true, mode: CLI_HOME_DIR_MODE });
  await writeFile(join(params.cliHome, 'access.key'), credentials, { encoding: 'utf8', mode: CLI_HOME_FILE_MODE });
  await writeFile(join(perServerDir, 'access.key'), credentials, { encoding: 'utf8', mode: CLI_HOME_FILE_MODE });

  // Seed settings.json with an active server profile + machine id to keep daemon startup non-interactive.
  // This avoids races where the detached daemon reads settings before the foreground CLI finishes creating them.
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
    machineIdConfirmedByServerByServerId: {},
    lastChangesCursorByServerIdByAccountId: {},
  };
  await writeFile(join(params.cliHome, 'settings.json'), JSON.stringify(seededSettings, null, 2) + '\n', {
    encoding: 'utf8',
    mode: CLI_HOME_FILE_MODE,
  });

  return { serverId, machineId };
}
