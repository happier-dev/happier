import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, composeProviderSettingsV1, splitProviderSettingsV1,
  openProviderConnectionsContentV1, sealProviderConnectionsContentV1, ProviderConnectionsCatalogV1Schema,
  StoredProviderConnectionsContentV1Schema, ProviderConnectionsMigrationContentV1Schema,
} from './connectionRowsV1.js';
import { loadProviderConnectionsCatalogV1, listProviderConnectionsCatalogSavedSecretRefsV1,
  readRetainedProviderConnectionsCatalogV1, rewriteProviderConnectionsCatalogSavedSecretRefsV1,
  prepareProviderConnectionImportV1 } from './providerConnectionsCatalogV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { ProviderSettingsV1Schema, parseProviderSettingsV1Narrow } from '../settings/v1.js';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { normalizeCustomProviderTemplateV1 } from './normalizeCustomTemplateV1.js';
import type { ProviderConnectionsCatalogV1 } from './connectionRowsV1.js';

const accountSecretRef = formatSharedSavedSecretRefV1('secret-account');
const machineSecretRef = formatSharedSavedSecretRefV1('secret-machine');

const connection = { v: 1 as const, id: 'pc_one', source: { kind: 'contribution' as const, contributionKey: 'plugin/provider' },
  role: 'default' as const, displayName: 'Provider', displayNameMode: 'automatic' as const, deployment: { kind: 'external' as const },
  revision: 0, createdAt: 1, updatedAt: 1 };
const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection],
  secretBindingsByConnectionId: { pc_one: { account: { apiKey: accountSecretRef }, byMachineId: { 'machine.with.dots': { apiKey: machineSecretRef } } } },
  manualModelsByConnectionId: { pc_one: [{ id: 'model/a', addedAt: 1 }] } };

