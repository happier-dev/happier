import { describe, expect, it, vi } from 'vitest';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import { preparePluginContributionPointDeclarationsV1, rehydratePluginContributionPointSemanticsV1 } from '../contributions/targetedContributions.js';
import * as availability from './index.js';
import { PluginReleaseRefV1Schema as PluginReleaseRefV1NeutralSchema } from './releaseRefV1.js';
import {
  PluginAccountPluginUiArtifactLinkV1Schema,
  PluginAccountPluginIntentV1Schema,
  PluginMachineMaterializationV1Schema,
  PluginMachineMaterializationRefV1Schema,
  PluginMachineMaterializationSnapshotV1Schema,
  PluginReleaseFactsV1Schema,
  createPluginCompatibilityProjectionV1,
  PluginUiReleaseSlotV1Schema,
  isExactPluginMachineMaterializationReleaseCorrespondenceV1,
  isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
  normalizePluginMachineMaterializationSnapshotV1,
  normalizePluginReleaseFactsV1,
  pluginReleaseFactsEqualV1,
} from './v1.js';
import {
  PluginReleaseRefV1Schema as PluginReleaseRefV1PublicSchema,
  PluginReleaseVersionV1Schema,
} from './index.js';

it('reads the current declaration as an identity, and named bodies once each', () => {
  const declaration = availability.PluginPortableReleaseManifestV1Schema.parse(manifest());
  const digest = `sha256:${'c'.repeat(64)}`;
  const read = { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null,
    release: null, uiArtifacts: [], packageAssets: [], currentDeclaration: { declarationDigestSha256: digest } };
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse(read).currentDeclaration)
    .toEqual(read.currentDeclaration);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...read, currentDeclaration: null }))
    .toHaveProperty('currentDeclaration', null);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    currentDeclaration: { ...read.currentDeclaration, ignoredAuthority: true } }).success).toBe(false);
  // Identities never carry bodies; bodies arrive only as named declarationBodies.
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    currentDeclaration: { ...read.currentDeclaration, manifest: declaration } }).success).toBe(false);
  const withBodies = { ...read, declarationBodies: [{ declarationDigestSha256: digest, manifest: declaration }] };
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse(withBodies)).toEqual(withBodies);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...withBodies,
    declarationBodies: [{ declarationDigestSha256: digest, manifest: { ...declaration, version: 'invalid-semver' } }] }).success).toBe(false);
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.2.3',
    displayName: 'Fixture',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {},
    ...overrides,
  };
}

it('reads per-Machine declaration identities without inventing an Account-selected declaration', () => {
  const declaration = { declarationDigestSha256: `sha256:${'c'.repeat(64)}` };
  const read = { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null,
    release: null, uiArtifacts: [], packageAssets: [], currentDeclaration: null,
    machineDeclarations: [{ machineId: 'machine-a', machineInstallationId: 'installation-a', declaration }] };
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse(read)).toEqual(read);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    machineDeclarations: [{ ...read.machineDeclarations[0], ignoredAuthority: true }] }).success).toBe(false);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    machineDeclarations: [{ ...read.machineDeclarations[0], declaration: { ...declaration, ignoredAuthority: true } }] }).success).toBe(false);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    machineDeclarations: [{ ...read.machineDeclarations[0], declaration: { ...declaration,
      manifest: availability.PluginPortableReleaseManifestV1Schema.parse(manifest()) } }] }).success).toBe(false);
  expect(availability.PluginAccountAvailabilityIntentReadResponseV1Schema.safeParse({ ...read,
    machineDeclarations: [{ ...read.machineDeclarations[0], declaration: { declarationDigestSha256: 'invalid' } }] }).success).toBe(false);
});

function contractDigest(fill: string): string {
  return fill.repeat(43);
}

function packageAssetArchive(resources: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
    resources,
  };
}

