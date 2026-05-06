import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { SshTunnelRegistry, SshTunnelRegistryEntry } from './types';

const RegistryEntrySchema = z.object({
  tunnelKey: z.string().min(1),
  controlPath: z.string().min(1),
  localPort: z.number().int().min(1).max(65_535),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65_535),
  ownerPid: z.number().int().min(1),
  createdAt: z.string().datetime(),
  lastProbeAt: z.string().datetime(),
  purpose: z.enum(['remote-host-access', 'relay-access-local-bridge', 'bootstrap', 'diagnostic']),
  remoteHostId: z.string().min(1).optional(),
  httpBaseUrl: z.string().url(),
  wsBaseUrl: z.string().url().optional(),
  sshTarget: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65_535).optional(),
  sshConfigFile: z.string().min(1).optional(),
  knownHostsPath: z.string().min(1).optional(),
});

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

export function createSshTunnelRegistry(params: Readonly<{ registryPath: string }>): SshTunnelRegistry {
  return {
    async read(): Promise<readonly SshTunnelRegistryEntry[]> {
      try {
        const raw = await readFile(params.registryPath, 'utf8');
        const parsed = RegistryFileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.entries : [];
      } catch {
        return [];
      }
    },
    async write(entries: readonly SshTunnelRegistryEntry[]): Promise<void> {
      await mkdir(dirname(params.registryPath), { recursive: true });
      await writeFile(params.registryPath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
    },
  };
}
