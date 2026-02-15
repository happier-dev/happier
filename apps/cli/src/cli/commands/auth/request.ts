import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';

import { encodeBase64, encodeBase64Url } from '@/api/encryption';
import { configuration } from '@/configuration';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';

function sha256Base64Url(input: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(input)).digest('base64url');
}

function pendingAuthStateDir(): string {
  return join(configuration.activeServerDir, 'auth', 'pending');
}

function pendingAuthStatePath(publicKey: Uint8Array): string {
  const publicKeyHex = createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 24);
  return join(pendingAuthStateDir(), `${publicKeyHex}.json`);
}

export async function handleAuthRequest(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const json = args.includes('--json');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const secret = new Uint8Array(randomBytes(32));
  const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
  const claimSecret = new Uint8Array(randomBytes(32));
  const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
  const claimSecretHash = sha256Base64Url(claimSecret);

  const publicKeyB64 = encodeBase64(keypair.publicKey);
  await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
    publicKey: publicKeyB64,
    supportsV2: true,
    claimSecretHash,
  });

  const statePath = pendingAuthStatePath(keypair.publicKey);
  await mkdir(pendingAuthStateDir(), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        publicKey: publicKeyB64,
        secretKey: encodeBase64(keypair.secretKey),
        claimSecret: claimSecretB64Url,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') {
    await chmod(statePath, 0o600).catch(() => {});
  }

  const publicKeyB64Url = encodeBase64Url(keypair.publicKey);
  const configureLinks = buildConfigureServerLinks({
    webappUrl: configuration.webappUrl,
    serverUrl: configuration.publicServerUrl,
  });
  const terminalLinks = buildTerminalConnectLinks({
    webappUrl: configuration.webappUrl,
    serverUrl: configuration.publicServerUrl,
    publicKeyB64Url,
  });

  console.log(
    JSON.stringify({
      publicKey: publicKeyB64,
      publicKeyB64Url,
      claimSecret: claimSecretB64Url,
      serverUrl: configuration.serverUrl,
      publicServerUrl: configuration.publicServerUrl,
      webappUrl: configuration.webappUrl,
      links: {
        configureWebUrl: configureLinks.webUrl,
        configureMobileUrl: configureLinks.mobileUrl,
        webUrl: terminalLinks.webUrl,
        mobileUrl: terminalLinks.mobileUrl,
      },
      stateFile: statePath,
    }),
  );
}

