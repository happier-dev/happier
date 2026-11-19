import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isMcpPluginItemIdV1, type McpPluginItemMetadataV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema, type SessionExecutionRunBrokerAuthorityRequestV1 } from '@happier-dev/protocol/daemon/executionRuns';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { scopeConnectedAccountPurposeBindingLease, type ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { ensurePrivateConnectedServiceMaterializedRoot } from '@/daemon/connectedServices/materialize/privateMaterializedRoot';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { prepareActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

import { logger } from '@/ui/logger';
import { readWebLatencyTracePoint, timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { MCP_REQUEST_AUTH_PURPOSE, readMcpRequestAuthFailureCode, type McpRequestAuthCapability, type McpRequestAuthPort } from './mcpRequestAuth';

/** Captured by the authenticated daemon operation owner, never supplied by the runner. */
export type McpRequestAuthIssuanceContext = Readonly<{
  parentSessionId?: string;
  materializationBaseDir: string;
  readAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  operationContext?: SavedSecretOperationContextV1;
  /** Ordinary daemon Account admission uses the active catalog's existing owner. */
  catalogCredentials?: StoredCredentials;
  /** From this Session's retained preparation or the finite Machine Test admission. */
  admittedPluginRemote?: McpPluginItemMetadataV1['remote'];
  establishedOwner: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'readMaterialSnapshot'>;
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  registry: ConnectedAccountRequestAuthSubjectRegistry;
  httpPort: number;
  isCurrent(): boolean;
  assertCurrent(signal: AbortSignal): Promise<void>;
  registerLifetimeCleanup?(cleanup: () => Promise<void>): (() => void) | null;
  readExecutionRunAuthority?(request: SessionExecutionRunBrokerAuthorityRequestV1, signal: AbortSignal): Promise<unknown>;
}>;

/** Issues through the incumbent purpose and capability owners; owns no registry or credential cache. */
export async function issueMcpRequestAuthCapability(
  input: Parameters<McpRequestAuthPort['open']>[0],
  context: McpRequestAuthIssuanceContext,
  signal: AbortSignal,
): Promise<McpRequestAuthCapability> {
  const catalogLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const catalogScope = context.catalogCredentials ? resolveAccountSettingsScopeKey(context.catalogCredentials) : undefined;
  const startedAt = performance.now();
  const observe = async <T>(phase: 'catalog_admission' | 'initial_admission' | 'capability_staging' | 'authority_commit', work: () => Promise<T>): Promise<T> => {
    const phaseStartedAt = performance.now();
    let status: 'completed' | 'failed' = 'failed';
    let failure: Readonly<{ failureCode: ReturnType<typeof readMcpRequestAuthFailureCode>; failureLocation?: string }> | undefined;
    try { const result = await timeWebLatencyPhase(`mcp.${phase}`, work); status = 'completed'; return result; }
    catch (error) {
      // Only a source basename and line/column may escape an unknown exception.
      // Its message, full stack, paths and HTTP config can contain private data.
      const stack = error instanceof Error ? error.stack : undefined;
      const messagePrefix = error instanceof Error ? `${error.name}: ${error.message}` : undefined;
      // Messages can contain newlines and look like stack frames. Remove the
      // complete message before looking at actual frames; unknown stacks omit it.
      const frames = stack && messagePrefix && stack.startsWith(messagePrefix) ? stack.slice(messagePrefix.length) : undefined;
      const failureLocation = frames?.match(/^\s+at\s+[^\n]*[\\/]([A-Za-z0-9._-]+\.(?:[cm]?js|tsx?):\d+:\d+)(?:\)|$)/m)?.[1];
      failure = { failureCode: readMcpRequestAuthFailureCode(error), ...(failureLocation ? { failureLocation } : {}) };
      throw error;
    }
    finally {
      logger.infoFile('[mcp] Request-auth issuance phase', { phase, status, ...failure, ...readWebLatencyTracePoint(),
        ...(context.parentSessionId ? { sessionId: context.parentSessionId } : {}),
        durationMs: Math.round(performance.now() - phaseStartedAt), elapsedMs: Math.round(performance.now() - startedAt) });
    }
  };
  const resource = canonicalMcpOAuthResourceUrlV1(input.resource);
  const isPlugin = isMcpPluginItemIdV1(input.serverId);
  const account = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: input.serverId };
  const assertAdmitted = async (requestSignal: AbortSignal): Promise<void> => {
    if (!context.isCurrent() || requestSignal.aborted) throw new Error('mcp_request_auth_not_active');
    await context.assertCurrent(requestSignal);
    if (!isPlugin) {
      const server = readMcpServersSettingsFromAccountSettings(context.readAccountSettingsSnapshot()).servers.find(row => row.id === input.serverId);
      const remote = server?.remote;
      if (!server || server.transport === 'stdio' || !remote || remote.auth?.kind !== 'oauth') throw new Error('mcp_request_auth_not_active');
      if (canonicalMcpOAuthResourceUrlV1(remote.url) !== resource) throw new Error('mcp_resource_mismatch');
    }
    const grant = await context.establishedOwner.readMaterialSnapshot({ account, signal: requestSignal });
    const storedResource = grant.configuration?.values.resource;
    if (typeof storedResource !== 'string' || canonicalMcpOAuthResourceUrlV1(storedResource) !== resource) throw new Error('mcp_resource_mismatch');
    if (!await grant.isCurrent()) throw new Error('mcp_request_auth_not_active');
    if (input.executionRun) {
      if (!context.parentSessionId || !context.readExecutionRunAuthority) throw new Error('mcp_request_auth_not_active');
      const proof = SessionExecutionRunBrokerAuthorityRequestV1Schema.parse({ v: 1, executionRunId: input.executionRun.runId,
        expectedOccurrenceId: input.executionRun.occurrenceId });
      const current = SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(await context.readExecutionRunAuthority(proof, requestSignal));
      if (current.status !== 'current' || current.executionRunId !== input.executionRun.runId
        || current.occurrenceId !== input.executionRun.occurrenceId || current.parentSessionId !== context.parentSessionId) throw new Error('mcp_request_auth_not_active');
    }
    // Nested catalog/credential readers share the opening proof. Re-measure
    // requester authority after those reads, before it can authorize an effect.
    await (() => context.assertCurrent(requestSignal))();
    if (!context.isCurrent() || requestSignal.aborted) throw new Error('mcp_request_auth_not_active');
  };
  const validateCurrent = async (requestSignal: AbortSignal): Promise<boolean> => {
    try {
      await (() => assertAdmitted(requestSignal))();
      return true;
    } catch { return false; }
  };
  try {
    await observe('initial_admission', () => (async () => {
      await context.assertCurrent(signal);
      // Demand the requester's catalog through its incumbent owner. Its nested
      // readers prove this checkpoint's same requester, not separate authority.
      const operationContext = context.operationContext;
      if (isPlugin) {
        if (!context.admittedPluginRemote) throw new Error('mcp_request_auth_not_active');
        if (canonicalMcpOAuthResourceUrlV1(context.admittedPluginRemote.url) !== resource) throw new Error('mcp_resource_mismatch');
      } else if (operationContext) await observe('catalog_admission', () =>
        createCliMcpServerStoreForOperation({ operationContext, signal }).readCatalogForOperation());
      else if (context.catalogCredentials && catalogScope) {
        const credentials = context.catalogCredentials;
        const catalog = await observe('catalog_admission', () => prepareActiveMcpServerCatalog({ credentials, scopeKey: catalogScope,
          lifetimeToken: catalogLifetime, signal, maintainSource: false }));
        if (catalog.status === 'unavailable') throw new McpServerCatalogUnavailableError(catalog.reason);
      }
      await assertAdmitted(signal);
    })());
  } catch (error) {
    throw new Error(readMcpRequestAuthFailureCode(error));
  }
  const lease = context.activatePurposeBindings({
    subject: { kind: 'mcp_request_auth', operationId: input.materializationId, serverId: input.serverId, resource, isCurrent: context.isCurrent },
    purposes: [MCP_REQUEST_AUTH_PURPOSE],
    bindings: [{ purpose: MCP_REQUEST_AUTH_PURPOSE, target: { kind: 'account', account } }],
  });
  let root: string | null = null;
  let unregister: (() => void) | null = null;
  try {
    const materializedRootDir = await observe('capability_staging', async () => {
      await ensurePrivateConnectedServiceMaterializedRoot(context.materializationBaseDir);
      const directory = await mkdtemp(join(context.materializationBaseDir, 'mcp-'));
      root = directory;
      await ensurePrivateConnectedServiceMaterializedRoot(directory);
      return directory;
    });
    const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId,
      parentSessionId: context.parentSessionId, validateCurrent,
      uses: [{ purpose: MCP_REQUEST_AUTH_PURPOSE, materialization: { kind: 'httpHeaders', origin: new URL(resource).origin, headerNames: ['authorization'] } }],
      // Bearers stay exclusively on the strict private request-auth response and are never logged.
      registerRedaction: () => undefined });
    const descriptor = await context.registry.activate({ subject, materializedRootDir,
      materializationId: input.materializationId, httpPort: context.httpPort,
      onRetire: () => { unregister?.(); lease.dispose(); },
      finalizeStagedAuthorityCommit: async (_descriptor, commit) => {
        if (!await observe('authority_commit', () => validateCurrent(signal))) throw new Error('mcp_request_auth_not_active');
        commit();
      },
    });
    if (context.registerLifetimeCleanup) {
      unregister = context.registerLifetimeCleanup(() => context.registry.retire(descriptor, { removeMaterializedRoot: true }));
      if (!unregister) {
        await context.registry.retire(descriptor, { removeMaterializedRoot: true });
        throw new Error('mcp_request_auth_not_active');
      }
    }
    return { capabilityFile: descriptor.path, resource };
  } catch (error) {
    await lease.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
