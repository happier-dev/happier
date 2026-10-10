import { describe, expect, it } from 'vitest';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
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

  it('deeply snapshots and freezes every normalized release fact before it becomes signing input', () => {
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
      uiSlots: [],
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

    expect(pluginReleaseFactsEqualV1(canonical, reordered)).toBe(true);
    expect(pluginReleaseFactsEqualV1(canonical, {
      ...reordered,
      archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
    })).toBe(false);
    expect(pluginReleaseFactsEqualV1(canonical, {
      ...reordered,
      collectionContracts: [{
        pluginId: 'com.acme.fixture',
        collectionId: 'alpha',
        schemaVersion: 2,
        contractDigest: contractDigest('c'),
      }],
    })).toBe(false);
    expect(pluginReleaseFactsEqualV1(canonical, {
      ...reordered,
      packageAssetArchive: {
        ...reordered.packageAssetArchive,
        archiveDigestSha256: `sha256:${'e'.repeat(64)}`,
      },
    })).toBe(false);
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
