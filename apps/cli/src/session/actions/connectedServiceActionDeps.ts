import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema, ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, ConnectedAccountAuthenticationCommandRequestSchema, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { SavedSecretSchema, type ActionExecutorDeps, type ActionExecutorContext } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { StoredCredentials } from '@/persistence';
import { readAgentCatalogSnapshot, readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveConnectedServicesServerApiTimeoutMs } from '@/api/client/connectedServicesServerApiTimeout';
import { classifyActionTransportFailure } from '@/api/client/classifyServerEndpointError';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { readDeclaredConnectedAccountResourcePurposeV1, resolveConnectedAccountPurposeSelectedAccountV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { captureSavedSecretReferencesForOperation, promoteSavedSecretsWithConnectedAccountCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { commitActiveConnectedAccountCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { readAccountSettingsV2Raw } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

export function createCliConnectedServiceAction(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
  serverId?: string;
  operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  resolveHeaders(context: ActionExecutorContext, actionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null;
  callMachineAction(input: Readonly<{ machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
  const invoke = async ({ actionId, input, context, signal }: Parameters<NonNullable<ActionExecutorDeps['connectedServiceAction']>>[0], prepare: boolean) => {
    const serverHttpBaseUrl = params.operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const run = async () => {
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      const authorizeRequest = (request: Readonly<{ method: string; path: string; body?: unknown }>) => params.resolveHeaders(context, actionId, request);
      const catalogInput = { credentials: params.credentials, signal, operationContext: params.operationContext, authorizeRequest };
      const catalogStore = createCliConnectedAccountCatalogStore(catalogInput);
      type MetadataStore = ReturnType<(typeof import('@/settings/connected/connectedMetadataStore'))['createCliConnectedMetadataStore']>;
      let metadataStore: MetadataStore | undefined;
      let preparedMetadataCleanup: Awaited<ReturnType<MetadataStore['prepareCleanup']>> | undefined;
      const readMetadataStore = async () => metadataStore ??= (await import('@/settings/connected/connectedMetadataStore')).createCliConnectedMetadataStore({
        ...catalogInput, serverHttpBaseUrl,
        ...(params.isCredentialCurrent ? { isCredentialCurrent: params.isCredentialCurrent } : {}),
      });
      const assertReadCurrent = async () => {
        signal?.throwIfAborted();
        const operation = params.operationContext;
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw Object.assign(new Error('Captured Connected Account retired'), { code: 'scope-retired' });
        }
        if (operation ? operation.credentials.token !== params.credentials.token || !await operation.isCurrent()
          : getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
          throw Object.assign(new Error('Captured Connected Account retired'), { code: 'scope-retired' });
        }
        signal?.throwIfAborted();
      };
      const host: ConnectedServiceConfigurationActionHostV1 = {
      assertCurrent: () => {
        signal?.throwIfAborted();
        if (actionId === 'connectedServices.configuration.get' || actionId === 'connectedServices.configuration.replace') catalogStore.assertCurrent();
      },
      configurationCatalog: {
        read: async () => {
          const admitted = await catalogStore.readAdmittedCatalog('configurations');
          return admitted.status === 'unavailable' && admitted.reason === 'authority-not-confirmed'
            ? catalogStore.readCatalog('configurations') : admitted;
        },
        resolveMode: async target => {
          const descriptor = [...readCurrentContributionRegistry().connectedAccountDescriptorsById.values()].find(candidate =>
            candidate.pluginId === target.service.pluginId && candidate.definition.id === target.service.localId);
          return descriptor?.definition.authentication.modes.find(mode => mode.id === target.modeId) ?? null;
        },
        hasSecret: async reference => {
          await captureSavedSecretReferencesForOperation({ expectedScopeKey: resolveAccountSettingsScopeKey(params.credentials),
            references: [reference], operationContext: params.operationContext, signal });
          await assertReadCurrent();
          return true;
        },
        createRevision: randomUUID,
        write: async write => {
          await assertReadCurrent();
          if (write.newSecrets.length) {
            const timestamp = Date.now();
            const result = await promoteSavedSecretsWithConnectedAccountCatalog({ ...catalogInput,
              preparedSavedSecrets: write.newSecrets.map(({ id, fieldId, value }) => ({ id,
                record: SavedSecretSchema.parse({ id, name: `Connected Account ${fieldId}`.slice(0, 100), kind: 'other',
                  encryptedValue: { _isSecretValue: true, value }, createdAt: timestamp, updatedAt: timestamp }) })),
              connectedAccountCatalog: { expectedRevision: write.expectedRevision, record: write.record },
              authorizeRequest: request => params.resolveHeaders(context, 'secrets.shared.promote', request) });
            if (result.status === 'applied') return { status: 'applied' };
            if (result.status === 'conflict') return { status: 'conflict' };
            throw Object.assign(new Error(result.status), { code: result.status === 'outcome_unknown'
              ? 'outcome_unknown' : 'connected_account_configuration_persistence_unavailable' });
          }
          const result = await catalogStore.writeRecord(write);
          if (result.status === 'updated') {
            try {
              await assertReadCurrent();
              const catalog = { status: 'ready' as const, revision: result.revision, record: write.record };
              if (params.operationContext) await params.operationContext.commitConnectedAccountCatalog({ key: 'configurations', catalog });
              else commitActiveConnectedAccountCatalog({ scopeKey: resolveAccountSettingsScopeKey(params.credentials), lifetimeToken,
                key: 'configurations', catalog });
            } catch { /* A content-free durable ACK survives Account retirement. */ }
          }
          return result;
        },
      },
      setConnectedLabel: async value => (await readMetadataStore()).setLabel(value),
      setConnectedAcknowledgement: async value => (await readMetadataStore()).setAcknowledgement(value),
      prepareConnectedMetadataCleanup: async ({ subject }) => {
        preparedMetadataCleanup = await (await readMetadataStore()).prepareCleanup(subject);
      },
      cleanupConnectedMetadata: async ({ subject }) => (await readMetadataStore()).cleanup(subject, preparedMetadataCleanup),
      request: async (request) => {
        const headers = params.resolveHeaders(context, actionId, request);
        if (!headers) throw Object.assign(new Error('action_authorization_unavailable'), { code: 'action_authorization_unavailable' });
        signal?.throwIfAborted();
        const response = await axios.request<unknown>({
          url: `${serverHttpBaseUrl}${request.path}`,
          method: request.method, headers: { ...headers, 'Content-Type': 'application/json' },
          ...(request.body === undefined ? {} : { data: request.body }),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          ...(signal ? { signal } : {}), validateStatus: () => true,
        }).catch((error: unknown) => {
          const failure = classifyActionTransportFailure(error, {
            mutation: request.method !== 'GET', requestIssued: true,
            cancelled: signal?.aborted === true || axios.isCancel(error),
          });
          if (!failure) throw error;
          const code = failure === 'network' ? 'server_unreachable' : failure;
          throw Object.assign(new Error(code), { code });
        });
        if (response.status < 200 || response.status >= 300) {
          const code = response.data && typeof response.data === 'object' && 'error' in response.data && typeof response.data.error === 'string'
            ? response.data.error : [404, 405, 501].includes(response.status) ? 'unsupported' : 'connected_service_operation_failed';
          throw Object.assign(new Error(code), { code });
        }
        return response.data;
      },
      mutatePurposeBindings: async (mutate) => {
        const current = await readActiveConnectedAccountCatalog({ ...catalogInput, key: 'purposes' });
        if (current.status !== 'ready' || current.record.key !== 'purposes') throw Object.assign(
          new Error('Connected Account purpose authority unavailable'), { code: 'connected_account_purpose_catalog_unavailable' });
        const source = await catalogStore.readSourceSnapshot();
        const mutation = mutate(current.record.value, source.raw);
        if (!mutation) return;
        const value = ConnectedPurposeCatalogV1Schema.parse(mutation.purposeBindings);
        const raw = { ...source.raw };
        for (const [key, entry] of Object.entries(mutation.legacySettingsDelta)) {
          if (entry !== undefined) raw[key] = entry;
        }
        const settingsMutation = isDeepStrictEqual(raw, source.raw) ? undefined : catalogStore.sealSettingsMutation(source, raw);
        const result = await catalogStore.writeRecord({ record: { key: 'purposes', value }, expectedRevision: current.revision,
          ...(settingsMutation ? { settingsMutation } : {}) });
        if (result.status !== 'updated') throw Object.assign(new Error(`Connected purpose mutation ${result.status}`), {
          code: result.status === 'conflict' || result.status === 'settings-conflict'
            ? 'account_settings_conflict' : 'connected_account_purpose_catalog_unavailable',
        });
        // The content-free ACK remains applied if the captured Account retires.
        // Publication is fenced; no private readback or replay is required here.
        try {
          catalogStore.assertCurrent();
          const catalog = { status: 'ready' as const, revision: result.revision, record: { key: 'purposes' as const, value } };
          if (settingsMutation) {
            if (result.settingsVersion === undefined) return;
            // The acknowledged row and genuine legacy cleanup are one observed
            // Account state; publishing either half first resurrects defaults.
            await catalogStore.publishSource(raw, result.settingsVersion, catalog);
          } else if (params.operationContext) await params.operationContext.commitConnectedAccountCatalog({ key: 'purposes', catalog });
          else commitActiveConnectedAccountCatalog({ scopeKey: resolveAccountSettingsScopeKey(params.credentials), lifetimeToken,
            key: 'purposes', catalog });
        } catch {
          // An acknowledged effect is not a failed mutation when its private
          // projection is no longer publishable to the captured incumbent.
        }
      },
      admitResourcePurposeTarget: async input => {
        await assertReadCurrent();
        let rawProjection: unknown;
        try {
          rawProjection = await params.callMachineAction({ machineId: input.machineId,
            ...(params.serverId ? { serverId: params.serverId } : {}),
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            request: DaemonContributionRegistryProjectionDescribeRequestSchema.parse({}), ...(signal ? { signal } : {}),
          });
        } catch {
          await assertReadCurrent();
          return null;
        }
        await assertReadCurrent();
        const described = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(rawProjection);
        if (!described.success) return null;
        const projection = described.data.projection;
        const declaration = readDeclaredConnectedAccountResourcePurposeV1({ purpose: input.purpose, projection });
        if (!declaration) return null;
        let rawProfile: unknown;
        try { rawProfile = await host.request({ method: 'GET', path: '/v1/account/profile' }); }
        catch { await assertReadCurrent(); return null; }
        await assertReadCurrent();
        const profile = AccountProfileSchema.safeParse(rawProfile);
        if (!profile.success) return null;
        const descriptors = Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {}).flatMap(entry => {
          const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
          return parsed.success && parsed.data.availability.state === 'available' ? [parsed.data] : [];
        });
        const selected = resolveConnectedAccountPurposeSelectedAccountV1({ purpose: input.purpose,
          serviceRefs: declaration.serviceRefs, bindings: { v: 1, bindings: [{ purpose: input.purpose, target: input.target }] },
          accounts: profile.data.connectedAccountsV4, groups: profile.data.connectedAccountGroupsV4, now: Date.now(),
          readAuthentication: service => {
            const matching = descriptors.filter(descriptor => descriptor.pluginId === service.pluginId && descriptor.serviceId === service.localId);
            return matching.length === 1 ? matching[0]!.authentication : null;
          },
        });
        if (!selected) return null;
        // This is a preference, not Resource permission. Its runtime re-admits the
        // declaration; the existing catalog transport fences captured Account CAS.
        return () => catalogStore.assertCurrent();
      },
      resolveAgent: async (agentId) => {
        const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(agentId);
        if (!agent?.pluginId) return null;
        const pluginId = agent.pluginId;
        return { agentId, title: agentId, identity: agent.identity ?? null,
          connectedAccounts: (agent.richDefinition?.definition.connectedAccounts ?? []).map((declaration) => ({
            ...declaration, service: qualifyPluginContributionReferenceV1(declaration.service, pluginId),
          })),
        };
      },
      resetQuota: async ({ machineId, serviceId, profileId, providerCreditId, sourceSnapshotFetchedAtMs }) => {
        const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.parse({ serviceId, profileId,
          idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({ serviceId, profileId, providerCreditId, sourceSnapshotFetchedAtMs }),
          ...(providerCreditId ? { providerCreditId } : {}),
        });
        return ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse(await params.callMachineAction({
          machineId, ...(params.serverId ? { serverId: params.serverId } : {}),
          method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME, request, ...(signal ? { signal } : {}),
        }));
      },
      readQuota: async (input) => {
        await assertReadCurrent();
        const { readProviderAccountUsageQuotaV4 } = await import('@/daemon/connectedServices/accountUsage/readQuota');
        await assertReadCurrent();
        const base = serverHttpBaseUrl;
        const headers = authorizeRequest({ method: 'GET', path: '/v1/account/encryption/currentness' });
        if (!headers) throw Object.assign(new Error('action_authorization_unavailable'), { code: 'action_authorization_unavailable' });
        const result = await runWithServerHttpBaseUrl(base, async () => {
          const storage = await resolveCliAccountStorageContext({ credentials: params.credentials, serverBaseUrl: base,
            authorizationHeaders: headers, ...(signal ? { signal } : {}) });
          await assertReadCurrent();
          const source = await readAccountSettingsV2Raw({ credentials: params.credentials, signal, deps: {
            resolveAccountEncryptionMode: async () => storage.mode,
            fetchSettings: async () => {
              await assertReadCurrent();
              const fetched = await host.request({ path: '/v2/account/settings', method: 'GET' });
              await assertReadCurrent();
              return AccountSettingsV2GetResponseSchema.parse(fetched);
            },
          } });
          await assertReadCurrent();
          return await readProviderAccountUsageQuotaV4(input, {
            credentials: params.credentials, accountMode: storage.mode,
            targets: accountSettingsParse(source.raw).usagePacingTargetsV1,
            readEnteredMonthlyPrice: async () => {
              const [{ createInvocationSavedSecretOperationContextV1 }, { createCliConnectedMetadataStore }] = await Promise.all([
                import('@/settings/secrets/hydrateSavedSecretCatalog'), import('@/settings/connected/connectedMetadataStore'),
              ]);
              // A finite cold quota read owns its freshly admitted Account
              // baseline; it never borrows a daemon's publication or starts cleanup.
              const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: params.credentials,
                serverHttpBaseUrl: base, snapshot: { source: 'network', settings: accountSettingsParse(source.raw), rawSettings: source.raw,
                  settingsVersion: source.version, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
                  scopeKey: resolveAccountSettingsScopeKey(params.credentials) },
                isCurrent: async () => { try { await assertReadCurrent(); return true; } catch { return false; } },
              });
              const catalog = await createCliConnectedMetadataStore({ ...catalogInput, operationContext,
                serverHttpBaseUrl: base, isCredentialCurrent: async () => operationContext.isCurrent() }).readAdmittedCatalog();
              await assertReadCurrent();
              const { readConnectedSubscriptionMonthlyPriceV1 } = await import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1');
              return catalog.presentation.status === 'ready' ? readConnectedSubscriptionMonthlyPriceV1(catalog.presentation, input.source.ref) : undefined;
            },
            authorizeRequest, authorizePendingReadRequest: authorizeRequest,
            assertCurrent: assertReadCurrent, ...(signal ? { signal } : {}),
          });
        });
        await assertReadCurrent();
        return result;
      },
      setSubscriptionPrice: async value => (await readMetadataStore()).setSubscriptionPrice(value),
      readPoolSelection: async (input) => {
        await assertReadCurrent();
        const result = await params.callMachineAction({ machineId: input.machineId,
          ...(params.serverId ? { serverId: params.serverId } : {}),
          method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, request: input, ...(signal ? { signal } : {}),
        });
        await assertReadCurrent();
        return result;
      },
      authenticationCommand: async (machineId, command) => {
        await assertReadCurrent();
        const response = await params.callMachineAction({ machineId, ...(params.serverId ? { serverId: params.serverId } : {}),
          method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
          request: ConnectedAccountAuthenticationCommandRequestSchema.parse({ v: 1, machineId, command }),
          authority: context.authority, authorization: context.rpcSessionAuthorization, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}),
        });
        await assertReadCurrent();
        return response;
      },
      controlCommand: async (machineId, command) => {
        await assertReadCurrent();
        const response = await params.callMachineAction({
          machineId, ...(params.serverId ? { serverId: params.serverId } : {}),
          method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
          request: ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId, command }),
          authority: context.authority, authorization: context.rpcSessionAuthorization, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}),
        });
        if (command.operation === 'listPendingAttempts' || command.operation === 'describeService'
          || command.operation === 'readConfiguration') await assertReadCurrent();
        return response;
      },
      };
      return prepare ? prepareConnectedServiceRevokeInputV1(host, input) : executeConnectedServiceConfigurationActionV1(host, actionId, input);
    };
    return runWithServerHttpBaseUrl(serverHttpBaseUrl, run);
  };
  const execute: NonNullable<ActionExecutorDeps['connectedServiceAction']> = args => invoke(args, false);
  return Object.assign(execute, { prepareInput: (args: Parameters<NonNullable<NonNullable<ActionExecutorDeps['connectedServiceAction']>['prepareInput']>>[0]) => invoke(args, true) });
}
