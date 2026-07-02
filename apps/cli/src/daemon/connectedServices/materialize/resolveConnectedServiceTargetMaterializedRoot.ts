import { dirname, isAbsolute } from 'node:path';

import type { CatalogAgentId } from '@/backends/types';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveLegacyMaterializedRootFromEnv(
  env: Readonly<Record<string, string>> | null,
): string | null {
  if (!env) return null;

  const parentDirectories = Array.from(new Set(
    Object.values(env)
      .map((value) => normalizeOptionalString(value))
      .filter((value): value is string => value != null && isAbsolute(value))
      .map((value) => dirname(value)),
  ));

  return parentDirectories.length === 1 ? (parentDirectories[0] ?? null) : null;
}

export function resolveConnectedServiceTargetMaterializedRoot(input: Readonly<{
  agentId: CatalogAgentId;
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
}>): string | null {
  void input.agentId;
  const explicitRoot = normalizeOptionalString(
    input.targetMaterializedEnv?.[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY],
  );
  if (explicitRoot) return explicitRoot;
  return deriveLegacyMaterializedRootFromEnv(input.targetMaterializedEnv);
}