describe('Plugin Account availability v1', () => {
  it.each(['release', 'compatibility', 'materialization'] as const)(
    'keeps %s declaration facts strict instead of rewriting a contribution before persistence or comparison',
    (kind) => {
      const parse = (declaration: unknown) => {
        if (kind === 'release') return PluginReleaseFactsV1Schema.safeParse({
          ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
          archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
          normalizedManifest: declaration, collectionContracts: [], uiSlots: [],
          packageAssetArchive: packageAssetArchive(),
        });
        if (kind === 'compatibility') return availability.PluginCompatibilityProjectionV1Schema.safeParse({
          version: 1, manifest: declaration, uiArtifacts: { version: 2, entries: [] },
        });
        return PluginMachineMaterializationV1Schema.safeParse({
          serverIdentityId: 'srv_availability_fixture', machineId: 'machine-1',
          materializationId: 'install-epoch-1', pluginId: 'com.acme.fixture', version: '1.2.3',
          sourceClass: 'registryPackage', portableRelease: true, declaredManifest: declaration,
          uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
        });
      };
      expect(parse(manifest()).success).toBe(true);
      expect(parse(manifest({ contributes: { actions: [{
        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['plugin'],
        execution: { target: 'daemon' }, dangerLevel: 'safe', futureRestriction: true,
      }] } })).success).toBe(false);
    },
  );
  it('admits raw release facts once and compares typed facts without re-admission or signing', () => {
    const input = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest(),
      collectionContracts: [], uiSlots: [], packageAssetArchive: packageAssetArchive(),
    };
    const parse = vi.spyOn(PluginReleaseFactsV1Schema, 'parse');
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
      const admitted = normalizePluginReleaseFactsV1(input);
      expect(parse).toHaveBeenCalledTimes(1);
      const independentlyParsed = PluginReleaseFactsV1Schema.parse(input);
      parse.mockClear(); serialize.mockClear();
      expect(pluginReleaseFactsEqualV1(admitted, independentlyParsed)).toBe(true);
      expect(parse).not.toHaveBeenCalled();
      expect(serialize).not.toHaveBeenCalled();
      expect(Object.isFrozen(admitted.normalizedManifest.engines)).toBe(true);
      const raw = Object.freeze({ ...input });
      const copied = normalizePluginReleaseFactsV1(raw);
      expect(copied).not.toBe(raw);
      expect(parse.mock.calls.length).toBeGreaterThan(0);
      input.normalizedManifest.displayName = 'Changed caller';
      expect(normalizePluginReleaseFactsV1(raw).normalizedManifest.displayName).toBe('Changed caller');
      expect(copied.normalizedManifest.displayName).toBe('Fixture');
      expect(admitted.normalizedManifest.displayName).toBe('Fixture');
      expect(pluginReleaseFactsEqualV1(admitted, normalizePluginReleaseFactsV1(raw))).toBe(false);
      expect(() => normalizePluginReleaseFactsV1(Object.freeze({ ...input, unexpected: true }))).toThrow();
      expect(() => normalizePluginReleaseFactsV1({ ...admitted, normalizedManifest: { ...admitted.normalizedManifest, id: 'com.acme.other' } })).toThrow();
      expect(() => normalizePluginReleaseFactsV1({ ...admitted, archiveDigestSha256: 'invalid' })).toThrow();
    } finally { parse.mockRestore(); serialize.mockRestore(); }
  });
  it('prepares exact declaration bytes without rejecting an Account release for unsupported point semantics', () => {
    const schemas = [defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }).jsonSchema,
      { not: { type: 'null' } }, { $ref: '#/$defs/missing' }, { type: 'string', enum: undefined }];
    const parsed = PluginReleaseFactsV1Schema.parse({
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest({ contributes: { pluginContributionPoints: schemas.map((inputSchema, index) => ({
        id: `point-${index}`, protocols: [{ id: 'detail', version: 1, operations: {},
          surfaces: { detail: { required: true, presentation: 'content', inputSchema } } }],
      })) } }), collectionContracts: [], uiSlots: [], packageAssetArchive: packageAssetArchive(),
    });
    expect(rehydratePluginContributionPointSemanticsV1(parsed.normalizedManifest.contributes
      .pluginContributionPoints[3]!.protocols[0]!)).toBeNull();
    const normalized = normalizePluginReleaseFactsV1(parsed);
    expect(JSON.stringify(normalized.normalizedManifest)).toBe(JSON.stringify(parsed.normalizedManifest));
    expect(pluginReleaseFactsEqualV1(normalized, normalized)).toBe(true);
    const semantics = normalized.normalizedManifest.contributes.pluginContributionPoints.map(point =>
      rehydratePluginContributionPointSemanticsV1(point.protocols[0]!));
    expect(semantics[0]).not.toBeNull();
    expect(semantics.slice(1)).toEqual([null, null, null]);
    const intentRead = availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
      availabilityCursor: 1, hostingCapability: { enabled: false }, release: normalized, uiArtifacts: [], packageAssets: [],
      intent: { pluginId: parsed.ref.pluginId, desiredVersion: parsed.ref.version, enabled: true,
        offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
    });
    expect(availability.resolvePluginAccountExecutionSelectionV1({ pluginId: parsed.ref.pluginId, intentRead }))
      .toMatchObject({ kind: 'available', manifest: normalized.normalizedManifest });
    const rawProtocol = parsed.normalizedManifest.contributes.pluginContributionPoints[3]!.protocols[0]!;
    const rawSchema = rawProtocol.surfaces!.detail!.inputSchema;
    const prepared = preparePluginContributionPointDeclarationsV1(parsed.normalizedManifest.contributes);
    expect(prepared.pluginContributionPoints[3]!.protocols[0]!.surfaces!.detail!.inputSchema).toBe(rawSchema);
    expect(Object.keys(normalized.normalizedManifest.contributes.pluginContributionPoints[3]!.protocols[0]!
      .surfaces!.detail!.inputSchema)).toEqual(Object.keys(rawSchema));
    expect(rehydratePluginContributionPointSemanticsV1(rawProtocol)).toBeNull();
    expect(Reflect.deleteProperty(rawSchema, 'enum')).toBe(true);
    Object.assign(rawSchema, schemas[0]);
    expect(rehydratePluginContributionPointSemanticsV1(rawProtocol)?.surfaces[0]!.inputSchema.safeParse({ id: 'repaired' }).success).toBe(true);
    expect(rehydratePluginContributionPointSemanticsV1(normalized.normalizedManifest.contributes
      .pluginContributionPoints[3]!.protocols[0]!)).toBeNull();
  });
  it('selects host declarations by package and version independently of contribution content', () => {
    const declaration = availability.PluginPortableReleaseManifestV1Schema.parse(manifest());
    const input = { packageName: '@acme/fixture', manifest: declaration };
    const first = availability.createPluginAccountBundledSelectionV1(input);
    expect(first.manifest).toBe(declaration);
    expect(first.sourceCustody).toEqual({ kind: 'bundled_first_party', packagedRuntime: {
      kind: 'source_declaration', packageName: input.packageName,
    } });
    expect(availability.createPluginAccountBundledSelectionV1({ ...input, manifest: {
      ...declaration, contributes: { ...declaration.contributes, actions: [{
        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
        execution: { target: 'daemon' },
      }] },
    } }).custodyId).toBe(first.custodyId);
    expect(availability.createPluginAccountBundledSelectionV1({ ...input,
      manifest: { ...declaration, version: '2.0.0' },
    }).custodyId).not.toBe(first.custodyId);
    expect(availability.createPluginAccountBundledSelectionV1({ ...input,
      packageName: '@acme/other',
    }).custodyId).not.toBe(first.custodyId);
    const packaged = { kind: 'bundled_first_party', packagedRuntime: {
      kind: 'pinned_runner_snapshot', snapshotId: 'runner-snapshot',
    } } as const;
    expect(availability.createPluginAccountBundledSelectionV1({ ...input,
      sourceCustody: packaged,
    }).sourceCustody).toBe(packaged);
  });
  it('selects explicit enabled Account releases before bundled custody and fails closed', () => {
    const bundled = {
      manifest: availability.PluginPortableReleaseManifestV1Schema.parse(manifest()),
      sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'host' } } as const,
      custodyId: 'host-fixture',
    };
    const read = availability.PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
      availabilityCursor: 1, hostingCapability: { enabled: false },
      intent: { pluginId: bundled.manifest.id, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
      release: null, uiArtifacts: [], packageAssets: [],
    });
    const selected = availability.resolvePluginAccountExecutionSelectionV1({ pluginId: bundled.manifest.id, intentRead: read, bundled });
    expect(selected).toMatchObject({ kind: 'available', custodyId: 'host-fixture' });
    if (selected.kind !== 'available') throw new Error('Expected bundled selection');
    // Currentness reads retain the acquisition parser's declaration. Re-parsing
    // here clones the contribution graph on every rendered host-method check.
    expect(selected.manifest).toBe(bundled.manifest);
    expect(availability.resolvePluginAccountExecutionSelectionV1({ pluginId: bundled.manifest.id, intentRead: {
      ...read, intent: { ...read.intent!, enabled: false },
    }, bundled })).toEqual({ kind: 'unavailable', code: 'plugin_disabled' });
    expect(availability.resolvePluginAccountExecutionSelectionV1({ pluginId: bundled.manifest.id, intentRead: {
      ...read, intent: { ...read.intent!, desiredVersion: '2.0.0' },
    }, bundled })).toEqual({ kind: 'unavailable', code: 'plugin_release_unavailable' });
    const release = normalizePluginReleaseFactsV1({
      ref: { pluginId: bundled.manifest.id, version: bundled.manifest.version },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: bundled.manifest,
      collectionContracts: [], uiSlots: [], packageAssetArchive: packageAssetArchive(),
    });
    const selectedRead = { ...read, release, intent: { ...read.intent!, desiredVersion: release.ref.version } };
    const account = availability.resolvePluginAccountExecutionSelectionV1({ pluginId: bundled.manifest.id, intentRead: selectedRead, bundled });
    expect(account.kind).toBe('available');
    if (account.kind !== 'available') throw new Error('Expected Account release');
    expect(account.release).toBe(release);
    expect(account.manifest).toBe(release.normalizedManifest);
    expect(availability.resolvePluginAccountExecutionSelectionV1({ pluginId: bundled.manifest.id,
      intentRead: { ...selectedRead, intent: { ...selectedRead.intent, enabled: false } }, bundled,
    })).toEqual({ kind: 'unavailable', code: 'plugin_disabled' });
  });
  it('compares complete generated compatibility metadata beyond former count and byte cutoffs', () => {
    const entries = Array.from({ length: 129 }, (_, index) => {
      const artifactId = `panel-${index}`;
      const entry = `hosted-web/${artifactId}/index.html`;
      return {
        artifactId, tier: 'hostedWeb' as const, entry,
        files: [{ relativePath: entry, digest: `sha256:${'a'.repeat(64)}` as const, byteSize: 1 }],
        digest: `sha256:${'b'.repeat(64)}` as const,
        builtWith: { staging: 'staticDirectory' as const }, hostUiApiRange: '^1.0.0',
      };
    });
    const first = entries[0]!;
    first.files.push(...Array.from({ length: 8000 }, (_, index) => ({
      relativePath: `hosted-web/${first.artifactId}/assets/file-${index}.js`,
      digest: `sha256:${'a'.repeat(64)}` as const, byteSize: 1,
    })));
    const projection = createPluginCompatibilityProjectionV1({
      manifest: availability.PluginPortableReleaseManifestV1Schema.parse(manifest()),
      uiArtifacts: { version: 2, entries },
    });
    expect(projection.uiArtifacts.entries).toHaveLength(129);
    expect(new TextEncoder().encode(createCanonicalJsonSigningInput(projection)).byteLength).toBeGreaterThan(1024 * 1024);
  });

  it('keeps release-less preparation inside the closed writer claim envelope', () => {
    const input = { manifest: manifest(), prepare: true };
    const parsed = availability.PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(input);
    expect(parsed.prepare).toBe(true);
    expect(availability.PluginAvailabilityCollectionWritersClaimActionInputV1Schema.safeParse({ ...input, prepare: false }).success).toBe(false);
    expect(availability.PluginAvailabilityCollectionWritersClaimActionInputV1Schema.safeParse({ ...input, accountId: 'forged' }).success).toBe(false);
    expect(availability.PluginAvailabilityCollectionWritersClaimActionInputV1Schema.safeParse({ ...input, callbacks: {} }).success).toBe(false);
  });
  it('keeps ordinary UI Artifact reads current-render fenced while admitting one explicit candidate-preparation purpose', () => {
    const target = {
      release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      contributionId: 'hosted',
      artifactId: 'hosted-renderer',
      tier: 'hostedWeb',
      platform: 'web',
    } as const;
    const expectedArtifactDigest = `sha256:${'a'.repeat(64)}`;

    expect(availability.PluginAvailabilityUiArtifactReadActionInputV1Schema.parse(target)).toEqual(target);
    expect(availability.PluginAvailabilityUiArtifactReadActionInputV1Schema.parse({
      ...target,
      purpose: 'candidatePreparation',
      expectedArtifactDigest,
    })).toEqual({
      ...target,
      purpose: 'candidatePreparation',
      expectedArtifactDigest,
    });
    expect(availability.PluginAvailabilityUiArtifactReadActionInputV1Schema.safeParse({
      ...target,
      purpose: 'candidatePreparation',
    }).success).toBe(false);
    expect(availability.PluginAvailabilityUiArtifactReadActionInputV1Schema.safeParse({
      ...target,
      expectedArtifactDigest,
    }).success).toBe(false);
    expect(availability.PluginAvailabilityUiArtifactReadActionInputV1Schema.safeParse({
      ...target,
      purpose: 'renderWithoutCurrentIntent',
    }).success).toBe(false);
    expect(availability.PluginAvailabilityUiArtifactRemoveActionInputV1Schema.safeParse({
      ...target,
      purpose: 'candidatePreparation',
    }).success).toBe(false);
  });

  it('persists one semantic UI release slot and matches an Account carrier without transient host facts', () => {
    const portableSlot = {
      contributionId: 'native',
      artifactId: 'native-renderer',
      tier: 'reactNative' as const,
      platform: 'ios' as const,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      hostUiApiRange: '^1.0.0',
    };

    expect(PluginUiReleaseSlotV1Schema.parse(portableSlot)).toEqual(portableSlot);
    const artifactGraph = {
      artifactId: portableSlot.artifactId, tier: portableSlot.tier,
      entry: 'react-native/native-renderer/entry.cjs.bundle', digest: portableSlot.artifactDigest,
      files: [{ relativePath: 'react-native/native-renderer/entry.cjs.bundle', digest: portableSlot.artifactDigest, byteSize: 1 }],
      builtWith: { bundler: 'esbuild', version: '1.0.0' },
      executable: { exports: ['activate'] }, hostUiApiRange: portableSlot.hostUiApiRange,
    };
    expect(PluginUiReleaseSlotV1Schema.parse({ ...portableSlot, artifactGraph }))
      .toEqual({ ...portableSlot, artifactGraph });
    expect(PluginUiReleaseSlotV1Schema.safeParse({ ...portableSlot,
      artifactGraph: { ...artifactGraph, digest: `sha256:${'a'.repeat(64)}` },
    }).success).toBe(false);
    expect(PluginUiReleaseSlotV1Schema.safeParse({
      ...portableSlot,
      hostAppVersion: '2.0.0',
    }).success).toBe(false);

    const link = {
      release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      contributionId: portableSlot.contributionId,
      artifactId: portableSlot.artifactId,
      tier: portableSlot.tier,
      platform: portableSlot.platform,
      accountArtifactId: '00000000-0000-4000-8000-000000000001',
      artifactDigest: portableSlot.artifactDigest,
      hostUiApiRange: portableSlot.hostUiApiRange,
    };
    expect(PluginAccountPluginUiArtifactLinkV1Schema.parse(link)).toEqual(link);
    expect(isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(portableSlot, link)).toBe(true);
    expect(isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(portableSlot, {
      ...link,
      artifactId: 'other-renderer',
    })).toBe(false);
  });

  it('does not make a framework-free hosted release slot depend on transient host React facts', () => {
    const portableSlot = PluginUiReleaseSlotV1Schema.parse({
      contributionId: 'hosted',
      artifactId: 'hosted-renderer',
      tier: 'hostedWeb',
      platform: 'web',
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      hostUiApiRange: '^1.0.0',
    });
    const link = {
      release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      ...portableSlot,
      accountArtifactId: '00000000-0000-4000-8000-000000000001',
    };

    expect(isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
      portableSlot,
      link,
    )).toBe(true);
    expect(isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(portableSlot, {
      ...link,
      hostUiApiRange: '^2.0.0',
    })).toBe(false);
  });

  it('rejects exact-version and framework compatibility branches beside the one host API range', () => {
    expect(PluginUiReleaseSlotV1Schema.safeParse({
      contributionId: 'native', artifactId: 'native-renderer', tier: 'reactNative', platform: 'ios',
      artifactDigest: `sha256:${'d'.repeat(64)}`, hostUiApiRange: '^1.0.0',
      compatibility: { hostUiApiVersion: '1.0.0', reactVersion: '19.2.0' },
    }).success).toBe(false);
  });

  it('exports the availability grammar through its dedicated public family', () => {
    expect(PluginReleaseRefV1PublicSchema).toBe(PluginReleaseRefV1NeutralSchema);
    expect(PluginReleaseVersionV1Schema.parse('1.2.3')).toBe('1.2.3');
    expect(PluginReleaseRefV1PublicSchema.parse({
      pluginId: 'com.acme.fixture',
      version: '1.2.3',
    })).toEqual({ pluginId: 'com.acme.fixture', version: '1.2.3' });

    expect(PluginReleaseRefV1PublicSchema.safeParse({
      pluginId: 'com.acme.fixture',
      version: `1.2.3-${'a'.repeat(251)}`,
    }).success).toBe(false);
  });

  it('binds one portable release coordinate to strict normalized facts and canonical slot/collection order', () => {
    const normalized = normalizePluginReleaseFactsV1({
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest(),
      collectionContracts: [
        { pluginId: 'com.acme.fixture', collectionId: 'zeta', schemaVersion: 1, contractDigest: contractDigest('z') },
        { pluginId: 'com.acme.fixture', collectionId: 'alpha', schemaVersion: 2, contractDigest: contractDigest('a') },
      ],
      uiSlots: [
        {
          contributionId: 'native',
          artifactId: 'native-renderer',
          tier: 'reactNative',
          platform: 'ios',
          artifactDigest: `sha256:${'b'.repeat(64)}`,
          hostUiApiRange: '^1.0.0',
        },
        {
          contributionId: 'hosted',
          artifactId: 'hosted-renderer',
          tier: 'hostedWeb',
          platform: 'web',
          artifactDigest: `sha256:${'c'.repeat(64)}`,
          hostUiApiRange: '^1.0.0',
        },
      ],
      packageAssetArchive: packageAssetArchive(),
    });

    expect(normalized.collectionContracts.map((contract) => contract.collectionId)).toEqual(['alpha', 'zeta']);
    expect(normalized.uiSlots.map((slot) => slot.contributionId)).toEqual(['hosted', 'native']);
    expect(PluginReleaseFactsV1Schema.safeParse({
      ...normalized,
      normalizedManifest: manifest({ id: 'com.acme.other' }),
    }).success).toBe(false);
  });

  it('deeply snapshots and freezes every normalized release fact before publication', () => {
    const release = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest({
        contributes: {
          resources: [{
            id: 'brand',
            kind: 'asset',
            path: 'assets/brand.png',
            contentType: 'image/png',
          }],
        },
      }),
      collectionContracts: [{
        pluginId: 'com.acme.fixture',
        collectionId: 'items',
        schemaVersion: 1,
        contractDigest: contractDigest('a'),
      }],
      uiSlots: [{
        contributionId: 'hosted',
        artifactId: 'hosted-renderer',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        hostUiApiRange: '^1.0.0',
      }],
      packageAssetArchive: packageAssetArchive([{
        resourceId: 'brand',
        path: 'assets/brand.png',
        mimeType: 'image/png',
        byteSize: 3,
        digestSha256: `sha256:${'d'.repeat(64)}`,
      }]),
    };
    const normalized = normalizePluginReleaseFactsV1(release);
    const signingInput = createCanonicalJsonSigningInput(normalized);

    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.ref)).toBe(true);
    expect(Object.isFrozen(normalized.normalizedManifest)).toBe(true);
    expect(Object.isFrozen(normalized.normalizedManifest.engines)).toBe(true);
    expect(Object.isFrozen(normalized.normalizedManifest.contributes)).toBe(true);
    expect(Object.isFrozen(normalized.normalizedManifest.contributes.resources)).toBe(true);
    expect(Object.isFrozen(normalized.normalizedManifest.contributes.resources[0]!)).toBe(true);
    expect(Object.isFrozen(normalized.collectionContracts[0]!)).toBe(true);
    expect(Object.isFrozen(normalized.uiSlots[0]!.compatibility)).toBe(true);
    expect(Object.isFrozen(normalized.packageAssetArchive)).toBe(true);
    expect(Object.isFrozen(normalized.packageAssetArchive.resources)).toBe(true);
    expect(Object.isFrozen(normalized.packageAssetArchive.resources[0]!)).toBe(true);

    Object.assign(release.normalizedManifest.engines, { happier: '^99.0.0' });
    Object.assign(release.packageAssetArchive.resources[0]!, { path: 'assets/replaced.png' });
    expect(normalized.normalizedManifest.engines.happier).toBe('^1.0.0');
    expect(normalized.packageAssetArchive.resources[0]!.path).toBe('assets/brand.png');

    expect(() => Object.assign(normalized.normalizedManifest.engines, { happier: '^2.0.0' }))
      .toThrow(TypeError);
    expect(() => Object.assign(normalized.packageAssetArchive.resources[0]!, {
      path: 'assets/mutated.png',
    })).toThrow(TypeError);
    expect(createCanonicalJsonSigningInput(normalized)).toBe(signingInput);
  });

  it('requires package Asset descriptor resources to exactly match the normalized manifest', () => {
    const release = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest(),
      collectionContracts: [],
      uiSlots: [],
      packageAssetArchive: packageAssetArchive([{
        resourceId: 'brand',
        path: 'assets/brand.png',
        mimeType: 'image/png',
        byteSize: 3,
        digestSha256: `sha256:${'d'.repeat(64)}`,
      }]),
    };

    expect(PluginReleaseFactsV1Schema.safeParse(release).success).toBe(false);
    expect(PluginReleaseFactsV1Schema.safeParse({
      ...release,
      normalizedManifest: manifest({
        contributes: {
          resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }],
        },
      }),
      packageAssetArchive: packageAssetArchive(),
    }).success).toBe(false);
  });

  it('compares one public release coordinate by canonical archive and normalized contracts, not acquisition evidence', () => {
    const canonical = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest({
        description: 'portable fixture',
        contributes: {
          resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }],
        },
      }),
      collectionContracts: [
        { pluginId: 'com.acme.fixture', collectionId: 'zeta', schemaVersion: 1, contractDigest: contractDigest('z') },
        { pluginId: 'com.acme.fixture', collectionId: 'alpha', schemaVersion: 2, contractDigest: contractDigest('a') },
      ],
      uiSlots: [{
        contributionId: 'panel', artifactId: 'panel', tier: 'reactNative', platform: 'web',
        artifactDigest: `sha256:${'f'.repeat(64)}`, hostUiApiRange: '^1.0.0',
      }],
      packageAssetArchive: packageAssetArchive([{
        resourceId: 'brand',
        path: 'assets/brand.png',
        mimeType: 'image/png',
        byteSize: 3,
        digestSha256: `sha256:${'d'.repeat(64)}`,
      }]),
    };
    const reordered = {
      ...canonical,
      normalizedManifest: {
        runtime: { apiVersion: 1 },
        contributes: {
          resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }],
        },
        engines: { happier: '^1.0.0' },
        description: 'portable fixture',
        displayName: 'Fixture',
        id: 'com.acme.fixture',
        schemaVersion: 2,
        version: '1.2.3',
      },
      collectionContracts: [...canonical.collectionContracts].reverse(),
      // Raw SRI/signature/checksum evidence deliberately never reaches release facts;
      // a caller can only compare this canonical release representation.
    };

    const first = normalizePluginReleaseFactsV1(canonical);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1(reordered))).toBe(true);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1({
      ...reordered,
      normalizedManifest: { ...reordered.normalizedManifest, displayName: 'Changed declaration' },
    }))).toBe(false);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1({
      ...reordered,
      uiSlots: [{ ...reordered.uiSlots[0], artifactDigest: `sha256:${'c'.repeat(64)}` }],
    }))).toBe(false);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1({
      ...reordered,
      archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
    }))).toBe(false);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1({
      ...reordered,
      collectionContracts: [{
        pluginId: 'com.acme.fixture',
        collectionId: 'alpha',
        schemaVersion: 2,
        contractDigest: contractDigest('c'),
      }],
    }))).toBe(false);
    expect(pluginReleaseFactsEqualV1(first, normalizePluginReleaseFactsV1({
      ...reordered,
      packageAssetArchive: {
        ...reordered.packageAssetArchive,
        archiveDigestSha256: `sha256:${'e'.repeat(64)}`,
      },
    }))).toBe(false);
  });

  it('keeps exact materialization identity portable while rejecting server-local and generation fields from its ref', () => {
    const snapshot = PluginMachineMaterializationSnapshotV1Schema.parse({
      serverIdentityId: 'srv_availability_fixture',
      machineId: 'machine-1',
      materializations: [{
        serverIdentityId: 'srv_availability_fixture',
        machineId: 'machine-1',
        materializationId: 'install-epoch-1',
        pluginId: 'com.acme.fixture',
        version: '1.2.3',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1_700_000_000_000,
      }],
    });
    const materialization = snapshot.materializations[0]!;
    const ref = PluginMachineMaterializationRefV1Schema.parse({
      machineId: materialization.machineId,
      materializationId: materialization.materializationId,
      pluginId: materialization.pluginId,
    });

    expect(PluginMachineMaterializationRefV1Schema.safeParse({
      ...ref,
      serverIdentityId: 'server-local-alias',
    }).success).toBe(false);
    expect(PluginMachineMaterializationSnapshotV1Schema.safeParse({
      ...snapshot,
      materializations: [{ ...materialization, immutableGenerationId: 'forbidden' }],
    }).success).toBe(false);
    expect(PluginMachineMaterializationSnapshotV1Schema.safeParse({
      ...snapshot,
      materializations: [{ ...materialization, sourceClass: 'bundledFirstParty' }],
    }).success).toBe(false);
  });

  it('binds portable materializations to Account-owned release facts through coordinate and artifact evidence', () => {
    const canonicalReleaseFacts = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest(),
      collectionContracts: [{
        pluginId: 'com.acme.fixture',
        collectionId: 'tasks',
        schemaVersion: 1,
        contractDigest: contractDigest('a'),
      }],
      uiSlots: [{
        contributionId: 'hosted',
        artifactId: 'hosted-renderer',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        hostUiApiRange: '^1.0.0',
      }],
      packageAssetArchive: packageAssetArchive(),
    };
    const materialization = {
      serverIdentityId: 'srv_availability_fixture',
      machineId: 'machine-1',
      materializationId: 'install-epoch-1',
      pluginId: 'com.acme.fixture',
      version: '1.2.3',
        sourceClass: 'registryPackage',
        portableRelease: true,
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        uiArtifacts: [{
        contributionId: 'hosted',
        artifactId: 'hosted-renderer',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        hostUiApiRange: '^1.0.0',
      }],
      enabled: true,
      trustState: 'trusted',
      observedAt: 1_700_000_000_000,
    };

    const parsedRelease = PluginReleaseFactsV1Schema.parse(canonicalReleaseFacts);
    const parsedMaterialization = PluginMachineMaterializationV1Schema.parse(materialization);

    expect(PluginMachineMaterializationV1Schema.safeParse({
      ...materialization,
      releaseFacts: canonicalReleaseFacts,
    }).success).toBe(false);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      parsedMaterialization,
      parsedRelease,
    )).toBe(true);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      PluginMachineMaterializationV1Schema.parse({
        ...materialization,
        uiArtifacts: materialization.uiArtifacts.map((artifact) => ({
          ...artifact,
          hostUiApiRange: '^2.0.0',
        })),
      }),
      parsedRelease,
    )).toBe(false);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      {
        ...parsedMaterialization,
        archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
      },
      parsedRelease,
    )).toBe(false);
    const withoutArchiveDigest = {
      ...parsedMaterialization,
      archiveDigestSha256: undefined,
    };
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      withoutArchiveDigest,
      parsedRelease,
    )).toBe(false);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      {
        ...parsedMaterialization,
        uiArtifacts: [{
          ...parsedMaterialization.uiArtifacts[0]!,
          artifactDigest: `sha256:${'c'.repeat(64)}`,
        }],
      },
      parsedRelease,
    )).toBe(false);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      {
        ...parsedMaterialization,
        version: '1.2.4',
      },
      parsedRelease,
    )).toBe(false);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      PluginMachineMaterializationV1Schema.parse({
        ...materialization,
        uiArtifacts: [],
      }),
      parsedRelease,
    )).toBe(false);
    expect(PluginMachineMaterializationV1Schema.safeParse({
      ...materialization,
      uiArtifacts: [],
    }).success).toBe(true);
    expect(isExactPluginMachineMaterializationReleaseCorrespondenceV1(
      PluginMachineMaterializationV1Schema.parse({
        ...materialization,
        portableRelease: false,
      }),
      parsedRelease,
    )).toBe(false);
  });

  it('admits Git materialization on its Machine and refuses a portable release claim', () => {
    const materialization = {
      serverIdentityId: 'srv_availability_fixture', machineId: 'machine-1', materializationId: 'install-epoch-1',
      pluginId: 'com.acme.fixture', version: '1.2.3', sourceClass: 'gitRepository', portableRelease: false,
      uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1_700_000_000_000,
    };
    expect(PluginMachineMaterializationV1Schema.parse(materialization)).toMatchObject({ sourceClass: 'gitRepository' });
    expect(PluginMachineMaterializationV1Schema.safeParse({ ...materialization, portableRelease: true }).success).toBe(false);
  });

  it('keeps client-authored ordering out of normalized complete machine inventories', () => {
    const first = {
      serverIdentityId: 'srv_availability_fixture',
      machineId: 'machine-1',
      materializationId: 'install-epoch-1',
      pluginId: 'com.acme.fixture',
      version: '1.2.3',
      sourceClass: 'registryPackage' as const,
      portableRelease: true,
      uiArtifacts: [],
      enabled: true,
      trustState: 'trusted' as const,
      observedAt: 1_700_000_000_000,
    };
    const second = {
      ...first,
      materializationId: 'install-epoch-2',
      version: '2.0.0',
    };
    const normalized = normalizePluginMachineMaterializationSnapshotV1({
      serverIdentityId: 'srv_availability_fixture',
      machineId: 'machine-1',
      materializations: [second, first],
    });
    expect(normalized.materializations.map((entry) => entry.materializationId)).toEqual([
      'install-epoch-1',
      'install-epoch-2',
    ]);
    expect(PluginMachineMaterializationSnapshotV1Schema.safeParse({
      ...normalized,
      revision: 7,
    }).success).toBe(false);

    const reportInputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityMaterializationsReportActionInputV1Schema as { parse(input: unknown): unknown };
    const reportOutputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityMaterializationsReportActionOutputV1Schema as { parse(input: unknown): unknown };
    expect(reportInputSchema.parse({ expectedRevision: null, snapshot: normalized })).toBeDefined();
    expect(reportOutputSchema.parse({ revision: 7, outcome: 'conflict' })).toBeDefined();
  });

  it('keeps hosted UI intent distinct from hosting capability', () => {
    expect(PluginAccountPluginIntentV1Schema.parse({
      pluginId: 'com.acme.fixture',
      desiredVersion: '1.2.3',
      enabled: true,
      offlineUiHosting: 'enabled',
      writableCollections: [],
      revision: '7',
    })).toMatchObject({ offlineUiHosting: 'enabled' });
  });

  it('keeps Account currentness metadata and machine inventory on their explicit read contracts', () => {
    const intentReadSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityIntentReadActionOutputV1Schema as { parse(input: unknown): { availabilityCursor?: number } } | undefined;
    const materializationsReadSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityMaterializationsReadActionOutputV1Schema as { parse(input: unknown): { availabilityCursor?: number } } | undefined;
    expect(intentReadSchema).toBeDefined();
    expect(materializationsReadSchema).toBeDefined();

    const intentRead = intentReadSchema?.parse({
      availabilityCursor: 12,
      packageAssets: [],
      hostingCapability: { enabled: false },
      intent: {
        pluginId: 'com.acme.fixture',
        desiredVersion: '1.2.3',
        enabled: true,
        offlineUiHosting: 'disabled',
        writableCollections: [],
        revision: '3',
      },
      release: null,
      uiArtifacts: [],
    });
    expect(intentRead?.availabilityCursor).toBe(12);

    const materializationsRead = materializationsReadSchema?.parse({
      availabilityCursor: 12,
      snapshots: [],
    });
    expect(materializationsRead?.availabilityCursor).toBe(12);
  });

  it('does not publish a URL-bearing hosted-frame selection contract', () => {
    expect(availability).not.toHaveProperty('SelectedVerifiedHostedWebArtifactSourceV1Schema');
    expect(availability).not.toHaveProperty('SelectedVerifiedHostedWebArtifactHandleV1Schema');
  });

  it('names only the exact selected Artifact when issuing a browser frame capability', () => {
    const inputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;
    const outputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;

    const input = {
      release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      contributionId: 'hosted',
      artifactId: 'hosted-artifact',
      tier: 'hostedWeb',
      platform: 'web',
      expectedArtifactDigest: `sha256:${'b'.repeat(64)}`,
    };

    expect(inputSchema?.safeParse(input).success).toBe(true);
    expect(inputSchema?.safeParse({ ...input, artifactUrl: 'https://author.example/entry.js' }).success).toBe(false);
    expect(inputSchema?.safeParse({
      ...input,
      embeddingOrigin: 'https://untrusted.example.test',
    }).success).toBe(false);
    expect(outputSchema?.safeParse({
      url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/',
      expiresAt: 1_800_000_000_000,
    }).success).toBe(true);
    expect(outputSchema?.safeParse({
      url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/?capability=issued',
      expiresAt: 1_800_000_000_000,
    }).success).toBe(false);
  });

  it('exposes release publication and qualified archive publication inputs without admitting local paths', () => {
    const releasePublishInput = (availability as Record<string, unknown>)
      .PluginAvailabilityReleasePublishActionInputV1Schema as { safeParse(input: unknown): { success: boolean } } | undefined;
    const uiArtifactPublishInput = (availability as Record<string, unknown>)
      .PluginAvailabilityUiArtifactPublishActionInputV1Schema as { safeParse(input: unknown): { success: boolean } } | undefined;
    const intentSetInput = (availability as Record<string, unknown>)
      .PluginAvailabilityIntentSetActionInputV1Schema as { safeParse(input: unknown): { success: boolean } } | undefined;

    expect(releasePublishInput).toBeDefined();
    expect(uiArtifactPublishInput).toBeDefined();
    expect(intentSetInput).toBeDefined();

    const releaseFacts = {
      ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest(),
      collectionContracts: [],
      uiSlots: [{
        contributionId: 'hosted',
        artifactId: 'hosted-renderer',
        tier: 'hostedWeb',
        platform: 'web',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        hostUiApiRange: '^1.0.0',
      }],
      packageAssetArchive: packageAssetArchive(),
    };

    expect(releasePublishInput?.safeParse({
      facts: releaseFacts,
      sourceClass: 'registryPackage',
    }).success).toBe(true);
    expect(releasePublishInput?.safeParse({
      facts: releaseFacts,
      sourceClass: 'localPath',
    }).success).toBe(false);
    expect(releasePublishInput?.safeParse({
      facts: releaseFacts,
      sourceClass: 'bundledFirstParty',
    }).success).toBe(false);
    expect(uiArtifactPublishInput?.safeParse({
      release: releaseFacts.ref,
      slot: releaseFacts.uiSlots[0],
      accountArtifactId: '00000000-0000-4000-8000-000000000001',
      artifact: {
        header: 'aGVhZGVy',
        body: 'Ym9keQ==',
        dataEncryptionKey: 'a2V5',
      },
    }).success).toBe(true);
    expect(uiArtifactPublishInput?.safeParse({
      release: releaseFacts.ref,
      slot: releaseFacts.uiSlots[0],
      accountArtifactId: '00000000-0000-4000-8000-000000000001',
      artifact: {
        header: 'aGVhZGVy',
        body: 'Ym9keQ==',
        dataEncryptionKey: 'a2V5',
      },
    }).success).toBe(true);
    expect(intentSetInput?.safeParse({
      pluginId: 'com.acme.fixture',
      desiredVersion: '1.2.3',
      enabled: true,
      offlineUiHosting: 'enabled',
      writableCollections: [{
        pluginId: 'com.acme.fixture',
        collectionId: 'tasks',
        schemaVersion: 1,
        contractDigest: contractDigest('t'),
      }],
      expectedRevision: '3',
    }).success).toBe(true);
  });

  it('reads one exact immutable unselected release coordinate without intent or Marketplace authority', () => {
    const releaseReadInput = (availability as Record<string, unknown>)
      .PluginAvailabilityReleaseReadActionInputV1Schema as
      | Readonly<{ safeParse(input: unknown): { success: boolean } }>
      | undefined;
    const releaseReadOutput = (availability as Record<string, unknown>)
      .PluginAvailabilityReleaseReadActionOutputV1Schema as
      | Readonly<{ safeParse(input: unknown): { success: boolean } }>
      | undefined;

    const facts = {
      ref: { pluginId: 'com.acme.fixture', version: '2.0.0' },
      archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
      normalizedManifest: manifest({ version: '2.0.0' }),
      collectionContracts: [],
      uiSlots: [],
      packageAssetArchive: packageAssetArchive(),
    };

    expect(releaseReadInput?.safeParse({ release: facts.ref }).success).toBe(true);
    expect(releaseReadInput?.safeParse({
      release: facts.ref,
      marketplaceEntry: 'curated-result',
    }).success).toBe(false);
    expect(releaseReadOutput?.safeParse({
      availabilityCursor: 17,
      facts,
    }).success).toBe(true);
    expect(releaseReadOutput?.safeParse({
      availabilityCursor: 17,
      facts,
      intent: { desiredVersion: '2.0.0' },
    }).success).toBe(false);
  });

  it('keeps the bounded Availability operation paths with their Protocol action owner', () => {
    const paths = (availability as Record<string, unknown>)
      .PluginAvailabilityActionHttpPathsV1 as Record<string, string> | undefined;
    expect(paths).toBeDefined();
    expect(paths?.['account.plugins.availability.release.publish'])
      .toBe('/v1/plugins/availability/releases/publish');
    expect(paths?.['account.plugins.availability.release.read'])
      .toBe('/v1/plugins/availability/releases/read');
    expect(paths?.['account.plugins.availability.materializations.report'])
      .toBe('/v1/plugins/availability/materializations/report');
    expect(paths?.['account.plugins.availability.intents.list'])
      .toBe('/v1/plugins/availability/intents/list');
    expect(paths?.['account.plugins.availability.uiArtifact.browserFrame.issue'])
      .toBe('/v1/plugins/availability/ui-artifacts/browser-frame/issue');
    expect(paths?.['account.plugins.availability.packageAsset.remove'])
      .toBe('/v1/plugins/availability/package-assets/remove');
    expect(paths?.['account.plugins.availability.collectionWriters.claim'])
      .toBe('/v1/plugins/availability/collection-writers/claim');
    expect(new Set(Object.values(paths ?? {})).size).toBe(15);
  });

  it('keeps the package Asset archive behind qualified Availability publish/read actions', () => {
    const publishInput = (availability as Record<string, unknown>)
      .PluginAvailabilityPackageAssetPublishActionInputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;
    const readInput = (availability as Record<string, unknown>)
      .PluginAvailabilityPackageAssetReadActionInputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;
    const readOutput = (availability as Record<string, unknown>)
      .PluginAvailabilityPackageAssetReadActionOutputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;
    const paths = (availability as Record<string, unknown>)
      .PluginAvailabilityActionHttpPathsV1 as Record<string, string> | undefined;

    const release = { pluginId: 'com.acme.fixture', version: '1.2.3' };
    const descriptor = packageAssetArchive();
    const artifact = {
      header: 'aGVhZGVy',
      body: 'Ym9keQ==',
      dataEncryptionKey: 'a2V5',
    };

    expect(publishInput?.safeParse({
      release,
      artifactId: '00000000-0000-4000-8000-000000000003',
      artifact,
    }).success).toBe(true);
    expect(publishInput?.safeParse({
      release,
      artifactId: '00000000-0000-4000-8000-000000000003',
      artifact,
      localPath: '/tmp/package-assets',
    }).success).toBe(false);
    expect(readInput?.safeParse({ release }).success).toBe(true);
    expect(readOutput?.safeParse({
      link: {
        release,
        artifactId: '00000000-0000-4000-8000-000000000003',
        descriptor,
      },
      artifact: {
        ...artifact,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 0,
      },
    }).success).toBe(true);
    expect(paths?.['account.plugins.availability.packageAsset.publish'])
      .toBe('/v1/plugins/availability/package-assets/publish');
    expect(paths?.['account.plugins.availability.packageAsset.read'])
      .toBe('/v1/plugins/availability/package-assets/read');
  });

  it('admits complete canonical Account intent reads while rejecting ambiguous list identities', () => {
    const inputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityIntentsListActionInputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;
    const outputSchema = (availability as Record<string, unknown>)
      .PluginAvailabilityIntentsListActionOutputV1Schema as
      | Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>
      | undefined;

    expect(inputSchema?.safeParse({}).success).toBe(true);
    expect(inputSchema?.safeParse({ knownPluginIds: ['com.acme.removed'] }).success).toBe(true);
    expect(inputSchema?.safeParse({ pluginId: 'com.acme.fixture' }).success).toBe(false);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7,
      pluginIds: ['com.acme.alpha', 'com.acme.fixture'],
      intentReads: [{ pluginId: 'com.acme.fixture', response: {
        availabilityCursor: 7, hostingCapability: { enabled: false }, intent: null,
        release: null, uiArtifacts: [], packageAssets: [],
      } }],
      failedPluginIds: ['com.acme.alpha'],
    }).success).toBe(true);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7,
      pluginIds: ['com.acme.fixture', 'com.acme.alpha'],
      intentReads: [], failedPluginIds: [],
    }).success).toBe(false);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7,
      pluginIds: ['com.acme.fixture', 'com.acme.fixture'],
      intentReads: [], failedPluginIds: [],
    }).success).toBe(false);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7,
      pluginIds: ['com.acme.fixture'],
      intentReads: [], failedPluginIds: [],
      materializations: [],
    }).success).toBe(false);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7, pluginIds: ['com.acme.fixture'],
      intentReads: [], failedPluginIds: [],
    }).success).toBe(false);
    expect(outputSchema?.safeParse({
      availabilityCursor: 7, pluginIds: [], intentReads: [],
      failedPluginIds: ['com.acme.fixture', 'com.acme.fixture'],
    }).success).toBe(false);
  });
});
