import { createHash } from 'node:crypto';

import type { SshTunnelEnsureRequest } from './types';

type SshTunnelKeyInput = SshTunnelEnsureRequest & Readonly<{
  leaseId?: string;
}>;

function normalizeOptionalText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function normalizeTarget(target: string): string {
  const text = String(target ?? '').trim();
  const atIndex = text.lastIndexOf('@');
  if (atIndex <= 0) return text.toLowerCase();
  const username = text.slice(0, atIndex).trim();
  const host = text.slice(atIndex + 1).trim().toLowerCase();
  return `${username}@${host}`;
}

export function deriveSshTunnelKey(request: SshTunnelKeyInput): string {
  const material = {
    version: 1,
    remoteHostId: normalizeOptionalText(request.remoteHostId) ?? null,
    serverId: normalizeOptionalText(request.serverId) ?? null,
    ssh: {
      target: normalizeTarget(request.ssh.target),
      port: request.ssh.port ?? 22,
      auth: request.ssh.auth,
      identityFile: normalizeOptionalText(request.ssh.identityFile) ?? null,
      sshConfigFile: normalizeOptionalText(request.ssh.sshConfigFile) ?? null,
      knownHostsPath: normalizeOptionalText(request.ssh.knownHostsPath) ?? null,
    },
    remote: {
      host: String(request.remoteHost ?? '').trim().toLowerCase(),
      port: request.remotePort,
    },
    purpose: request.purpose,
  };

  const digest = createHash('sha256')
    .update(JSON.stringify(material))
    .digest('hex');
  return `ssh-tunnel:${digest}`;
}
