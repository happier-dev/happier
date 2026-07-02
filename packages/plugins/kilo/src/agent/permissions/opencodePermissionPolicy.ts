import { parsePermissionIntentAlias } from '@happier-dev/agents';

type OpenCodePermissionPolicy = Readonly<Record<string, 'allow' | 'ask' | 'deny'>>;

export function resolveKiloOpenCodePermissionPolicy(permissionMode: string | null | undefined): OpenCodePermissionPolicy {
  const intent = parsePermissionIntentAlias(permissionMode ?? 'default') ?? 'default';
  const base = {
    '*': 'ask',
    read: 'allow',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    change_title: 'allow',
    save_memory: 'allow',
    think: 'allow',
  } as const;

  if (intent === 'yolo') {
    return {
      ...base,
      '*': 'allow',
      edit: 'allow',
      bash: 'allow',
      external_directory: 'allow',
    };
  }

  if (intent === 'safe-yolo') {
    return {
      ...base,
      edit: 'allow',
    };
  }

  if (intent === 'read-only' || intent === 'plan') {
    return {
      ...base,
      '*': 'deny',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    };
  }

  return base;
}

export function buildKiloOpenCodePermissionEnv(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  permissionMode?: string | null;
}>): Readonly<Record<string, string>> {
  if (typeof params.env?.OPENCODE_PERMISSION === 'string' && params.env.OPENCODE_PERMISSION.length > 0) {
    return {};
  }
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveKiloOpenCodePermissionPolicy(params.permissionMode)),
  };
}
