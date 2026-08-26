import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';

import {
  PluginInstallReviewPrincipalDigestSchema,
  type PluginPermissionGrantAuthoritySourceV1,
  type PluginPermissionGrantListActionInputV1,
  type PluginPermissionGrantListActionOutputV1,
  type PluginPermissionSubjectV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  createInvocationVoiceRawCredentialAccess,
  createPluginRawCredentialAuthorizationInspector,
  createPluginRawCredentialMaterializer,
  type PluginPermissionGrantListReader,
} from './rawCredentialMaterializer';

const contribution = { pluginId: 'acme.voice', localId: 'speech' } as const;
const service = { pluginId: 'acme.accounts', localId: 'oauth' } as const;
const principalA = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
const machineA = {
  kind: 'machine_installation',
  machineId: 'machine-a',
  installationId: 'installation-a',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const machineB = {
  kind: 'machine_installation',
  machineId: 'machine-b',
  installationId: 'installation-b',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const sameInstallationOnMachineB = {
  kind: 'machine_installation',
  machineId: 'machine-b',
  installationId: 'installation-a',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const replacedInstallationOnMachineA = {
  kind: 'machine_installation',
  machineId: 'machine-a',
  installationId: 'installation-a2',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const principalB = PluginInstallReviewPrincipalDigestSchema.parse('b'.repeat(64));
const principalSnapshot = (digest: typeof principalA) => Object.freeze({
  digest,
  presentation: null,
});

const connectedHeaderRequest = {
  kind: 'httpHeaders',
  origin: 'https://speech.example.test',
  headerNames: ['authorization'],
} as const;

function manifest() {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: contribution.pluginId,
    contributes: {
      voiceProviders: [{
        id: contribution.localId,
        title: 'Speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web'],
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'test-voice',
            presentation: { control: 'text' },
          }],
        },
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon', phase: 'speech', request: connectedHeaderRequest,
            }, {
              realm: 'daemon', phase: 'speech',
              request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
            }, {
              realm: 'daemon', phase: 'speech',
              request: { kind: 'files', fileIds: ['voice-token'] },
            }],
          }, {
            kind: 'connectedAccount',
            service,
            rawGrants: [{
              realm: 'daemon', phase: 'speech', request: connectedHeaderRequest,
            }, {
              realm: 'daemon', phase: 'speech',
              request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
            }, {
              realm: 'daemon', phase: 'speech',
              request: { kind: 'files', fileIds: ['voice-token'] },
            }],
          }],
        },
      }],
    },
  }));
  if (!parsed) throw new Error('test manifest must be canonical');
  return parsed;
}

