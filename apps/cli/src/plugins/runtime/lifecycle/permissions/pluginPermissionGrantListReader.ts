import axios from 'axios';

import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { PluginPermissionGrantListActionInputV1Schema, PluginPermissionGrantListActionOutputV1Schema, pluginPermissionSubjectsEqualV1 } from '@happier-dev/protocol/plugins/permissions/grants';
import type { PluginPermissionGrantListActionInputV1, PluginPermissionGrantListActionOutputV1 } from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { StoredCredentials } from '@/persistence';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const LIST_PATH = '/v1/plugins/permissions/grants/list';

export type PluginPermissionGrantListReader = Readonly<{
  list(
    input: PluginPermissionGrantListActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginPermissionGrantListActionOutputV1>;
}>;

type ProjectionEntry = PluginPermissionGrantListActionOutputV1['grants'][number];
let projectionScopeKey: string | null = null;
let projectionLifetimeToken = -1;
const projectedActiveGrants = new Map<string, ProjectionEntry>();
const locallyRetiredGrantIds = new Set<string>();

function targetScopeEqual(
  left: PluginPermissionGrantListActionInputV1['targetScope'],
  right: ProjectionEntry['targetScope'],
): boolean {
  if (!left || left.kind !== right.kind) return left === undefined;
  if (left.kind === 'project' && right.kind === 'project') return left.projectId === right.projectId;
  if (left.kind === 'workspace' && right.kind === 'workspace') return left.workspaceId === right.workspaceId;
  return left.kind === 'account' && right.kind === 'account';
}

function matchesQuery(grant: ProjectionEntry, input: PluginPermissionGrantListActionInputV1): boolean {
  return (input.pluginId === undefined || grant.pluginId === input.pluginId)
    && (input.grantId === undefined || grant.id === input.grantId)
    && (input.capability === undefined || grant.capability === input.capability)
    && (input.targetScope === undefined || targetScopeEqual(input.targetScope, grant.targetScope))
    && (input.subject === undefined || pluginPermissionSubjectsEqualV1(input.subject, grant.subject));
}

function selectProjection(input: PluginPermissionGrantListActionInputV1): PluginPermissionGrantListActionOutputV1 {
  return Object.freeze({
    grants: [...projectedActiveGrants.values()].filter((grant) => (
      !locallyRetiredGrantIds.has(grant.id) && matchesQuery(grant, input)
    )),
    pendingRequests: [],
  });
}

function alignProjection(scopeKey: string, lifetimeToken: number): void {
  if (projectionScopeKey === scopeKey && projectionLifetimeToken === lifetimeToken) return;
  projectedActiveGrants.clear();
  locallyRetiredGrantIds.clear();
  projectionScopeKey = scopeKey;
  projectionLifetimeToken = lifetimeToken;
}

/** Immediately removes locally revoked grants from same-daemon offline eligibility. */
export function retireAccountLifetimePluginPermissionGrant(grantId: string): void {
  locallyRetiredGrantIds.add(grantId);
  projectedActiveGrants.delete(grantId);
}

/** Immediately removes a retired plugin's cached eligibility. */
export function retireAccountLifetimePluginPermissionGrantsForPlugin(pluginId: string): void {
  for (const [grantId, grant] of projectedActiveGrants) {
    if (grant.pluginId === pluginId) projectedActiveGrants.delete(grantId);
  }
}

export function resetAccountLifetimePluginPermissionGrantProjectionForTests(): void {
  projectedActiveGrants.clear();
  locallyRetiredGrantIds.clear();
  projectionScopeKey = null;
  projectionLifetimeToken = -1;
}

export function createServerPluginPermissionGrantListReader(input: Readonly<{
  credentials: StoredCredentials;
}>): PluginPermissionGrantListReader {
  return Object.freeze({
    async list(rawInput, options = {}) {
      const body = PluginPermissionGrantListActionInputV1Schema.parse(rawInput);
      const publisherHeader = body.caller
        ? await createDefaultPluginInstallationPublisherHeader({
            method: 'POST',
            path: LIST_PATH,
            body,
          })
        : null;
      if (body.caller && !publisherHeader) {
        throw new Error('plugin_permission_grant_publisher_proof_unavailable');
      }
      options.signal?.throwIfAborted();
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${LIST_PATH}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${input.credentials.token}`,
            ...(publisherHeader
              ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
              : {}),
          },
          timeout: configuration.sessionControlHttpTimeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      return PluginPermissionGrantListActionOutputV1Schema.parse(response.data);
    },
  });
}

/**
 * Same-daemon continuity for grants already synchronized while the active
 * Account and machine installation remain current. This projection stores no
 * credential material and never turns a cold/offline daemon into an authority.
 */
export function createAccountLifetimePluginPermissionGrantListReader(input: Readonly<{
  credentials: StoredCredentials;
  getScopeKey?: () => string | null;
  getLifetimeToken?: () => number;
}>): PluginPermissionGrantListReader {
  const server = createServerPluginPermissionGrantListReader({ credentials: input.credentials });
  const getScopeKey = input.getScopeKey
    ?? (() => getActiveAccountSettingsSnapshot()?.scopeKey ?? null);
  const getLifetimeToken = input.getLifetimeToken
    ?? getActiveAccountSettingsSnapshotLifetimeToken;
  return Object.freeze({
    async list(rawInput, options = {}) {
      const body = PluginPermissionGrantListActionInputV1Schema.parse(rawInput);
      const scopeKey = getScopeKey();
      const lifetimeToken = getLifetimeToken();
      if (!scopeKey) throw new Error('plugin_permission_grant_account_lifetime_unavailable');
      alignProjection(scopeKey, lifetimeToken);
      try {
        const online = await server.list(body, options);
        options.signal?.throwIfAborted();
        if (getScopeKey() !== scopeKey || getLifetimeToken() !== lifetimeToken) {
          throw new Error('plugin_permission_grant_account_lifetime_changed');
        }
        for (const [grantId, grant] of projectedActiveGrants) {
          if (matchesQuery(grant, body)) projectedActiveGrants.delete(grantId);
        }
        const eligibleGrants = online.grants.filter((grant) => !locallyRetiredGrantIds.has(grant.id));
        for (const grant of eligibleGrants) {
          if (grant.status === 'active') projectedActiveGrants.set(grant.id, grant);
        }
        return eligibleGrants.length === online.grants.length
          ? online
          : { ...online, grants: eligibleGrants };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          !axios.isAxiosError(error)
          || error.response !== undefined
          || getScopeKey() !== scopeKey
          || getLifetimeToken() !== lifetimeToken
        ) throw error;
        return selectProjection(body);
      }
    },
  });
}
