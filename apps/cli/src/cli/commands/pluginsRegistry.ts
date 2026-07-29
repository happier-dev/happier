import { randomUUID } from 'node:crypto';

import type { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';

type RegistryCliService = Pick<ReturnType<typeof createNpmRegistryProfileService>, 'snapshot' | 'mutate'>;

export type PluginsRegistryCommandDeps = Readonly<{
  service: RegistryCliService;
  machineId: string;
  promptSecret: (prompt: string) => Promise<string>;
  allocateProfileId?: () => string;
  write: (value: unknown) => void;
}>;

function readValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && typeof args[index + 1] === 'string' && args[index + 1]!.trim()) {
      values.push(args[index + 1]!.trim());
      index += 1;
    }
  }
  return values;
}

function positional(args: readonly string[], index: number): string | null {
  const value = args[index];
  return typeof value === 'string' && !value.startsWith('-') && value.trim() ? value.trim() : null;
}

function requireSuccess(
  result: Awaited<ReturnType<RegistryCliService['mutate']>>,
): Extract<typeof result, { status: 'success' }> {
  if (result.status === 'error') throw new Error(`Registry operation failed: ${result.code}`);
  return result;
}

export async function handlePluginsRegistryCommand(
  args: readonly string[],
  deps: PluginsRegistryCommandDeps,
): Promise<void> {
  const action = positional(args, 0);
  if (!action || action === 'help') throw new Error('Expected registry command: add, login, test, list, logout, or remove');

  if (action === 'list') {
    deps.write({ kind: 'plugins_registry_list', snapshot: await deps.service.snapshot() });
    return;
  }

  const current = await deps.service.snapshot();
  const mutationId = `registry-${action}-${randomUUID()}`;
  if (action === 'add') {
    const origin = positional(args, 1);
    if (!origin) throw new Error('Registry add requires an HTTPS origin');
    const profileId = readValue(args, '--id') ?? deps.allocateProfileId?.() ?? `registry_${randomUUID()}`;
    const result = requireSuccess(await deps.service.mutate({
      action: 'add',
      machineId: deps.machineId,
      expectedRevision: current.revision,
      mutationId,
      profileId,
      profile: {
        displayName: readValue(args, '--name') ?? new URL(origin).hostname,
        origin,
        scopes: readValues(args, '--scope'),
        useAsDefault: args.includes('--default'),
        allowPrivateNetwork: args.includes('--allow-private-network'),
      },
    }));
    deps.write({ kind: 'plugins_registry_add', profileId, snapshot: result.snapshot });
    return;
  }

  const profileId = positional(args, 1);
  if (!profileId) throw new Error(`Registry ${action} requires a profile id`);
  if (action === 'login') {
    if (args.includes('--token') || args.includes('--secret') || args.includes('--authorization')) {
      throw new Error('Registry credentials must be entered through the hidden prompt');
    }
    const secret = await deps.promptSecret('Registry token (input hidden): ');
    if (!secret) throw new Error('Registry token cannot be empty');
    const result = requireSuccess(await deps.service.mutate({
      action: 'login', machineId: deps.machineId, expectedRevision: current.revision,
      mutationId, profileId, credential: { kind: 'bearer_token', secret },
    }));
    deps.write({ kind: 'plugins_registry_login', profileId, snapshot: result.snapshot });
    return;
  }

  if (action === 'test' || action === 'logout' || action === 'remove') {
    const result = requireSuccess(await deps.service.mutate({
      action, machineId: deps.machineId, expectedRevision: current.revision, mutationId, profileId,
    }));
    deps.write({ kind: `plugins_registry_${action}`, profileId, snapshot: result.snapshot });
    return;
  }

  throw new Error(`Unknown plugins registry command: ${action}`);
}
