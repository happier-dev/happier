import type {
  ActionOperationDomainRefV1,
} from '@happier-dev/protocol';
import { SessionForkStrategySchema } from '@happier-dev/protocol';

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function projectCoreActionOperationDomainRef(
  actionId: string,
  requestId: string | undefined,
  input?: unknown,
): ActionOperationDomainRefV1 | undefined {
  if (actionId === 'session.fork') {
    const id = nonBlank(requestId);
    if (!id) return undefined;
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Readonly<{ strategy?: unknown }>
      : null;
    const strategy = SessionForkStrategySchema.safeParse(inputRecord?.strategy);
    return {
      kind: 'forkRequest',
      id,
      ...(strategy.success ? { strategy: strategy.data } : {}),
    };
  }
  if (actionId === 'session.spawn_new') {
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Readonly<{ spawnNonce?: unknown }>
      : null;
    const id = nonBlank(inputRecord?.spawnNonce);
    return id ? { kind: 'spawnAttempt', id } : undefined;
  }
  return undefined;
}