function snapshot(params: Readonly<{
  accountId?: string;
  source?: 'connectedAccount' | 'savedSecret';
  scopeKey?: string;
  secretId?: string;
  secret?: string;
  secretUpdatedAt?: number;
  includeSecret?: boolean;
  settingsVersion?: number;
  groupId?: string;
  unrelatedVoiceProvider?: boolean;
}> = {}): ActiveAccountSettingsSnapshot {
  const accountId = params.accountId ?? 'account-a';
  const source = params.source ?? 'connectedAccount';
  const secretId = params.secretId ?? 'saved-secret';
  return {
    source: 'network',
    scopeKey: params.scopeKey ?? 'account-scope',
    settingsVersion: params.settingsVersion ?? (accountId === 'account-a' ? 1 : 2),
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      secrets: params.includeSecret === false ? [] : [{
        id: secretId,
        name: 'Voice API key',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: params.secret ?? 'saved-secret-raw' },
        createdAt: 1,
        updatedAt: params.secretUpdatedAt ?? 1,
      }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: source },
          credentialBindings: { account: { api_key: secretId } },
        }],
        ...(params.unrelatedVoiceProvider
          ? {
              providers: {
                'acme.voice/unrelated': {
                  schemaVersion: 1,
                  config: { enabled: true },
                },
              },
            }
          : {}),
      },
      connectedAccountPurposeBindingsV1: source === 'connectedAccount' ? {
        v: 1,
        bindings: [{
          purpose: { consumer: contribution, purpose: 'voice.speech' },
          target: params.groupId
            ? { kind: 'group', service, groupId: params.groupId }
            : { kind: 'account', account: { service, accountId } },
        }],
      } : { v: 1, bindings: [] },
    } as never,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createHarness(input: Readonly<{
  initialSnapshot?: ActiveAccountSettingsSnapshot | null;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
  materializeAccount?: Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['materializeAccount'];
  readPrincipal?: () => Promise<ReturnType<typeof principalSnapshot> | null>;
  isRuntimeAuthorityCurrent?: () => boolean;
  immutableGenerationId?: string;
  grantSubject?: PluginPermissionSubjectV1;
  grantAuthoritySource?: PluginPermissionGrantAuthoritySourceV1;
  currentAuthoritySource?: PluginPermissionGrantAuthoritySourceV1 | null;
  readCurrentAuthoritySource?: () => Promise<PluginPermissionGrantAuthoritySourceV1 | null>;
  afterGrantListRead?: () => void;
  resolvedGroupAccountId?: string | null;
  /** Canonical Account incumbent token; tests vary it only at lifecycle boundaries. */
  getLifetimeToken?: () => number;
  afterSnapshotRead?: (
    readNumber: number,
    replace: (next: ActiveAccountSettingsSnapshot) => void,
  ) => void;
}> = {}) {
  let currentSnapshot: ActiveAccountSettingsSnapshot | null = input.initialSnapshot === undefined
    ? snapshot()
    : input.initialSnapshot;
  let currentPrincipal = principalSnapshot(principalA);
  let generationCurrent = true;
  let grantActive = true;
  let snapshotReads = 0;
  const listInputs: PluginPermissionGrantListActionInputV1[] = [];

  const store: ConnectedAccountPurposeBindingStore = {
    async read() {
      return (currentSnapshot?.settings.connectedAccountPurposeBindingsV1
        ?? { v: 1, bindings: [] }) as QualifiedConnectedAccountPurposeBindingsV1;
    },
    async update() {
      throw new Error('test store is read-only');
    },
    subscribe() {
      return { dispose() {} };
    },
  };
  const connectedAccounts = createConnectedAccountPurposeBindingOwner({
    store,
    async selectTarget() {
      throw new Error('selection is outside raw materialization');
    },
    async resolveTarget(target) {
      if (target.kind === 'account') {
        return { displayName: target.account.accountId, account: target.account };
      }
      if (!input.resolvedGroupAccountId) return null;
      return {
        displayName: input.resolvedGroupAccountId,
        account: { service: target.service, accountId: input.resolvedGroupAccountId },
        group: { groupId: target.groupId, generation: 1 },
      };
    },
    materializeAccount: input.materializeAccount ?? (async ({
      account,
      credentialRevisionBasis,
      request,
    }) => {
      if (request.kind !== 'httpHeaders') throw new Error('unsupported test request');
      credentialRevisionBasis?.captureCredentialRevision(
        'csr_0123456789ABCDEFGHJKMNPQRS',
      );
      return {
        kind: 'httpHeaders',
        headers: Object.fromEntries(request.headerNames.map((name) => [
          name,
          `Bearer connected:${account.accountId}`,
        ])),
      };
    }),
    async projectTargetAccounts() {
      throw new Error('target-scoped listing is outside raw credential materialization');
    },
    async assertTargetAccountMaterializable() {
      throw new Error('listed-account materialization is outside raw credential materialization');
    },
  });
  const grants: PluginPermissionGrantListReader = {
    async list(rawInput): Promise<PluginPermissionGrantListActionOutputV1> {
      listInputs.push(rawInput);
      input.afterGrantListRead?.();
      if (!grantActive || !rawInput.subject) return { grants: [], pendingRequests: [] };
      return {
        grants: [{
          v: 1,
          id: 'grant-1',
          accountId: 'account-scope',
          pluginId: contribution.pluginId,
          capability: 'credentials.materialize.raw',
          targetScope: { kind: 'account' },
          subject: input.grantSubject ?? rawInput.subject,
          authoritySource: input.grantAuthoritySource ?? machineA,
          status: 'active',
          grantedByUserId: 'user-1',
          grantedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
        pendingRequests: [],
      };
    },
  };
  const binding = {
    manifest: manifest(),
    contribution,
    realm: 'daemon' as const,
    phase: 'speech' as const,
    machineId: null,
    immutableGenerationId: input.immutableGenerationId ?? 'generation-a',
    isRuntimeAuthorityCurrent: input.isRuntimeAuthorityCurrent
      ?? (() => generationCurrent),
  };
  const materializerInput = {
    binding,
    currentInstallReviewPrincipal: {
      readCurrent: input.readPrincipal ?? (async () => currentPrincipal),
    },
    readCurrentGrantAuthoritySource: input.readCurrentAuthoritySource ?? (async () => (
      input.currentAuthoritySource === undefined ? machineA : input.currentAuthoritySource
    )),
    grants,
    connectedAccounts,
    getAccountSettingsSnapshot: () => {
      const value = currentSnapshot;
      input.afterSnapshotRead?.(++snapshotReads, (next) => { currentSnapshot = next; });
      return value;
    },
    ...(input.ensureAccountSettingsSnapshot
      ? { ensureAccountSettingsSnapshot: input.ensureAccountSettingsSnapshot }
      : {}),
    ...(input.getLifetimeToken
      ? { getAccountSettingsSnapshotLifetimeToken: input.getLifetimeToken }
      : {}),
  };
  const materializer = createPluginRawCredentialMaterializer(materializerInput);
  return {
    materializer,
    connectedAccounts,
    listInputs,
    setSnapshot(next: ActiveAccountSettingsSnapshot | null) { currentSnapshot = next; },
    setGrantActive(next: boolean) { grantActive = next; },
    setPrincipal(next: typeof principalA) { currentPrincipal = principalSnapshot(next); },
    setGenerationCurrent(next: boolean) { generationCurrent = next; },
  };
}

describe('plugin raw credential materializer', () => {
  it('creates a standalone canonical authorization inspector without grant or credential dependencies', async () => {
    const harness = createHarness();
    const inspector = createPluginRawCredentialAuthorizationInspector({
      binding: {
        manifest: manifest(),
        contribution,
        realm: 'daemon',
        phase: 'speech',
        machineId: null,
        immutableGenerationId: 'generation-a',
        isRuntimeAuthorityCurrent: () => true,
      },
      currentInstallReviewPrincipal: { readCurrent: async () => principalSnapshot(principalA) },
      readCurrentGrantAuthoritySource: async () => machineA,
      connectedAccounts: harness.connectedAccounts,
      getAccountSettingsSnapshot: () => snapshot(),
    });

    const inspection = await inspector.inspectAuthorization();
    expect(inspection).toMatchObject({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: { installReviewPrincipalDigest: principalA },
    });
    expect(inspection.disclosures).toEqual(expect.arrayContaining([{
      sourceClass: { kind: 'connectedAccount', service },
      realm: 'daemon',
      phase: 'speech',
      materialization: 'httpHeaders',
      origin: 'https://speech.example.test',
      destination: 'authorization',
    }, {
      sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
      realm: 'daemon',
      phase: 'speech',
      materialization: 'files',
      destination: 'voice-token',
    }]));
    expect(Object.isFrozen(inspection.disclosures)).toBe(true);
    expect(inspection.disclosures.every((row) => (
      Object.isFrozen(row) && Object.isFrozen(row.sourceClass)
    ))).toBe(true);
  });

  it('inspects the exact bound permission subject without reading grants or credentials', async () => {
    const harness = createHarness();

    const inspection = await harness.materializer.inspectAuthorization();

    expect(inspection).toMatchObject({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: {
        kind: 'credential_access_disclosure',
        contribution,
        credentialSlotId: 'api_key',
        purpose: 'voice.speech',
        accessDeclarationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        selectedAuthorityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        selectedRawAccessDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        installedGenerationId: 'generation-a',
        installReviewPrincipalDigest: principalA,
      },
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.subject)).toBe(true);
    expect(harness.listInputs).toHaveLength(0);
  });

  it('confines a raw-credential grant to the machine installation that approved it', async () => {
    const approved = createHarness();
    const inspection = await approved.materializer.inspectAuthorization();
    expect(inspection.authoritySource).toEqual(machineA);
    await expect(approved.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });

    // Same Account, same plugin, same settings, same subject - another machine.
    const otherMachine = createHarness({
      grantSubject: inspection.subject,
      grantAuthoritySource: machineA,
      currentAuthoritySource: machineB,
    });
    await expect(otherMachine.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    // Same machine, the approved installation replaced by a new one.
    const replacedInstallation = createHarness({
      grantSubject: inspection.subject,
      grantAuthoritySource: machineA,
      currentAuthoritySource: replacedInstallationOnMachineA,
    });
    await expect(replacedInstallation.materializer.materialize(connectedHeaderRequest))
      .rejects.toMatchObject({ code: 'plugin_voice_credential_access_unavailable' });

    // A grant recorded under another machine cannot be used from this one.
    const foreignGrant = createHarness({
      grantSubject: inspection.subject,
      grantAuthoritySource: machineB,
      currentAuthoritySource: machineA,
    });
    await expect(foreignGrant.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    // The authority gate belongs ahead of the source branch, not inside the
    // connected-account leaf: a SavedSecret disclosure is confined identically.
    const savedApproved = createHarness({ initialSnapshot: snapshot({ source: 'savedSecret' }) });
    const savedInspection = await savedApproved.materializer.inspectAuthorization();
    await expect(savedApproved.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'saved-secret-raw' },
    });
    const savedOtherMachine = createHarness({
      initialSnapshot: snapshot({ source: 'savedSecret' }),
      grantSubject: savedInspection.subject,
      grantAuthoritySource: machineA,
      currentAuthoritySource: machineB,
    });
    await expect(savedOtherMachine.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('fails closed when this installation has no resolvable grant authority', async () => {
    const unidentified = createHarness({ currentAuthoritySource: null });
    await expect(unidentified.materializer.inspectAuthorization()).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    await expect(unidentified.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('does not let a raw-credential grant follow selected authority or installed generation', async () => {
    const approved = createHarness();
    const inspection = await approved.materializer.inspectAuthorization();

    const retained = createHarness({ grantSubject: inspection.subject });
    await expect(retained.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });

    const accountTurnover = createHarness({
      initialSnapshot: snapshot({ accountId: 'account-b' }),
      grantSubject: inspection.subject,
    });
    await expect(accountTurnover.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const directAccountToGroup = createHarness({
      initialSnapshot: snapshot({ groupId: 'speech-group-g' }),
      resolvedGroupAccountId: 'account-a',
      grantSubject: inspection.subject,
    });
    await expect(directAccountToGroup.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const groupApproved = createHarness({
      initialSnapshot: snapshot({ groupId: 'speech-group-g' }),
      resolvedGroupAccountId: 'account-a',
    });
    const groupInspection = await groupApproved.materializer.inspectAuthorization();
    const groupToOtherGroup = createHarness({
      initialSnapshot: snapshot({ groupId: 'speech-group-h' }),
      resolvedGroupAccountId: 'account-a',
      grantSubject: groupInspection.subject,
    });
    await expect(groupToOtherGroup.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    const groupTurnover = createHarness({
      initialSnapshot: snapshot({ groupId: 'speech-group-g' }),
      resolvedGroupAccountId: 'account-b',
      grantSubject: groupInspection.subject,
    });
    await expect(groupTurnover.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const savedApproved = createHarness({
      initialSnapshot: snapshot({
        source: 'savedSecret',
        scopeKey: 'account-a',
        secretId: 'saved-secret-a',
        secret: 'old-value',
      }),
    });
    const savedInspection = await savedApproved.materializer.inspectAuthorization();
    const savedTurnover = createHarness({
      initialSnapshot: snapshot({
        source: 'savedSecret',
        scopeKey: 'account-a',
        secretId: 'saved-secret-b',
        secret: 'new-value',
      }),
      grantSubject: savedInspection.subject,
    });
    await expect(savedTurnover.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const rotatedSavedCredential = createHarness({
      initialSnapshot: snapshot({
        source: 'savedSecret',
        scopeKey: 'account-a',
        secretId: 'saved-secret-a',
        secret: 'rotated-value',
        settingsVersion: 2,
      }),
      grantSubject: savedInspection.subject,
    });
    await expect(rotatedSavedCredential.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'rotated-value' },
    });

    const generationTurnover = createHarness({
      immutableGenerationId: 'generation-b',
      grantSubject: inspection.subject,
    });
    await expect(generationTurnover.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('fails closed without a selected source and never exposes selected authority material', async () => {
    const unselected = createHarness({ initialSnapshot: null });
    await expect(unselected.materializer.inspectAuthorization()).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const sensitiveScope = 'account-scope-must-not-leak';
    const sensitiveSecret = 'raw-secret-must-not-leak';
    const selected = createHarness({
      initialSnapshot: snapshot({
        source: 'savedSecret',
        scopeKey: sensitiveScope,
        secret: sensitiveSecret,
      }),
    });
    const inspection = await selected.materializer.inspectAuthorization();
    expect(JSON.stringify(inspection.subject)).not.toContain(sensitiveScope);
    expect(JSON.stringify(inspection.subject)).not.toContain(sensitiveSecret);
    expect(JSON.stringify(inspection.subject)).not.toContain('saved-secret-raw');
  });

  it('fails the authorized materialization when the principal or admitted runtime changes across it', async () => {
    let principalReads = 0;
    const principalTurnover = createHarness({
      readPrincipal: async () => principalSnapshot(++principalReads === 1 ? principalA : principalB),
    });
    // The grant list was evaluated for the principal read before it; a
    // principal that has since changed must not reach the credential.
    await expect(principalTurnover.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    let runtimeCurrent = true;
    const runtimeTurnover = createHarness({
      isRuntimeAuthorityCurrent: () => runtimeCurrent,
      readPrincipal: async () => {
        runtimeCurrent = false;
        return principalSnapshot(principalA);
      },
    });
    await expect(runtimeTurnover.materializer.inspectAuthorization()).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('uses the canonical selected Connected Account even when a dormant SavedSecret binding exists', async () => {
    const harness = createHarness();

    await expect(harness.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });
    expect(harness.listInputs.at(-1)).toMatchObject({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: {
        kind: 'credential_access_disclosure',
        contribution,
        credentialSlotId: 'api_key',
        purpose: 'voice.speech',
        installReviewPrincipalDigest: principalA,
      },
    });
    expect(harness.listInputs.at(-1)?.subject).toMatchObject({
      accessDeclarationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('waits for canonical Account Settings readiness before the initial credential admission', async () => {
    let harness!: ReturnType<typeof createHarness>;
    const ensureAccountSettingsSnapshot = vi.fn(async () => {
      harness.setSnapshot(snapshot());
    });
    harness = createHarness({
      initialSnapshot: null,
      ensureAccountSettingsSnapshot,
    });

    await expect(harness.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });
    expect(ensureAccountSettingsSnapshot).toHaveBeenCalledTimes(1);
  });

  it('projects only materialize and cannot follow a later credential source after its invocation returns', async () => {
    const materializeAccount = vi.fn(async ({ credentialRevisionBasis }) => {
      credentialRevisionBasis?.captureCredentialRevision(
        'csr_0123456789ABCDEFGHJKMNPQRS',
      );
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer connected:account-a' },
      };
    });
    const harness = createHarness({ materializeAccount });
    const materialize = vi.fn(harness.materializer.materialize);
    const lifetime = new AbortController();
    const raw = createInvocationVoiceRawCredentialAccess({
      materializer: { materialize },
      signal: lifetime.signal,
      isCurrent: () => true,
    });

    expect(Object.keys(raw)).toEqual(['materialize']);
    expect(Reflect.get(raw, 'inspectAuthorization')).toBeUndefined();
    await expect(raw.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });

    lifetime.abort();
    harness.setSnapshot(snapshot({ source: 'savedSecret' }));
    await expect(raw.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(materializeAccount).toHaveBeenCalledOnce();
  });

  it('pins one Connected Account credential revision for the full raw callback', async () => {
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let credentialRevision = revisionA;
    const harness = createHarness({
      materializeAccount: async ({ credentialRevisionBasis }) => {
        credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
        return {
          kind: 'httpHeaders',
          headers: { authorization: `Bearer ${credentialRevision}` },
        };
      },
    });
    const firstCallback = createInvocationVoiceRawCredentialAccess({
      materializer: harness.materializer,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await expect(firstCallback.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: `Bearer ${revisionA}` },
    });

    credentialRevision = revisionB;
    await expect(firstCallback.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const nextCallback = createInvocationVoiceRawCredentialAccess({
      materializer: harness.materializer,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    await expect(nextCallback.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: `Bearer ${revisionB}` },
    });
  });

  it('pins one opaque SavedSecret callback revision across same-id secret updates', async () => {
    const firstSecret = 'saved-secret-raw-a';
    const replacementSecret = 'saved-secret-raw-b';
    const harness = createHarness({
      initialSnapshot: snapshot({
        source: 'savedSecret',
        secret: firstSecret,
        secretUpdatedAt: 1,
      }),
    });
    let capturedCredentialRevision: string | null = null;

    await expect(harness.materializer.materialize(connectedHeaderRequest, {
      credentialRevisionBasis: {
        expectedCredentialRevision: null,
        captureCredentialRevision(credentialRevision) {
          capturedCredentialRevision = credentialRevision;
        },
      },
    })).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: firstSecret },
    });

    expect(capturedCredentialRevision).toMatch(/^csr_[a-f0-9]{64}$/u);
    expect(capturedCredentialRevision).not.toContain(firstSecret);
    expect(capturedCredentialRevision).not.toContain('saved-secret');

    harness.setSnapshot(snapshot({
      source: 'savedSecret',
      secret: replacementSecret,
      secretUpdatedAt: 2,
    }));

    await expect(harness.materializer.materialize(connectedHeaderRequest, {
      credentialRevisionBasis: {
        expectedCredentialRevision: capturedCredentialRevision,
        captureCredentialRevision() {},
      },
    })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('does not follow a changed credential source while its host invocation remains live', async () => {
    const materializeAccount = vi.fn(async ({ credentialRevisionBasis }) => {
      credentialRevisionBasis?.captureCredentialRevision(
        'csr_0123456789ABCDEFGHJKMNPQRS',
      );
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer connected:account-a' },
      };
    });
    const harness = createHarness({ materializeAccount });
    const materialize = vi.fn(harness.materializer.materialize);
    let settingsCurrent = true;
    const raw = createInvocationVoiceRawCredentialAccess({
      materializer: { materialize },
      signal: new AbortController().signal,
      // This is intentionally independent of the invocation AbortSignal:
      // a second materialization must not reselect a new credential source
      // while the provider callback itself is still running.
      isCurrent: () => settingsCurrent,
    });

    await expect(raw.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer connected:account-a' },
    });
    harness.setSnapshot(snapshot({ source: 'savedSecret' }));
    settingsCurrent = false;

    await expect(raw.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(materializeAccount).toHaveBeenCalledOnce();
  });

  it('drops an in-flight projected raw result when the host invocation aborts', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const harness = createHarness({
      materializeAccount: async ({ credentialRevisionBasis }) => {
        started.resolve();
        await release.promise;
        credentialRevisionBasis?.captureCredentialRevision(
          'csr_0123456789ABCDEFGHJKMNPQRS',
        );
        return {
          kind: 'httpHeaders' as const,
          headers: { authorization: 'Bearer stale' },
        };
      },
    });
    const lifetime = new AbortController();
    const raw = createInvocationVoiceRawCredentialAccess({
      materializer: harness.materializer,
      signal: lifetime.signal,
      isCurrent: () => true,
    });

    const operation = raw.materialize(connectedHeaderRequest);
    await started.promise;
    lifetime.abort();
    release.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('discards an in-flight Connected Account result when the selected account changes', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const harness = createHarness({
      materializeAccount: async ({ account }) => {
        started.resolve();
        await release.promise;
        return { kind: 'httpHeaders', headers: { authorization: `RAW:${account.accountId}` } };
      },
    });
    const operation = harness.materializer.materialize(connectedHeaderRequest);
    await started.promise;
    harness.setSnapshot(snapshot({ accountId: 'account-b' }));
    release.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
      message: 'Voice credential access is unavailable',
    });
    await expect(harness.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'RAW:account-b' },
    });
  });

  it('keeps an in-flight result across a semantically identical Account Settings rehydration', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const harness = createHarness({
      materializeAccount: async ({ account }) => {
        started.resolve();
        await release.promise;
        return { kind: 'httpHeaders', headers: { authorization: `RAW:${account.accountId}` } };
      },
    });
    const operation = harness.materializer.materialize(connectedHeaderRequest);
    await started.promise;
    harness.setSnapshot(snapshot({ accountId: 'account-a' }));
    release.resolve();

    await expect(operation).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'RAW:account-a' },
    });
  });

  it('discards an in-flight result after grant revocation', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const harness = createHarness({
      materializeAccount: async () => {
        started.resolve();
        await release.promise;
        return { kind: 'httpHeaders', headers: { authorization: 'RAW:revoked' } };
      },
    });
    const operation = harness.materializer.materialize(connectedHeaderRequest);
    await started.promise;
    harness.setGrantActive(false);
    release.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('does not materialize bytes when approving machine identity changes during grant authorization', async () => {
    for (const nextAuthoritySource of [machineB, replacedInstallationOnMachineA]) {
      let currentAuthoritySource: PluginPermissionGrantAuthoritySourceV1 = machineA;
      const materializeAccount = vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer must-not-materialize' },
      }));
      const harness = createHarness({
        materializeAccount,
        readCurrentAuthoritySource: async () => currentAuthoritySource,
        afterGrantListRead() {
          currentAuthoritySource = nextAuthoritySource;
        },
      });

      await expect(harness.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
        code: 'plugin_voice_credential_access_unavailable',
      });
      expect(materializeAccount).not.toHaveBeenCalled();
    }
  });

  it('does not return materialized bytes when approving machine identity changes in the final authorization inspection', async () => {
    for (const finalAuthoritySource of [
      sameInstallationOnMachineB,
      replacedInstallationOnMachineA,
    ]) {
      const authoritySources = [
        machineA,
        machineA,
        machineA,
        finalAuthoritySource,
      ] as const;
      const readCurrentAuthoritySource = vi.fn(async () => {
        const authoritySource = authoritySources[readCurrentAuthoritySource.mock.calls.length - 1];
        if (!authoritySource) throw new Error('unexpected authority-source inspection');
        return authoritySource;
      });
      const materializeAccount = vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer must-not-return' },
      }));
      const harness = createHarness({
        materializeAccount,
        readCurrentAuthoritySource,
      });

      await expect(harness.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
        code: 'plugin_voice_credential_access_unavailable',
      });
      expect(readCurrentAuthoritySource).toHaveBeenCalledTimes(4);
      expect(materializeAccount).toHaveBeenCalledTimes(1);
    }
  });

  it('discards results after principal or admitted-generation authority changes', async () => {
    for (const revoke of [
      (harness: ReturnType<typeof createHarness>) => harness.setPrincipal(principalB),
      (harness: ReturnType<typeof createHarness>) => harness.setGenerationCurrent(false),
    ]) {
      const started = deferred<void>();
      const release = deferred<void>();
      const harness = createHarness({
        materializeAccount: async () => {
          started.resolve();
          await release.promise;
          return { kind: 'httpHeaders', headers: { authorization: 'RAW:stale' } };
        },
      });
      const operation = harness.materializer.materialize(connectedHeaderRequest);
      await started.promise;
      revoke(harness);
      release.resolve();
      await expect(operation).rejects.toMatchObject({
        code: 'plugin_voice_credential_access_unavailable',
      });
    }
  });

  it('rejects an undeclared tuple before reading grants or materializing credentials', async () => {
    const materializeAccount = vi.fn();
    const harness = createHarness({ materializeAccount });

    await expect(harness.materializer.materialize({
      kind: 'httpHeaders',
      origin: 'https://speech.example.test',
      headerNames: ['x-not-declared'],
    })).rejects.toMatchObject({ code: 'plugin_voice_provider_result_invalid' });
    expect(harness.listInputs).toHaveLength(0);
    expect(materializeAccount).not.toHaveBeenCalled();
  });

  it('materializes the exact SavedSecret form and destination without exposing secret-bearing failures', async () => {
    const saved = createHarness({ initialSnapshot: snapshot({ source: 'savedSecret' }) });

    await expect(saved.materializer.materialize(connectedHeaderRequest)).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'saved-secret-raw' },
    });
    await expect(saved.materializer.materialize({
      kind: 'environment', keys: ['VOICE_TOKEN'],
    })).resolves.toEqual({
      kind: 'environment', env: { VOICE_TOKEN: 'saved-secret-raw' },
    });
    await expect(saved.materializer.materialize({
      kind: 'files', fileIds: ['voice-token'],
    })).resolves.toEqual({
      kind: 'files', files: { 'voice-token': new TextEncoder().encode('saved-secret-raw') },
    });

    const leaked = 'raw-connected-secret-that-must-not-escape';
    const failing = createHarness({
      materializeAccount: async () => { throw new Error(leaked); },
    });
    let failure: unknown;
    try {
      await failing.materializer.materialize(connectedHeaderRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'plugin_voice_provider_operation_failed',
      message: 'Voice provider operation failed',
    });
    expect(JSON.stringify(failure)).not.toContain(leaked);
    expect(String(failure)).not.toContain(leaked);
  });

  it('uses semantic SavedSecret currentness across unrelated Account Settings mutations and revokes real changes', async () => {
    const replacementCases = [{
      label: 'equivalent',
      next: snapshot({ source: 'savedSecret' }),
      allowed: true,
    }, {
      label: 'unrelated Account Settings mutation',
      next: snapshot({
        source: 'savedSecret',
        settingsVersion: 2,
        unrelatedVoiceProvider: true,
      }),
      allowed: true,
    }, {
      label: 'account switch',
      next: snapshot({ source: 'savedSecret', scopeKey: 'other-account' }),
      allowed: false,
    }, {
      label: 'secret deletion',
      next: snapshot({ source: 'savedSecret', includeSecret: false }),
      allowed: false,
    }, {
      label: 'selected credential revision',
      next: snapshot({ source: 'savedSecret', secretUpdatedAt: 2, settingsVersion: 2 }),
      allowed: false,
    }, {
      label: 'source change',
      next: snapshot({ source: 'connectedAccount' }),
      allowed: false,
    }] as const;

    for (const replacement of replacementCases) {
      const harness = createHarness({
        initialSnapshot: snapshot({ source: 'savedSecret' }),
        afterSnapshotRead(readNumber, replace) {
          if (readNumber === 3) replace(replacement.next);
        },
      });
      const operation = harness.materializer.materialize(connectedHeaderRequest);
      if (replacement.allowed) {
        await expect(operation, replacement.label).resolves.toEqual({
          kind: 'httpHeaders', headers: { authorization: 'saved-secret-raw' },
        });
      } else {
        await expect(operation, replacement.label).rejects.toMatchObject({
          code: 'plugin_voice_credential_access_unavailable',
        });
      }
    }
  });

  it('keeps Connected Account raw materialization current across unrelated Account Settings mutations', async () => {
    const replacementCases = [{
      label: 'unrelated Account Settings mutation',
      next: snapshot({
        source: 'connectedAccount',
        settingsVersion: 2,
        unrelatedVoiceProvider: true,
      }),
      allowed: true,
    }, {
      label: 'selected account change',
      next: snapshot({ source: 'connectedAccount', accountId: 'account-b', settingsVersion: 2 }),
      allowed: false,
    }, {
      label: 'selected source change',
      next: snapshot({ source: 'savedSecret', settingsVersion: 2 }),
      allowed: false,
    }] as const;

    for (const replacement of replacementCases) {
      const harness = createHarness({
        initialSnapshot: snapshot({ source: 'connectedAccount' }),
        afterSnapshotRead(readNumber, replace) {
          if (readNumber === 3) replace(replacement.next);
        },
      });
      const operation = harness.materializer.materialize(connectedHeaderRequest);
      if (replacement.allowed) {
        await expect(operation, replacement.label).resolves.toEqual({
          kind: 'httpHeaders', headers: { authorization: 'Bearer connected:account-a' },
        });
      } else {
        await expect(operation, replacement.label).rejects.toMatchObject({
          code: 'plugin_voice_credential_access_unavailable',
        });
      }
    }
  });

  it('rejects in-flight SavedSecret raw materialization after logout and same-Account reentry', async () => {
    let lifetimeToken = 1;
    let republished = false;
    const harness = createHarness({
      initialSnapshot: snapshot({ source: 'savedSecret' }),
      getLifetimeToken: () => lifetimeToken,
      afterSnapshotRead(readNumber, replace) {
        // The fifth read is after authorization and immediately before this
        // invocation rechecks the selected SavedSecret for disclosure. The
        // exact selected source/secret facts are republished unchanged; only
        // the canonical Account lifetime has retired and re-entered.
        if (readNumber === 5 && !republished) {
          republished = true;
          lifetimeToken += 1;
          replace(snapshot({ source: 'savedSecret', settingsVersion: 2 }));
        }
      },
    });

    await expect(harness.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(republished).toBe(true);
  });

  it('rejects in-flight Connected Account raw materialization after logout and same-Account reentry', async () => {
    let lifetimeToken = 1;
    const harness = createHarness({
      initialSnapshot: snapshot({ source: 'connectedAccount' }),
      getLifetimeToken: () => lifetimeToken,
      materializeAccount: async ({ account, credentialRevisionBasis, request }) => {
        if (request.kind !== 'httpHeaders') throw new Error('unsupported test request');
        // The provider-side materialization is the asynchronous boundary. The
        // re-entered Account publishes semantically identical selected facts,
        // but the captured incumbent lifetime is no longer current.
        lifetimeToken += 1;
        credentialRevisionBasis?.captureCredentialRevision(
          'csr_0123456789ABCDEFGHJKMNPQRS',
        );
        return {
          kind: 'httpHeaders',
          headers: Object.fromEntries(request.headerNames.map((name) => [
            name,
            `Bearer connected:${account.accountId}`,
          ])),
        };
      },
    });

    await expect(harness.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('rejects duplicate disclosure rows and manifest-relative duplicate Connected Account sources', () => {
    const harness = createHarness();
    const base = manifest();
    const provider = base.contributes.voiceProviders?.[0];
    if (!provider?.credentials) throw new Error('test manifest must have Voice credentials');
    const savedSource = provider.credentials.sources[0];
    const connectedSource = provider.credentials.sources[1];
    if (!savedSource?.rawGrants?.[0] || connectedSource?.kind !== 'connectedAccount') {
      throw new Error('test manifest must have raw credential sources');
    }
    const inspect = (unsafeManifest: typeof base) => createPluginRawCredentialAuthorizationInspector({
      binding: {
        manifest: unsafeManifest,
        contribution,
        realm: 'daemon',
        phase: 'speech',
        machineId: null,
        immutableGenerationId: 'generation-a',
        isRuntimeAuthorityCurrent: () => true,
      },
      currentInstallReviewPrincipal: { readCurrent: async () => principalSnapshot(principalA) },
      readCurrentGrantAuthoritySource: async () => machineA,
      connectedAccounts: harness.connectedAccounts,
      getAccountSettingsSnapshot: () => snapshot(),
    });
    // Deliberately bypasses manifest ingestion to prove the digest owner fails closed.
    const duplicateRows = {
      ...base,
      contributes: {
        ...base.contributes,
        voiceProviders: [{
          ...provider,
          credentials: {
            ...provider.credentials,
            sources: [{
              ...savedSource,
              rawGrants: [{
                realm: 'daemon', phase: 'speech',
                request: { kind: 'environment', keys: ['A', 'B'] },
              }, {
                realm: 'daemon', phase: 'speech',
                request: { kind: 'environment', keys: ['B', 'A'] },
              }],
            }, connectedSource],
          },
        }],
      },
    } as never;
    expect(() => inspect(duplicateRows)).toThrowError(expect.objectContaining({
      code: 'plugin_voice_provider_result_invalid',
    }));

    const duplicateService = {
      ...base,
      contributes: {
        ...base.contributes,
        voiceProviders: [{
          ...provider,
          credentials: {
            ...provider.credentials,
            sources: [savedSource, {
              ...connectedSource,
              service: 'oauth',
            }, {
              ...connectedSource,
              service: { pluginId: contribution.pluginId, localId: 'oauth' },
              rawGrants: [{
                realm: 'daemon', phase: 'speech',
                request: { kind: 'environment', keys: ['OTHER_TOKEN'] },
              }],
            }],
          },
        }],
      },
    } as never;
    expect(() => inspect(duplicateService)).toThrowError(expect.objectContaining({
      code: 'plugin_voice_provider_result_invalid',
    }));
  });

  it('does not trust spoofed producer PluginError codes or retain secret-bearing fields', async () => {
    const leaked = 'producer-secret-that-must-not-escape';
    for (const code of [
      'plugin_voice_provider_result_invalid',
      'plugin_voice_provider_operation_failed',
    ]) {
      const harness = createHarness({
        materializeAccount: async () => {
          throw new PluginError({
            code,
            message: leaked,
            details: { leaked },
            diagnostics: [{ code: 'producer_leak', severity: 'error', message: leaked }],
          });
        },
      });
      let failure: unknown;
      try {
        await harness.materializer.materialize(connectedHeaderRequest);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'plugin_voice_provider_operation_failed' });
      expect(String(failure)).not.toContain(leaked);
      expect(JSON.stringify(failure)).not.toContain(leaked);
    }
  });

  it('rejects missing, extra, or case-colliding Connected Account destinations and copies file bytes', async () => {
    const invalidHeaders: readonly Readonly<Record<string, string>>[] = [
      {},
      { authorization: 'raw', extra: 'raw' },
      { authorization: 'raw', Authorization: 'raw' },
    ];
    for (const headers of invalidHeaders) {
      const harness = createHarness({
        materializeAccount: async () => ({ kind: 'httpHeaders', headers }),
      });
      await expect(harness.materializer.materialize(connectedHeaderRequest)).rejects.toMatchObject({
        code: 'plugin_voice_provider_result_invalid',
      });
    }

    const invalidStarted = deferred<void>();
    const invalidRelease = deferred<void>();
    const staleInvalid = createHarness({
      materializeAccount: async () => {
        invalidStarted.resolve();
        await invalidRelease.promise;
        return { kind: 'httpHeaders', headers: {} };
      },
    });
    const staleInvalidOperation = staleInvalid.materializer.materialize(connectedHeaderRequest);
    await invalidStarted.promise;
    staleInvalid.setGrantActive(false);
    invalidRelease.resolve();
    await expect(staleInvalidOperation).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const producerBytes = new TextEncoder().encode('connected-file-secret');
    const fileHarness = createHarness({
      materializeAccount: async () => ({
        kind: 'files', files: { 'voice-token': producerBytes },
      }),
    });
    const result = await fileHarness.materializer.materialize({
      kind: 'files', fileIds: ['voice-token'],
    });
    expect(result).toEqual({
      kind: 'files', files: { 'voice-token': new TextEncoder().encode('connected-file-secret') },
    });
    producerBytes.fill(0);
    expect(result.kind === 'files' ? new TextDecoder().decode(result.files['voice-token']) : null)
      .toBe('connected-file-secret');
  });
});
