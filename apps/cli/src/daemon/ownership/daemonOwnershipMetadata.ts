import { z } from 'zod';

export const DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS = ['stable', 'preview', 'dev'] as const;
export const DaemonPublicReleaseChannelLabelSchema = z.enum(DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS);

export const DAEMON_STARTUP_SOURCE_VALUES = [
  'manual',
  'background-service',
  'self-restart',
  'installer',
  'unknown',
] as const;

export const DaemonStartupSourceSchema = z.enum(DAEMON_STARTUP_SOURCE_VALUES);

export type DaemonStartupSource = z.infer<typeof DaemonStartupSourceSchema>;

export function normalizeDaemonStartupSource(raw: unknown): DaemonStartupSource | null {
  const parsed = DaemonStartupSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function resolveDaemonStartupSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DaemonStartupSource {
  const explicit = normalizeDaemonStartupSource(env.HAPPIER_DAEMON_STARTUP_SOURCE);
  if (explicit) {
    return explicit;
  }
  return 'manual';
}

export function resolveDaemonServiceLabelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const serviceLabel = String(env.HAPPIER_DAEMON_SERVICE_LABEL ?? '').trim();
  return serviceLabel.length > 0 ? serviceLabel : undefined;
}

export function resolveDaemonTakeoverRequestedFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveDaemonStartupSourceFromEnv(env) === 'self-restart') {
    return true;
  }
  const raw = String(env.HAPPIER_DAEMON_TAKEOVER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isDaemonStartupSourceServiceManaged(
  startupSource: DaemonStartupSource | null | undefined,
): boolean {
  return startupSource === 'background-service';
}

export function resolveDaemonStartupSourceServiceManagedState(
  startupSource: DaemonStartupSource | null | undefined,
  serviceLabel?: string | null,
): boolean | null {
  if (!startupSource || startupSource === 'unknown') {
    const normalizedServiceLabel = String(serviceLabel ?? '').trim();
    return normalizedServiceLabel.length > 0;
  }
  return isDaemonStartupSourceServiceManaged(startupSource);
}
