import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function normalizePrivateKeyMaterial(input: string): string {
  const trimmed = String(input ?? '').replaceAll('\r\n', '\n').trim();
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

export async function materializeSshIdentityPrivateKeyToTempFile(params: Readonly<{
  privateKey: string;
  prefix?: string;
}>): Promise<Readonly<{
  identityFilePath: string;
  cleanup: () => Promise<void>;
}>> {
  const normalized = normalizePrivateKeyMaterial(params.privateKey);
  if (!normalized) {
    throw new Error('SSH private key material is empty.');
  }

  const dir = await mkdtemp(join(tmpdir(), params.prefix ?? 'happier-ssh-key-'));
  const identityFilePath = join(dir, 'identity.key');

  await writeFile(identityFilePath, normalized, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Best-effort chmod for platforms that ignore the mode on write (or for umask variations).
  await chmod(identityFilePath, 0o600).catch(() => {});

  return {
    identityFilePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
