import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';

import { encodeBase64, encodeBase64Url } from '@/api/encryption';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';
import {
  createTerminalPairingAuthentication,
} from '@/auth/terminalProvisioningResponse';
import {
  ensureProtectedLocalStateDirectory,
  writeProtectedLocalStateFileAtomic,
} from '@/utils/fs/protectedLocalState';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import {
  createTerminalAuthRequest,
  verifyTerminalAuthEnrollmentRuntime,
} from '@/auth/terminalAuthEnrollmentClient';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

const PENDING_AUTH_STATE_PROTECTION = { authority: 'owned' } as const;

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

export async function handleAuthRequest(args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  args = await applyServerSelectionFromArgs(args);

  const json = args.includes('--json');
  const remotePairingContextOnly = args.includes('--remote-pairing-context');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const selectedTarget = await resolveCurrentCliHomeTarget();
  const target = selectedTarget.descriptor
    ? selectedTarget
    : await resolveCliHomeTarget({ kind: 'https_url', url: configuration.apiServerUrl });
  const acquired = await acquireTerminalAuthEnrollmentRuntime(
    target.descriptor ?? target, target.preferredTransport, signal,
  );
  if (!acquired.ok) throw new Error('Unable to acquire the selected Home enrollment carrier');
  try {
    const featuresSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: acquired.runtime.runtimeOrigin, ...(signal ? { signal } : {}) });
    const verified = verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot: featuresSnapshot });
    const serverIdentityId = verified.homeServerIdentityId;

    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = sha256Base64Url(claimSecret);
    const pairing = createTerminalPairingAuthentication({
      nowMs: Date.now(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    const pairingSecretB64Url = Buffer.from(pairing.secret).toString('base64url');

    const publicKeyB64 = encodeBase64(keypair.publicKey);
    await createTerminalAuthRequest({
      runtime: acquired.runtime,
      publicKey: publicKeyB64,
      supportsV2: true,
      claimSecretHash,
      headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...(signal ? { signal } : {}),
    });

    const statePath = pendingAuthStatePath(keypair.publicKey);
    await ensureProtectedLocalStateDirectory(pendingAuthStateDir(), PENDING_AUTH_STATE_PROTECTION);
    await writeProtectedLocalStateFileAtomic(
      statePath,
      JSON.stringify(
        {
          publicKey: publicKeyB64,
          secretKey: encodeBase64(keypair.secretKey),
          claimSecret: claimSecretB64Url,
          serverIdentityId,
          pairingSecret: pairingSecretB64Url,
          pairingCreatedAtMs: pairing.createdAtMs,
          pairingExpiresAtMs: pairing.expiresAtMs,
          supportsTokenOnly: true,
          pairingRequirement: 'v3',
          ...(target.descriptor ? { homeConnectionDescriptor: target.descriptor } : {}),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      PENDING_AUTH_STATE_PROTECTION,
    );

    const publicKeyB64Url = encodeBase64Url(keypair.publicKey);
    const configureLinks = buildConfigureServerLinks({
      webappUrl: configuration.webappUrl,
      serverUrl: configuration.publicServerUrl,
    });
    const terminalLinkCommon = {
      webappUrl: configuration.webappUrl,
      publicKeyB64Url,
      pairing: {
        secretB64Url: pairingSecretB64Url,
        createdAtMs: pairing.createdAtMs,
        expiresAtMs: pairing.expiresAtMs,
      },
      supportsTokenOnly: true,
    } as const;
    const terminalLinks = target.descriptor
      ? buildTerminalConnectLinks({
          ...terminalLinkCommon,
          homeConnectionDescriptor: target.descriptor,
        })
      : buildTerminalConnectLinks({
          ...terminalLinkCommon,
          serverUrl: configuration.publicServerUrl,
          serverIdentityId: verified.homeServerIdentityId,
        });

    const remotePairingContext = {
      publicKey: publicKeyB64,
      serverIdentityId,
      pairing: {
        secretB64Url: pairingSecretB64Url,
        createdAtMs: pairing.createdAtMs,
        expiresAtMs: pairing.expiresAtMs,
      },
      supportsTokenOnly: true,
      pairingRequirement: 'v3',
      serverId: configuration.activeServerId,
      serverUrl: configuration.serverUrl,
      publicServerUrl: configuration.publicServerUrl,
      webappUrl: configuration.webappUrl,
    } as const;

    if (remotePairingContextOnly) {
      await writeJsonStdout(remotePairingContext);
      return;
    }

    // The claim credential remains only in the protected pending state consumed
    // by `auth wait`. The portable request file contains the minimum short-lived
    // v3 approval context and can therefore be copied to an authenticated
    // approver without also granting claim authority.
    await writeJsonStdout({
      ...remotePairingContext,
      publicKeyB64Url,
      links: {
        configureWebUrl: configureLinks.webUrl,
        configureMobileUrl: configureLinks.mobileUrl,
        webUrl: terminalLinks.webUrl,
        mobileUrl: terminalLinks.mobileUrl,
      },
      stateFile: statePath,
    });
  } finally {
    await acquired.close();
  }
}
