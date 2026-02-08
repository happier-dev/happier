import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeBase64 } from './messageCrypto';

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
  await mkdir(perServerDir, { recursive: true });
  await writeFile(join(params.cliHome, 'access.key'), credentials, 'utf8');
  await writeFile(join(perServerDir, 'access.key'), credentials, 'utf8');

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
  await writeFile(join(params.cliHome, 'settings.json'), JSON.stringify(seededSettings, null, 2) + '\n', 'utf8');

  return { serverId, machineId };
}

