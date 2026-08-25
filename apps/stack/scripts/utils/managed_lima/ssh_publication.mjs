import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireAbsolutePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[managed-lima] ${label} must be an absolute path`);
  }
  return path;
}

export async function publishManagedLimaLocalSshConfig({ instance, destination: rawDestination, alias: rawAlias }) {
  const source = String(instance?.sshConfigFile ?? instance?.SSHConfigFile ?? '').trim();
  if (!source) throw new Error('[managed-lima] guest SSH config metadata is unavailable');
  requireAbsolutePath(source, 'source SSH config');
  const destination = requireAbsolutePath(rawDestination, 'published SSH config');
  const alias = String(rawAlias ?? '').trim();
  if (!SSH_ALIAS_RE.test(alias)) throw new Error(`[managed-lima] invalid SSH alias: ${JSON.stringify(alias)}`);

  const original = await readFile(source, 'utf8');
  const lines = original.split(/\r?\n/);
  const hostIndex = lines.findIndex((line) => /^Host\s+\S+\s*$/.test(line));
  if (hostIndex < 0) throw new Error('[managed-lima] Lima SSH config does not contain a Host entry');
  lines[hostIndex] = `Host ${alias}`;
  const filtered = lines.filter((line) => !/^\s*(ForwardAgent|IdentitiesOnly)\s+/i.test(line));
  filtered.splice(hostIndex + 1, 0, '  ForwardAgent no', '  IdentitiesOnly yes');
  const rendered = `${filtered.join('\n').replace(/\n+$/, '')}\n`;

  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, rendered, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return { ssh: alias, sshConfigFile: destination };
}
