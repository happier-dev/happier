import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const OPAQUE_DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const UI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function resolveUiDeploymentIdentity(params: Readonly<{
  digest: string;
  previousStateText: string | null;
  generateId: () => string;
}>): Readonly<{ digest: string; deploymentId: string }> {
  const digest = String(params.digest ?? '');
  if (!UI_DIGEST_PATTERN.test(digest)) {
    throw new Error('[relay-runtime] managed UI deployment digest is invalid');
  }
  let previous: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(String(params.previousStateText ?? ''));
    previous = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    previous = null;
  }
  const previousDigest = String(previous?.uiDeploymentDigest ?? '');
  const previousId = String(previous?.uiDeploymentId ?? '');
  if (
    UI_DIGEST_PATTERN.test(previousDigest)
    && previousDigest === digest
    && OPAQUE_DEPLOYMENT_ID_PATTERN.test(previousId)
  ) {
    return { digest, deploymentId: previousId };
  }
  const deploymentId = String(params.generateId() ?? '').trim();
  if (!OPAQUE_DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error('[relay-runtime] generated UI deployment identity is invalid');
  }
  return { digest, deploymentId };
}

export async function computeUiDeploymentDigest(uiDirectory: string): Promise<string> {
  const digest = createHash('sha256');

  async function visit(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? join(uiDirectory, relativeDirectory) : uiDirectory;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory.replaceAll('\\', '/')}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (entry.isFile()) {
        const fileDigest = createHash('sha256');
        for await (const chunk of createReadStream(absolutePath)) {
          fileDigest.update(chunk);
        }
        digest.update('file\0').update(relativePath).update('\0').update(fileDigest.digest('hex')).update('\0');
        continue;
      }
      if (entry.isSymbolicLink()) {
        digest.update('link\0').update(relativePath).update('\0').update(await readlink(absolutePath)).update('\0');
        continue;
      }
      throw new Error(`[relay-runtime] unsupported managed UI entry: ${relativePath}`);
    }
  }

  await visit('');
  return `sha256:${digest.digest('hex')}`;
}
