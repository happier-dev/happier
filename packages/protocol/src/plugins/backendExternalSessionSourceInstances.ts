import { ConnectedServiceProfileIdSchema } from '../connect/connectedServiceBindings.js';
import {
  readManagedServiceEndpointUrl,
  type ManagedServiceEndpointUrlRejection,
  type ManagedServiceEndpointUrlResult,
} from './managedServiceEndpointUrl.js';

/**
 * The single owner that turns declaration-owned external-session source
 * instances into concrete sources. Every host (daemon admission and the browse
 * surface) materializes through this function so a source a user can pick is
 * exactly a source the daemon admits.
 */

/**
 * Declaration shape this owner reads. It is intentionally structural so both a
 * parsed declaration and a manifest-authored one materialize identically; each
 * instance member is validated before use because projections carry data an
 * older or newer producer wrote.
 */
export type ExternalSessionSourceInstanceInput = Readonly<{
  kind: string;
  constants?: Readonly<Record<string, string | number | boolean | null>>;
  settingId?: string;
  byServerIdSettingId?: string;
  field?: string;
  normalization?: string;
  serviceId?: string;
  fields?: Readonly<{ serviceId: string; profileId: string }>;
}>;

export type ExternalSessionSourceDeclarationInput = Readonly<{
  sourceKind: string;
  instances?: readonly ExternalSessionSourceInstanceInput[];
}>;

export type ExternalSessionSourceConnectedServiceProfileView = Readonly<{
  profileId: string;
  status: string;
}>;

export type ExternalSessionSourceConnectedServiceView = Readonly<{
  serviceId: string;
  profiles: readonly ExternalSessionSourceConnectedServiceProfileView[];
}>;

export type ExternalSessionSourceInstanceOrigin =
  | Readonly<{ kind: 'default' }>
  | Readonly<{ kind: 'connectedServiceProfile'; serviceId: string; profileId: string }>
  | Readonly<{ kind: 'agentSetting'; settingId: string; value: string }>;

export type MaterializedExternalSessionSourceInstance = Readonly<{
  sourceKind: string;
  source: Readonly<Record<string, unknown>>;
  origin: ExternalSessionSourceInstanceOrigin;
}>;

export type ExternalSessionSourceInstanceIssue =
  | Readonly<{
    code: 'malformed_connected_service_profile_id';
    serviceId: string;
  }>
  | Readonly<{
    /** A stored endpoint remains intact but cannot become an attach source. */
    code: 'invalid_agent_setting_endpoint';
    settingId: string;
    rejection: ManagedServiceEndpointUrlRejection;
  }>;

export type ExternalSessionSourceInstanceMaterialization = Readonly<{
  instances: readonly MaterializedExternalSessionSourceInstance[];
  issues: readonly ExternalSessionSourceInstanceIssue[];
}>;

const DEFAULT_INSTANCE_ORIGIN: ExternalSessionSourceInstanceOrigin = Object.freeze({ kind: 'default' });

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * `httpOrigin` normalization admits a credential-free `http:`/`https:` URL the
 * user declared, on whichever host they run their server. Source routing keeps
 * its base path; query and fragment are discarded. Anything else yields `null`
 * so the caller materializes no source.
 *
 * The rule itself lives in `readManagedServiceEndpointUrl` so the value a user
 * can save here is exactly the value the daemon will attach to.
 */
function readExternalSessionSourceHttpOrigin(raw: unknown): ManagedServiceEndpointUrlResult {
  return readManagedServiceEndpointUrl(raw, {
    hostPolicy: 'userDeclaredAttach',
    // A saved setting may carry a path, query or fragment. Source routing keeps
    // the path and discards the rest, so they are not a reason to refuse it.
    allowSearch: true,
    allowHash: true,
  });
}

