import type { CapabilitiesInvokeResponse } from '@/capabilities/types';
import { AZ_DEP_ID } from '@happier-dev/protocol/installables/definitions/az';

/** Machine sign-in and service facts Use may receive, before encryption. */
const IDENTITY_FREE_SIGN_IN_FIELDS = [
  'status', 'checkedAt', 'nativeLogin', 'connectedServices', 'signInScope',
  'loginSupport', 'required', 'state', 'method', 'reason', 'source',
  'authenticated', 'credentialState', 'machineRegistered', 'machineRegistrationState', 'machineId', 'needsAuth',
  'serviceAutostart', 'managedServiceInstalled', 'runningManagedServiceCount', 'serviceTargetMode',
  'serviceManagedBy', 'serviceServerId', 'serviceInstalled', 'daemonRunning', 'daemonServerUrl',
  'daemonComparableKey', 'daemonMachineRegistered', 'cliUpdate', 'cliChoice',
  'installed', 'capabilityId', 'installDir', 'binPath', 'managedBinPath', 'installedVersion',
  'sourceKind', 'resolvedSource', 'authStatus', 'remediationReason', 'setupUrl', 'loginCommand',
  'lastInstallLogPath', 'lastBackgroundUpdateCheckAtMs', 'latestVersionCheck',
] as const;

export function projectIdentityFreeSignIn<T extends object>(value: T): Pick<T,
  Extract<keyof T, typeof IDENTITY_FREE_SIGN_IN_FIELDS[number]>> {
  return pickIdentityFreeFields(value, IDENTITY_FREE_SIGN_IN_FIELDS);
}

/** Capability data is host-owned; narrow its unknown transport shape only. */
export function projectIdentityFreeDetectedCapability(id: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entry = value as Record<string, unknown>;
  if (id === AZ_DEP_ID) return projectIdentityFreeSignIn(entry);
  if (!id.startsWith('cli.')) return value;
  return { ...entry,
    ...projectSignInField(entry, 'signIn'),
    ...projectSignInField(entry, 'authStatus'),
  };
}

function projectSignInField(entry: Record<string, unknown>, key: 'signIn' | 'authStatus') {
  const value = entry[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { [key]: projectIdentityFreeSignIn(value) } : {};
}

/** Service tasks return their snapshot directly through wait, or under poll.result. */
export function projectIdentityFreeSystemTaskResponse(response: CapabilitiesInvokeResponse, method: string): CapabilitiesInvokeResponse {
  if (!response.ok || (method !== 'wait' && method !== 'poll') || !isRecord(response.result)) return response;
  const result = response.result;
  return { ok: true, result: method === 'poll'
    ? { ...pickIdentityFreeFields(result, ['events', 'nextCursor', 'pendingPrompt']), result: projectTaskResult(result.result) }
    : projectTaskResult(result) };
}

function projectTaskResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...pickIdentityFreeFields(value, ['protocolVersion', 'taskId', 'ok']),
    ...(isRecord(value.error) ? { error: pickIdentityFreeFields(value.error, ['code', 'message']) } : {}),
    ...(Object.hasOwn(value, 'data') ? { data: isRecord(value.data) ? projectIdentityFreeSignIn(value.data) : undefined } : {}),
  };
}

export function pickIdentityFreeFields<T extends object, K extends string>(value: T, keys: readonly K[]): Pick<T, Extract<keyof T, K>> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key))
    .map(key => [key, Reflect.get(value, key)])) as Pick<T, Extract<keyof T, K>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
