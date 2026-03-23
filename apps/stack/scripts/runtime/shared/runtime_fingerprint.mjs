import { createHash } from 'node:crypto';

export function createRuntimeFingerprint({
  repoDir = '',
  commitSha = '',
  dirtyHash = '',
  serverComponent = '',
  dbProvider = '',
  components = [],
  buildInputs = [],
} = {}) {
  const hash = createHash('sha256');
  const parts = [
    String(repoDir ?? '').trim(),
    String(commitSha ?? '').trim(),
    String(dirtyHash ?? '').trim(),
    String(serverComponent ?? '').trim(),
    String(dbProvider ?? '').trim(),
    ...[...(Array.isArray(components) ? components : [])].map((value) => String(value ?? '').trim()).sort(),
    ...[...(Array.isArray(buildInputs) ? buildInputs : [])].map((value) => String(value ?? '').trim()).sort(),
  ];
  hash.update(parts.join('\n'));
  return hash.digest('hex').slice(0, 16);
}