describe('Provider connection catalog row owner', () => {
  it('normalizes retained envelopes before domain admission without disclosing invalid JSON', () => {
    for (const schema of [StoredProviderConnectionsContentV1Schema, ProviderConnectionsMigrationContentV1Schema]) {
      const original = { t: 'plain', v: { ...catalog, futureMetadata: { label: 'retained' } } };
      const admitted = schema.parse(original);
      original.v.futureMetadata.label = 'changed';
      expect(admitted).toEqual({ t: 'plain', v: { ...catalog, futureMetadata: { label: 'retained' } } });
      expect(schema.safeParse({ t: 'plain', v: { ...catalog, futureNumber: Number.NaN } }).success).toBe(false);
      let disclosed = false;
      const invalid = Object.defineProperty({ t: 'plain', v: catalog }, 'futureMetadata', {
        enumerable: true, get: () => { disclosed = true; return 'invalid accessor'; },
      });
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(disclosed).toBe(false);
    }
  });

  it.each(['plain', 'e2ee'] as const)('preserves connection scopes and models under its own mode envelope (%s)', mode => {
    const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(73) };
    const content = sealProviderConnectionsContentV1({ catalog, mode, material });
    expect(openProviderConnectionsContentV1({ content, mode, material })).toEqual({ status: 'opened', catalog });
    expect(openProviderConnectionsContentV1({ content, mode: mode === 'plain' ? 'e2ee' : 'plain', material: null })).toMatchObject({
      status: 'unavailable', reason: 'account-mode-mismatch',
    });
  });

  it('keeps selected unavailable intent in the genuine preference outside canonical catalog bodies', () => {
    const defaults = { 'agent:codex': { v: 1 as const, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_unavailable', modelId: 'model/a' }, updatedAt: 1 } };
    expect(splitProviderSettingsV1(composeProviderSettingsV1(catalog, defaults))).toEqual({ catalog, defaults });
    expect(ProviderSettingsV1Schema.safeParse(composeProviderSettingsV1(catalog, defaults)).success).toBe(true);
    expect(parseProviderSettingsV1Narrow(composeProviderSettingsV1(catalog, defaults)).settings.defaultsByAgentTargetKey).toEqual(defaults);
    expect(ProviderConnectionsCatalogV1Schema.safeParse({ ...catalog, defaultsByAgentTargetKey: defaults }).success).toBe(false);
  });

  it('owns malformed default preference recovery without exposing transferred Provider entities as effective Settings', () => {
    const raw = { providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} },
      providerDefaultModelSelectionsByAgentTargetKeyV1: { invalid: true }, theme: 'dark', futurePreference: { enabled: true } };
    const effective = accountSettingsParse(raw);
    expect(effective.providerDefaultModelSelectionsByAgentTargetKeyV1).toEqual({});
    expect(effective).not.toHaveProperty('providerSettingsV1');
    expect(effective.theme).toBe('dark');
    expect(effective.futurePreference).toEqual({ enabled: true });
    expect(readRetainedProviderConnectionsCatalogV1(raw)).toEqual({ status: 'ready', catalog, defaults: {} });
    expect(raw).toHaveProperty('providerSettingsV1');
  });

  it('addresses Account and Machine bindings through the same canonical reference owner', () => {
    expect(listProviderConnectionsCatalogSavedSecretRefsV1(catalog)).toEqual([
      { path: 'secretBindingsByConnectionId.pc_one.account.apiKey', secretId: accountSecretRef },
      { path: 'secretBindingsByConnectionId.pc_one.byMachineId["machine.with.dots"].apiKey', secretId: machineSecretRef },
    ]);
    expect(rewriteProviderConnectionsCatalogSavedSecretRefsV1(catalog, accountSecretRef, formatSharedSavedSecretRefV1('replacement')).secretBindingsByConnectionId.pc_one).toEqual({
      account: { apiKey: formatSharedSavedSecretRefV1('replacement') }, byMachineId: { 'machine.with.dots': { apiKey: machineSecretRef } },
    });
  });

  it('keeps personal references at the inactive S2 source seam but refuses them as active catalog authority', () => {
    const sourceCatalog = { ...catalog, secretBindingsByConnectionId: { pc_one: { account: { apiKey: 'personal-secret' } } } };
    expect(readRetainedProviderConnectionsCatalogV1({ providerSettingsV1: { ...sourceCatalog, defaultsByAgentTargetKey: {} } }))
      .toEqual({ status: 'ready', catalog: sourceCatalog, defaults: {} });
    expect(openProviderConnectionsContentV1({ content: { t: 'plain', v: sourceCatalog }, mode: 'plain', material: null }))
      .toEqual({ status: 'partial', catalog: sourceCatalog,
        diagnostics: [{ path: 'secretBindingsByConnectionId.pc_one.account.apiKey', reason: 'unclassified_reference' }] });
    expect(openProviderConnectionsContentV1({ content: { t: 'plain', v: sourceCatalog }, mode: 'plain', material: null, admission: 'migration' }))
      .toEqual({ status: 'partial', catalog: sourceCatalog,
        diagnostics: [{ path: 'secretBindingsByConnectionId.pc_one.account.apiKey', reason: 'unclassified_reference' }] });
    const malformedReference = { ...sourceCatalog, secretBindingsByConnectionId: { pc_one: { account: { apiKey: 'happier:shared-secret:v1:' } } } };
    expect(openProviderConnectionsContentV1({ content: { t: 'plain', v: malformedReference }, mode: 'plain', material: null }))
      .toEqual({ status: 'partial', catalog: malformedReference,
        diagnostics: [{ path: 'secretBindingsByConnectionId.pc_one.account.apiKey', reason: 'unclassified_reference' }] });
  });

  it.each(['plain', 'e2ee'] as const)('refuses to hide unknown reference carriers behind a stored projection (%s)', mode => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(73) };
    const retainedExtension = { ...catalog, futureLabel: 'retained' };
    const extendedContent = mode === 'plain' ? { t: 'plain', v: retainedExtension } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: 'account_provider_connections', material, payload: retainedExtension, randomBytes: length => new Uint8Array(length).fill(12),
    }) };
    expect(openProviderConnectionsContentV1({ content: extendedContent, mode, material: mode === 'plain' ? null : material }))
      .toEqual({ status: 'opened', catalog });
    const original = { ...catalog, futureCredentials: { bootstrapCredentialRef: 'secret-unknown' } };
    const content = mode === 'plain' ? { t: 'plain', v: original } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: 'account_provider_connections', material, payload: original, randomBytes: length => new Uint8Array(length).fill(11),
    }) };
    const diagnostics = [{ path: 'futureCredentials.bootstrapCredentialRef', reason: 'unclassified_reference' }];
    expect(openProviderConnectionsContentV1({ content, mode, material: mode === 'plain' ? null : material })).toEqual({
      status: 'partial', catalog, diagnostics,
    });
    expect(readRetainedProviderConnectionsCatalogV1({ providerSettingsV1: { ...original, defaultsByAgentTargetKey: {} } })).toEqual({
      status: 'partial', catalog, defaults: {}, diagnostics,
    });
  });

  it('isolates malformed independent records for display without granting transfer authority', async () => {
    const original = { ...catalog, connections: [connection, { invalid: true }] };
    expect(openProviderConnectionsContentV1({ content: { t: 'plain', v: original }, mode: 'plain', material: null })).toEqual({
      status: 'partial', catalog, diagnostics: [{ path: 'connections[1]', reason: 'invalid_record' }],
    });
    let initialized = false;
    const loaded = await loadProviderConnectionsCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }),
      transfer: { readSourceSnapshot: async () => ({ raw: { providerSettingsV1: { ...original, defaultsByAgentTargetKey: {} } }, version: 2 }),
        initializeCatalog: async () => { initialized = true; return { status: 'updated', revision: 0, cursor: 1 }; } } });
    expect(loaded).toEqual({ status: 'partial', revision: 'absent', catalog,
      diagnostics: [{ path: 'connections[1]', reason: 'invalid_record' }] });
    expect(initialized).toBe(false);
    expect(openProviderConnectionsContentV1({ content: { t: 'plain', v: { ...original, v: 2 } }, mode: 'plain', material: null })).toEqual({
      status: 'unavailable', reason: 'invalid-stored-content',
    });
  });

  it('a destination tombstone cannot recreate a retained source and cleanup preserves unrelated preferences', async () => {
    const source = { providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} }, theme: 'dark' };
    let initialized = false;
    let cleaned: Readonly<Record<string, unknown>> | null = null;
    const loaded = await loadProviderConnectionsCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'deleted', revision: 9 }),
      transfer: { readSourceSnapshot: async () => ({ raw: source, version: 4 }),
        initializeCatalog: async () => { initialized = true; return { status: 'updated', revision: 0, cursor: 1 }; },
        replaceSource: async ({ raw }) => { cleaned = raw; return { status: 'applied', settingsVersion: 5 }; },
        normalizeHistory: async () => ({ status: 'complete' }) } });
    expect(loaded).toEqual({ status: 'ready', revision: 9, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, cleanup: { status: 'complete' } });
    expect(initialized).toBe(false);
    expect(cleaned).toEqual({ theme: 'dark', providerDefaultModelSelectionsByAgentTargetKeyV1: {} });
  });

  it('an unreachable destination does not authorize a retained-source fallback or initialization', async () => {
    let sourceRead = false;
    const loaded = await loadProviderConnectionsCatalogV1({ mode: 'plain', material: null,
      readRow: async () => { throw new Error('transport unavailable'); },
      transfer: { readSourceSnapshot: async () => { sourceRead = true; return { raw: {}, version: 4 }; },
        initializeCatalog: async () => ({ status: 'updated', revision: 0, cursor: 1 }) } });
    expect(loaded).toEqual({ status: 'unavailable', reason: 'unreachable' });
    expect(sourceRead).toBe(false);
  });

  it('keeps admitted catalog authority when history cleanup transport is unavailable', async () => {
    let published = false;
    const loaded = await loadProviderConnectionsCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'present', revision: 3, content: { t: 'plain', v: catalog } }),
      onReadyBeforeCleanup: async () => { published = true; },
      transfer: { readSourceSnapshot: async () => ({ raw: {}, version: 4 }),
        initializeCatalog: async () => ({ status: 'updated', revision: 0, cursor: 1 }),
        replaceSource: async () => ({ status: 'applied', settingsVersion: 5 }),
        normalizeHistory: async () => { throw new Error('history transport unavailable'); } } });
    expect(loaded).toEqual({ status: 'ready', revision: 3, catalog,
      cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } });
    expect(published).toBe(true);
  });

  it.each(['applied', 'conflict'] as const)('hands selected intent to the genuine preference before runtime readiness (%s)', async outcome => {
    const defaults = { 'agent:codex': { v: 1 as const, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_one', modelId: 'model/a' }, updatedAt: 1 } };
    let raw: Readonly<Record<string, unknown>> = { providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: defaults }, theme: 'dark' };
    let published = false;
    let publishedDefault: unknown;
    const loaded = await loadProviderConnectionsCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'present', revision: 3, content: { t: 'plain', v: catalog } }),
      onReadyBeforeCleanup: async () => { published = true; publishedDefault = raw.providerDefaultModelSelectionsByAgentTargetKeyV1; },
      transfer: { readSourceSnapshot: async () => ({ raw, version: 4 }),
        initializeCatalog: async () => ({ status: 'updated', revision: 0, cursor: 1 }),
        replaceSource: async input => {
          if (outcome === 'conflict') return { status: 'conflict', currentSettingsVersion: 5 };
          raw = input.raw;
          return { status: 'applied', settingsVersion: 5 };
        }, normalizeHistory: async () => ({ status: 'complete' }) } });
    if (outcome === 'applied') {
      expect(loaded.status).toBe('ready');
      expect(publishedDefault).toEqual(defaults);
      expect(raw).not.toHaveProperty('providerSettingsV1');
    } else {
      expect(loaded).toEqual({ status: 'partial', revision: 3, catalog,
        diagnostics: [{ path: 'providerDefaultModelSelectionsByAgentTargetKeyV1', reason: 'source_preference_pending' }] });
      expect(published).toBe(false);
      expect(raw).toHaveProperty('providerSettingsV1');
    }
  });
});

