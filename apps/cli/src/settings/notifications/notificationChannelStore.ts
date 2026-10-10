import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { loadNotificationChannelCatalogV1, type NotificationChannelSourcePreparationV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema,
  NotificationChannelCatalogMutationV1Schema, NotificationChannelCatalogMutationResponseV1Schema,
  sealNotificationChannelCatalogContentV1, type NotificationChannelCatalogSnapshotV1,
} from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { normalizeAccountSettingsHistoryClientV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { parseSettingsFromContent, readAccountSettingsV2Raw, replaceAccountSettingsV2RawForOwnerCutover } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { captureSavedSecretSourcePreparationForOperation, prepareSavedSecretResourceCreateForOperation,
  promoteSavedSecretResourceForOperation, readSavedSecretCatalogForOperation,
  type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

/** The existing Account transport and publication lifetime admit this row. */
export function createCliNotificationChannelStore(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
}>) {
  const operation = input.operationContext;
  const base = (operation?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const scopeKey = runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(input.credentials));
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readSnapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
  const isCurrent = () => readSnapshot()?.scopeKey === scopeKey && (operation
    ? operation.credentials.token === input.credentials.token
    : getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    if (!isCurrent() || operation && !await operation.isCurrent()) {
      throw Object.assign(new Error('Captured notification Account retired'), { code: 'scope-retired' });
    }
  };
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json' };
  const requestResponse = async (path: string, body?: unknown): Promise<Readonly<{ status: number; data: unknown }>> => {
    await assertCurrent();
    const options = { headers, signal: input.signal, validateStatus: () => true };
    const response = body === undefined ? await axios.get(`${base}${path}`, options)
      : await axios.post(`${base}${path}`, body, options).catch((error: unknown) => {
        throw Object.assign(new Error('Notification catalog mutation transport failed'), { cause: error,
          code: classifyHomeDomainHttpMutationFailureV1({ error, issued: true, aborted: input.signal?.aborted === true }) });
      });
    if (body === undefined) await assertCurrent();
    return { status: response.status, data: response.data as unknown };
  };
  const request = async (path: string, body?: unknown) => {
    const response = await requestResponse(path, body);
    if (response.status < 200 || response.status >= 300 && response.status !== 409) {
      throw Object.assign(new Error('Notification catalog transport unavailable'), { code: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable' });
    }
    return response.data;
  };
  const readRow = async () => NotificationChannelCatalogReadResponseV1Schema.parse(await request(NOTIFICATION_CHANNELS_ROUTE_V1));
  const readStorageContext = async () => {
    await assertCurrent();
    const context = await resolveCliAccountStorageContext({ credentials: input.credentials, serverBaseUrl: base,
      signal: input.signal, shouldContinue: isCurrent, authorizationHeaders: headers });
    await assertCurrent();
    return context;
  };
  const publishSource = async (raw: Readonly<Record<string, unknown>>, version: number) => {
    await assertCurrent();
    const incumbent = readSnapshot();
    if (!incumbent || incumbent.settingsVersion > version) return;
    const next: ActiveAccountSettingsSnapshot = { ...incumbent, source: 'network', rawSettings: raw,
      settings: accountSettingsParse(raw), settingsVersion: version, loadedAtMs: Date.now() };
    if (operation) await operation.replaceAccountSettings(next);
    else commitActiveAccountSettingsSnapshot(next);
  };
  const readCapturedNotificationChannelCatalog = async (onReady?: (catalog: NotificationChannelCatalogSnapshotV1) => Promise<void>) => {
    const context = await readStorageContext();
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!accountId) throw Object.assign(new Error('Account identity unavailable'), { code: 'unauthorized' });
    const reobserveMode = async () => {
      const current = await readStorageContext();
      if (current.mode !== context.mode) throw Object.assign(new Error('Account mode changed'), { code: 'account-mode-mismatch' });
      return current;
    };
    let capturedSource: Awaited<ReturnType<typeof readAccountSettingsV2Raw>> | undefined;
    const readSourceSnapshot = async () => {
      const source = await readAccountSettingsV2Raw({ credentials: input.credentials, signal: input.signal, deps: {
        resolveAccountEncryptionMode: async () => (await reobserveMode()).mode,
        fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await request('/v2/account/settings')),
      } });
      await publishSource(source.raw, source.version);
      capturedSource = source;
      return source;
    };
    const catalog = await loadNotificationChannelCatalogV1({ ...context, signal: input.signal,
      settingsSecretsReadKeys: readSnapshot()?.settingsSecretsReadKeys,
      readRow,
      ...(onReady ? { onReadyBeforeCleanup: async catalog => { await reobserveMode(); await onReady(catalog); } } : {}),
      transfer: {
        accountId,
        readSourceSnapshot,
        initializeRecord: async value => {
          await reobserveMode();
          if (value.signingSecrets.length) {
            const originalSource = capturedSource;
            if (!originalSource || originalSource.version !== value.sourceSettingsVersion) {
              throw new Error('Notification signing source capture unavailable');
            }
            const preparation = await runWithServerHttpBaseUrl(base, () => captureSavedSecretSourcePreparationForOperation({
              credentials: input.credentials, expectedScopeKey: scopeKey, operationContext: operation, signal: input.signal }));
            await assertCurrent();
            if (preparation.accountId !== accountId || preparation.accountMode !== context.mode
              || preparation.expectedSettingsVersion !== originalSource.version
              || !isDeepStrictEqual(preparation.rawSettings, originalSource.raw)
              || preparation.referenceCensus.notificationChannels?.revision !== 'absent') {
              throw new Error('Notification signing source changed during capture');
            }
            const materializer = createSavedSecretMaterializerFromSnapshotV1(preparation.resources,
              { isCurrent: () => isCurrent() && readSnapshot() === preparation.resources });
            const resources = value.signingSecrets.flatMap(secret => {
              const existing = preparation.resources.savedSecretResources?.find(resource => resource.resourceId === secret.resourceId);
              if (existing) {
                const opened = materializer.resolve(formatSharedSavedSecretRefV1(secret.resourceId));
                if (existing.ownerAccountId !== accountId || existing.relationship !== 'owner'
                  || opened.status !== 'ready' || opened.value !== secret.value) {
                  throw new Error('Notification signing identity is not reusable');
                }
                return [];
              }
              return [prepareSavedSecretResourceCreateForOperation({ credentials: preparation.credentials,
                accountId, accountMode: preparation.accountMode, ...secret })];
            });
            const mutation = NotificationChannelCatalogMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
              sourceSettingsVersion: value.sourceSettingsVersion,
              content: sealNotificationChannelCatalogContentV1({ ...context, record: value.record }),
              savedSecretRevisions: value.signingSecrets.map(secret => ({ resourceRef: formatSharedSavedSecretRefV1(secret.resourceId),
                revision: preparation.resources.savedSecretResources?.find(resource => resource.resourceId === secret.resourceId)?.revision ?? 1 })) });
            const beforeDispatch = await readSourceSnapshot();
            const beforeDispatchStorage = await reobserveMode();
            if (beforeDispatchStorage.mode !== preparation.source.mode
              || !isDeepStrictEqual(beforeDispatchStorage.material, preparation.source.material)
              || beforeDispatch.envelopeKind !== preparation.source.envelopeKind || beforeDispatch.version !== originalSource.version
              || !isDeepStrictEqual(beforeDispatch.raw, originalSource.raw)) {
              throw new Error('Notification signing source changed before dispatch');
            }
            await assertCurrent();
            if (resources.length === 0) {
              return NotificationChannelCatalogMutationResponseV1Schema.parse(await request(NOTIFICATION_CHANNELS_ROUTE_V1, mutation));
            }
            const packet = SharedSavedSecretPromoteInputV1Schema.parse({ ...resources[0], additionalSavedSecretResources: resources.slice(1),
              expectedSettingsVersion: preparation.expectedSettingsVersion, nextSettings: null,
              referenceCensus: preparation.referenceCensus, profileMutations: [], notificationChannelMutation: mutation });
            const result = await runWithServerHttpBaseUrl(base, () => promoteSavedSecretResourceForOperation({ expectedScopeKey: scopeKey,
              input: packet, operationContext: operation, signal: input.signal }));
            if (result.status !== 'applied') throw new Error('Notification signing promotion was not acknowledged');
            return { status: 'applied', settingsVersion: result.settingsVersion };
          }
          const mutation = NotificationChannelCatalogMutationV1Schema.parse({ expectedRevision: value.expectedRevision,
            sourceSettingsVersion: value.sourceSettingsVersion,
            content: sealNotificationChannelCatalogContentV1({ ...context, record: value.record }), savedSecretRevisions: [] });
          return NotificationChannelCatalogMutationResponseV1Schema.parse(await request(NOTIFICATION_CHANNELS_ROUTE_V1, mutation));
        },
        admitSourceCleanup: async (prepared: Extract<NotificationChannelSourcePreparationV1, { status: 'ready' }>) => {
          await reobserveMode();
          await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey,
            refreshCatalog: true, signal: input.signal, operationContext: operation,
            references: prepared.signingSecrets.map(secret => ({ ref: formatSharedSavedSecretRefV1(secret.resourceId) })) }));
          await assertCurrent();
          const snapshot = readSnapshot();
          if (!snapshot) return false;
          const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent });
          return prepared.signingSecrets.every(secret => {
            const resource = snapshot.savedSecretResources?.find(resource => resource.resourceId === secret.resourceId);
            const opened = materializer.resolve(formatSharedSavedSecretRefV1(secret.resourceId));
            return resource?.ownerAccountId === accountId && opened.status === 'ready' && opened.value === secret.value;
          });
        },
        replaceSource: async value => {
          const current = await reobserveMode();
          const result = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials,
            signal: input.signal, raw: value.raw, expectedVersion: value.expectedVersion,
            envelopeKind: context.mode === 'plain' ? 'plain' : 'encrypted', deps: {
              resolveAccountEncryptionMode: async () => current.mode,
              updateSettings: async mutation => AccountSettingsV2UpdateResponseSchema.parse(await request('/v2/account/settings', mutation)),
            } });
          if (result.success) await publishSource(value.raw, result.version);
          await assertCurrent();
          return result.success ? { status: 'applied', settingsVersion: result.version }
            : result.error === 'version-mismatch' ? { status: 'conflict', currentSettingsVersion: result.currentVersion } : { status: 'rejected' };
        },
        normalizeHistory: async value => {
          const source = await readSourceSnapshot();
          const resources = await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey,
            refreshCatalog: true, signal: input.signal, operationContext: operation })).then(snapshot =>
            (snapshot.savedSecretResources ?? []).filter(resource => resource.ownerAccountId === accountId && resource.materialStatus === 'ready')
              .map(({ resourceId, ownerAccountId, revision, materialStatus }) => ({ resourceId, ownerAccountId, revision, materialStatus })))
            .catch(async () => {
              await assertCurrent();
              // Missing resource admission cannot prove signed history safe to
              // erase, but does not withhold unsigned source normalization.
              return [];
            });
          await reobserveMode();
          return normalizeAccountSettingsHistoryClientV1({ destinationAuthority: value, savedSecretRecovery: {
            accountId, source: { raw: source.raw, version: source.version }, resources,
            resolveResourceValue: async resourceId => {
              await reobserveMode();
              const captured = resources.find(resource => resource.resourceId === resourceId);
              if (!captured) return null;
              try {
                const snapshot = await runWithServerHttpBaseUrl(base, () => readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey,
                  refreshCatalog: true, signal: input.signal, operationContext: operation,
                  references: [{ ref: formatSharedSavedSecretRefV1(resourceId), revision: captured.revision }] }));
                await reobserveMode();
                const resource = snapshot.savedSecretResources?.find(resource => resource.resourceId === resourceId);
                if (resource?.ownerAccountId !== accountId || resource.materialStatus !== 'ready' || resource.revision !== captured.revision) return null;
                const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot,
                  { isCurrent: () => isCurrent() && readSnapshot() === snapshot });
                const opened = materializer.resolve(formatSharedSavedSecretRefV1(resourceId));
                await assertCurrent();
                return opened.status === 'ready' ? opened.value : null;
              } catch {
                await assertCurrent();
                return null;
              }
            },
          }, ports: {
            request: (path, value) => requestResponse(path, value.body),
            readCurrentness: () => fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: base,
              authorizationHeaders: headers, signal: input.signal }),
            isCurrent,
            resolveTransferMaterial: async mode => {
              const current = await reobserveMode();
              if (current.mode !== mode) throw new Error('Account history mode changed');
              return current.material;
            },
            openSnapshot: async content => (await parseSettingsFromContent({ content, credentials: input.credentials,
              emptyEnvelopeKind: content.t === 'plain' ? 'plain' : 'encrypted' })).raw,
            resealSnapshot: (raw, recorded) => {
              if (recorded.t === 'plain') return { t: 'plain', v: raw };
              const encryption = input.credentials.encryption;
              if (!encryption) throw new Error('Account history material unavailable');
              const material = encryption.type === 'legacy' ? { type: 'legacy' as const, secret: encryption.secret }
                : { type: 'dataKey' as const, machineKey: encryption.machineKey };
              return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
                payload: raw, randomBytes: length => new Uint8Array(randomBytes(length)) }) };
            },
            unavailable: (_status, message) => { throw new Error(message); },
          } });
        },
      } });
    await reobserveMode();
    return catalog;
  };
  const readNotificationChannelCatalog = async (onReady?: (catalog: NotificationChannelCatalogSnapshotV1) => Promise<void>): Promise<NotificationChannelCatalogSnapshotV1> => {
    try { return await readCapturedNotificationChannelCatalog(onReady); }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : !isCurrent() ? 'scope-retired'
        : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'scope-retired'
          || code === 'account-mode-mismatch' ? code
        : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable'
          ? 'encryption-material-unavailable' : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable' };
    }
  };
  return { assertCurrent, readRow, readStorageContext, readNotificationChannelCatalog };
}
