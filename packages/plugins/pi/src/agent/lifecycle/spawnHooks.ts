import type { PluginHookDecisionResult } from '@happier-dev/plugin-sdk/hooks';

import {
  resolvePiShellBridgeAvailabilityForRuntime,
  type PiShellBridgeAvailability,
} from './shellBridgeAvailability.js';

type PiShellBridgeAvailabilityResolver = (
  params: Readonly<{
    directory?: string;
    env: Readonly<Record<string, string | undefined>>;
    includeProjectSettings: true;
  }>,
) => PiShellBridgeAvailability;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readHookPayload(event: unknown): Readonly<Record<string, unknown>> {
  const record = readRecord(event);
  return readRecord(record?.payload) ?? record ?? {};
}

function readRuntimeSelectionEnv(payload: Readonly<Record<string, unknown>>): Record<string, string> {
  const runtimeSelection = readRecord(payload.runtimeSelection);
  const env = readRecord(runtimeSelection?.env);
  if (!env) return {};

  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export async function resolvePiDaemonSpawnPrerequisites(
  event: unknown,
  _context?: unknown,
  resolveAvailability: PiShellBridgeAvailabilityResolver = resolvePiShellBridgeAvailabilityForRuntime,
): Promise<PluginHookDecisionResult> {
  const payload = readHookPayload(event);
  const availability = resolveAvailability({
    directory: readString(payload.cwd) ?? readString(payload.directory),
    env: { ...process.env, ...readRuntimeSelectionEnv(payload) },
    includeProjectSettings: true,
  });
  if (availability.available) return { decision: 'allow' };

  return {
    decision: 'deny',
    reasonCode: 'pi_shell_bridge_unavailable',
    errorMessage: availability.errorMessage,
  };
}