describe('Provider catalog explicit connection import', () => {
  // Chat fields are the genuine predecessor vector asserted by
  // voiceSettings.selectionCompatibility.test.ts; extraction/material stay Voice/S2 owned.
  const legacyChat = { chatBaseUrl: 'https://chat.compatibility.test/v1', chatModel: 'compatibility-chat',
    commitModel: 'compatibility-commit', temperature: 0.37 };
  const importedRef = formatSharedSavedSecretRefV1('legacy-chat-resource');
  const candidate = {
    connection: { v: 1 as const, id: 'voice-openai-compatible-chat', role: 'named' as const,
      displayName: 'Voice OpenAI-compatible Chat', displayNameMode: 'custom' as const, deployment: { kind: 'external' as const },
      source: { kind: 'custom' as const, template: normalizeCustomProviderTemplateV1({ name: 'Voice OpenAI-compatible Chat',
        protocol: 'openai-chat', baseUrl: legacyChat.chatBaseUrl, credentialStyle: 'bearer', catalog: 'manual' }) },
      revision: 0, createdAt: 0, updatedAt: 0 },
    secretBindings: { account: { apiKey: importedRef } },
    manualModels: [legacyChat.chatModel, legacyChat.commitModel].map(id => ({ id, addedAt: 0 })),
  };

  it.each(['absent', 'ready'] as const)('imports into %s authority without inventing a Profile source or rewriting Voice', async initial => {
    const source = { voice: { adapters: { local_conversation: { agent: { backend: 'openai_compat',
      agentSource: 'agent', agentId: 'opencode', openaiCompat: legacyChat } } } }, theme: 'dark' };
    const before = structuredClone(source);
    let current: ProviderConnectionsCatalogV1 | undefined = initial === 'ready' ? catalog : undefined;
    let revision = 3;
    let commits = 0;
    const input = { mode: 'plain' as const, material: null,
      readRow: async () => current ? { status: 'present' as const, revision, content: { t: 'plain' as const, v: current } }
        : { status: 'absent' as const },
      transfer: { readSourceSnapshot: async () => ({ raw: source, version: 8 }),
        initializeCatalog: async (mutation: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>) => {
          expect(mutation).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 8 });
          current = mutation.catalog;
          return { status: 'updated' as const, revision, cursor: revision };
        } },
      importConnection: { candidate, isCurrent: () => true,
        commitCatalog: async (mutation: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number }>) => {
          expect(mutation.expectedRevision).toBe(revision);
          commits += 1;
          current = mutation.catalog;
          revision += 1;
          return { status: 'applied' as const };
        } },
    };
    await expect(loadProviderConnectionsCatalogV1(input)).resolves.toMatchObject({ status: 'applied',
      connectionId: candidate.connection.id, catalog: { status: 'ready', revision: 4 } });
    expect(current?.connections.map(entry => entry.id)).toEqual(initial === 'ready' ? ['pc_one', candidate.connection.id] : [candidate.connection.id]);
    expect(current?.secretBindingsByConnectionId[candidate.connection.id]).toEqual(candidate.secretBindings);
    expect(current?.manualModelsByConnectionId[candidate.connection.id]).toEqual(candidate.manualModels);
    expect(current?.migration).toBeUndefined();
    expect(source).toEqual(before);
    expect(commits).toBe(1);
  });

  it.each(['conflict', 'refused', 'outcome_unknown', 'different-winner'] as const)('keeps an explicit %s outcome instead of authorizing Voice selection', async outcome => {
    let current: ProviderConnectionsCatalogV1 = catalog;
    let commits = 0;
    const input = { mode: 'plain' as const, material: null,
      readRow: async () => ({ status: 'present' as const, revision: 5, content: { t: 'plain' as const, v: current } }),
      importConnection: { candidate, isCurrent: () => true,
        commitCatalog: async (mutation: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number }>) => {
          commits += 1;
          if (outcome === 'different-winner') return { status: 'applied' as const };
          if (outcome === 'outcome_unknown') { current = mutation.catalog; return { status: 'outcome_unknown' as const }; }
          return outcome === 'refused' ? { status: 'refused' as const, reason: 'material-unavailable' }
            : { status: 'conflict' as const };
        } },
    };
    const result = await loadProviderConnectionsCatalogV1(input);
    expect(result).toMatchObject(outcome === 'refused' ? { status: 'unavailable', reason: 'material-unavailable' }
      : { status: outcome === 'different-winner' ? 'conflict' : outcome });
    expect(commits).toBe(1);
  });

  it.each(['cancelled', 'scope-retired', 'personal-reference'] as const)('refuses %s before dispatching imported facts', async refusal => {
    const controller = new AbortController();
    let commits = 0;
    const input = { mode: 'plain' as const, material: null, signal: controller.signal,
      readRow: async () => {
        if (refusal === 'cancelled') controller.abort();
        return { status: 'present' as const, revision: 5, content: { t: 'plain' as const, v: catalog } };
      },
      importConnection: { candidate: refusal === 'personal-reference' ? { ...candidate, secretBindings: { account: { apiKey: 'old-personal-id' } } } : candidate,
        isCurrent: () => refusal !== 'scope-retired', commitCatalog: async () => { commits += 1; return { status: 'applied' as const }; } },
    };
    await expect(loadProviderConnectionsCatalogV1(input)).resolves.toMatchObject(refusal === 'personal-reference'
      ? { status: 'invalid' } : refusal === 'cancelled' ? { status: 'cancelled' }
        : { status: 'unavailable', reason: 'scope-retired' });
    expect(commits).toBe(0);
  });

  it.each(['deleted-row', 'connection-tombstone', 'partial-catalog', 'descriptor-conflict'] as const)('does not overwrite or recreate %s during legacy preparation', async refusal => {
    let commits = 0;
    const current = refusal === 'connection-tombstone' ? { ...catalog, connectionTombstones: [{
      v: 1 as const, id: candidate.connection.id, contributionKey: null, lastDisplayName: candidate.connection.displayName, deletedAt: 2,
    }] } : refusal === 'descriptor-conflict' ? { ...catalog, connections: [...catalog.connections, {
      ...candidate.connection, source: { kind: 'custom' as const, template: normalizeCustomProviderTemplateV1({
        name: 'User-edited Provider', protocol: 'openai-chat', baseUrl: 'https://edited.example/v1', credentialStyle: 'bearer', catalog: 'manual',
      }) },
    }] } : refusal === 'partial-catalog' ? { ...catalog, connections: [...catalog.connections, { malformed: true }] } : catalog;
    const input = { mode: 'plain' as const, material: null,
      readRow: async () => refusal === 'deleted-row' ? { status: 'deleted' as const, revision: 5 }
        : { status: 'present' as const, revision: 5, content: { t: 'plain' as const, v: current } },
      importConnection: { candidate, isCurrent: () => true,
        commitCatalog: async () => { commits += 1; return { status: 'applied' as const }; } },
    };
    await expect(loadProviderConnectionsCatalogV1(input)).resolves.toMatchObject({
      status: refusal === 'partial-catalog' ? 'unavailable' : 'conflict',
    });
    expect(commits).toBe(0);
  });

  it('recognizes durable imported facts without replaying material or discarding user presentation', async () => {
    const existingConnection = { ...candidate.connection, displayName: 'Renamed by user', revision: 4, updatedAt: 9 };
    const current = { ...catalog, connections: [...catalog.connections, existingConnection],
      secretBindingsByConnectionId: { ...catalog.secretBindingsByConnectionId, [candidate.connection.id]: candidate.secretBindings },
      manualModelsByConnectionId: { ...catalog.manualModelsByConnectionId,
        [candidate.connection.id]: candidate.manualModels.map(model => ({ ...model, name: 'User model name', addedAt: 4 })) } };
    let commits = 0;
    const input = { mode: 'plain' as const, material: null,
      readRow: async () => ({ status: 'present' as const, revision: 5, content: { t: 'plain' as const, v: current } }),
      importConnection: { candidate, isCurrent: () => true,
        commitCatalog: async () => { commits += 1; return { status: 'applied' as const }; } },
    };
    await expect(loadProviderConnectionsCatalogV1(input)).resolves.toMatchObject({ status: 'unchanged',
      connectionId: candidate.connection.id, catalog: { catalog: current } });
    expect(commits).toBe(0);
  });

  it('returns typed invalid for a malformed namespaced binding instead of throwing from the reference codec', () => {
    expect(prepareProviderConnectionImportV1(catalog, { ...candidate,
      secretBindings: { account: { apiKey: 'happier:shared-secret:v1:' } },
    })).toEqual({ status: 'invalid' });
  });
});
