import { AGENTS_CORE } from '@happier-dev/agents';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

export function resolveConnectTargetServiceIds(targetId: string): ConnectedServiceId[] {
  const normalized = String(targetId ?? '').trim().toLowerCase();
  if (!normalized) return [];
  if (normalized === 'github') return ['github'];

  const core = (AGENTS_CORE as Record<string, { cloudConnect?: unknown; connectedServices?: { supportedServiceIds: readonly unknown[] } | null }>)[normalized];
  if (!core?.cloudConnect) return [];

  const supported = core.connectedServices?.supportedServiceIds ?? [];
  return supported.map((serviceId) => ConnectedServiceIdSchema.parse(serviceId));
}