function originFromManagedEndpointUrl(
  read: Extract<ManagedServiceEndpointUrlResult, Readonly<{ ok: true }>>,
): string | null {
  try {
    const parsed = new URL(read.endpoint.baseUrl);
    return parsed.origin.endsWith('/') ? parsed.origin : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function baseUrlFromManagedEndpointUrl(
  read: Extract<ManagedServiceEndpointUrlResult, Readonly<{ ok: true }>>,
): string | null {
  try {
    const parsed = new URL(read.endpoint.baseUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeExternalSessionSourceHttpOrigin(raw: unknown): string | null {
  const read = readExternalSessionSourceHttpOrigin(raw);
  if (!read.ok) return null;
  return originFromManagedEndpointUrl(read);
}

/**
 * Mirrors the `perActiveServer` settings binding: an explicit entry for the
 * active server wins, and the unscoped setting is the fallback only when the
 * active server has no entry at all.
 */
function readAgentSettingRawValue(params: Readonly<{
  instance: ExternalSessionSourceInstanceInput;
  settingId: string;
  agentSettings: unknown;
  activeServerId: string | null;
}>): unknown {
  const settings = readRecord(params.agentSettings);
  if (!settings) return undefined;
  const byServerIdSettingId = params.instance.byServerIdSettingId;
  const activeServerId = params.activeServerId?.trim() ?? '';
  if (byServerIdSettingId && activeServerId) {
    const byServerId = readRecord(settings[byServerIdSettingId]);
    if (byServerId && Object.prototype.hasOwnProperty.call(byServerId, activeServerId)) {
      return byServerId[activeServerId];
    }
  }
  return settings[params.settingId];
}

export function materializeExternalSessionSourceInstances(params: Readonly<{
  declaration: ExternalSessionSourceDeclarationInput;
  connectedServices?: readonly ExternalSessionSourceConnectedServiceView[];
  agentSettings?: unknown;
  activeServerId?: string | null;
}>): ExternalSessionSourceInstanceMaterialization {
  const sourceKind = params.declaration.sourceKind;
  const instances: MaterializedExternalSessionSourceInstance[] = [];
  const issues: ExternalSessionSourceInstanceIssue[] = [];
  let materializedDefaultOverride = false;

  for (const instance of params.declaration.instances ?? []) {
    if (instance.kind === 'default') {
      instances.push(Object.freeze({
        sourceKind,
        source: Object.freeze({ ...instance.constants, kind: sourceKind }),
        origin: DEFAULT_INSTANCE_ORIGIN,
      }));
      continue;
    }

    if (instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride') {
      const settingId = instance.settingId;
      const field = instance.field;
      if (
        typeof settingId !== 'string'
        || typeof field !== 'string'
        || (
          instance.normalization !== 'httpOrigin'
          && instance.normalization !== 'configuredPath'
        )
      ) continue;
      const rawValue = readAgentSettingRawValue({
        instance,
        settingId,
        agentSettings: params.agentSettings,
        activeServerId: params.activeServerId ?? null,
      });
      // An omitted/blank setting means the ordinary managed default is the
      // only configured source. It is not a rejected override.
      if (
        rawValue === undefined
        || rawValue === null
        || (typeof rawValue === 'string' && rawValue.trim() === '')
      ) continue;
      const configuredPath = instance.normalization === 'configuredPath'
        && typeof rawValue === 'string'
        ? rawValue.trim()
        : null;
      const normalized = instance.normalization === 'httpOrigin'
        ? readExternalSessionSourceHttpOrigin(rawValue)
        : null;
      if (instance.normalization === 'configuredPath' && !configuredPath) continue;
      if (normalized && !normalized.ok) {
        issues.push(Object.freeze({
          code: 'invalid_agent_setting_endpoint' as const,
          settingId,
          rejection: normalized.rejection,
        }));
        continue;
      }
      const value = configuredPath ?? (
        normalized?.ok === true ? baseUrlFromManagedEndpointUrl(normalized) : null
      );
      if (value === null) {
        // `readManagedServiceEndpointUrl` has already admitted the URL; this
        // defensive branch keeps a malformed projection inert without
        // replacing the valid default source.
        issues.push(Object.freeze({
          code: 'invalid_agent_setting_endpoint' as const,
          settingId,
          rejection: 'malformed' as const,
        }));
        continue;
      }
      instances.push(Object.freeze({
        sourceKind,
        source: Object.freeze({
          ...instance.constants,
          kind: sourceKind,
          [field]: value,
        }),
        origin: Object.freeze({
          kind: 'agentSetting' as const,
          settingId,
          value,
        }),
      }));
      if (instance.kind === 'agentSettingOverride') {
        materializedDefaultOverride = true;
      }
      continue;
    }

    const identityFields = instance.fields;
    if (
      instance.kind !== 'connectedServiceProfiles'
      || typeof instance.serviceId !== 'string'
      || !identityFields
    ) continue;
    const serviceId = instance.serviceId;
    const service = params.connectedServices?.find(
      (candidate) => candidate.serviceId === serviceId,
    );
    if (!service) continue;
    for (const profile of service.profiles) {
      const profileId = ConnectedServiceProfileIdSchema.safeParse(profile.profileId);
      if (!profileId.success) {
        issues.push(Object.freeze({
          code: 'malformed_connected_service_profile_id' as const,
          serviceId,
        }));
        continue;
      }
      if (profile.status !== 'connected') continue;
      instances.push(Object.freeze({
        sourceKind,
        source: Object.freeze({
          ...instance.constants,
          kind: sourceKind,
          [identityFields.serviceId]: serviceId,
          [identityFields.profileId]: profileId.data,
        }),
        origin: Object.freeze({
          kind: 'connectedServiceProfile' as const,
          serviceId,
          profileId: profileId.data,
        }),
      }));
    }
  }

  const effectiveInstances = materializedDefaultOverride
    ? instances.filter((instance) => instance.origin.kind !== 'default')
    : instances;

  return Object.freeze({
    instances: Object.freeze(effectiveInstances),
    issues: Object.freeze(issues),
  });
}
