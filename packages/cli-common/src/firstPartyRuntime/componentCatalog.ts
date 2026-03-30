import {
  getReleaseRingCatalogEntry,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyRuntimeKind } from './runtimeKinds.js';

export const FIRST_PARTY_COMPONENT_IDS = [
  'happier-cli',
  'happier-daemon',
  'happier-server',
  'hstack',
] as const;

export type FirstPartyComponentId = (typeof FIRST_PARTY_COMPONENT_IDS)[number];

export interface FirstPartyComponentCatalogEntry {
  id: FirstPartyComponentId;
  runtimeKind: FirstPartyRuntimeKind;
  executableBaseName: string;
  releaseProductName: string;
  rollingReleasePrefix: string;
  installRootName: string;
  retainVersions: number;
  nodeEntrypointRelativePath: string | null;
  binaryRelativePath: string;
  installShims: readonly string[];
  installShimOverrides?: Partial<Record<PublicReleaseRingId, readonly string[]>>;
  prefersManagedNodeFallback: boolean;
}

export interface FirstPartyComponentPublicReleaseVariant {
  channel: PublicReleaseRingId;
  releaseTag: string;
  installRootName: string;
  installShims: readonly string[];
}

const SHARED_VERSION_RETENTION = 2;

export const firstPartyComponentCatalog = {
  'happier-cli': {
    id: 'happier-cli',
    runtimeKind: 'binary',
    executableBaseName: 'happier',
    releaseProductName: 'happier',
    rollingReleasePrefix: 'cli',
    installRootName: 'cli',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: 'package-dist/index.mjs',
    binaryRelativePath: 'happier',
    installShims: ['happier'],
    installShimOverrides: {
      preview: ['hprev'],
      publicdev: ['hdev'],
    },
    prefersManagedNodeFallback: false,
  },
  'happier-daemon': {
    id: 'happier-daemon',
    runtimeKind: 'node-runtime-payload',
    executableBaseName: 'happier',
    releaseProductName: 'happier',
    rollingReleasePrefix: 'cli',
    installRootName: 'cli',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: 'package-dist/index.mjs',
    binaryRelativePath: 'happier',
    installShims: ['happier'],
    installShimOverrides: {
      preview: ['hprev'],
      publicdev: ['hdev'],
    },
    prefersManagedNodeFallback: true,
  },
  'happier-server': {
    id: 'happier-server',
    runtimeKind: 'binary',
    executableBaseName: 'happier-server',
    releaseProductName: 'happier-server',
    rollingReleasePrefix: 'server',
    installRootName: 'server',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: null,
    binaryRelativePath: 'happier-server',
    installShims: ['happier-server'],
    prefersManagedNodeFallback: false,
  },
  hstack: {
    id: 'hstack',
    runtimeKind: 'binary',
    executableBaseName: 'hstack',
    releaseProductName: 'hstack',
    rollingReleasePrefix: 'stack',
    installRootName: 'stack',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: null,
    binaryRelativePath: 'hstack',
    installShims: ['hstack'],
    prefersManagedNodeFallback: false,
  },
} as const satisfies Record<FirstPartyComponentId, FirstPartyComponentCatalogEntry>;

export function getFirstPartyComponentCatalogEntry(
  componentId: FirstPartyComponentId,
): FirstPartyComponentCatalogEntry {
  const entry = firstPartyComponentCatalog[componentId];
  if (!entry) {
    throw new Error(`Unknown first-party component: ${String(componentId)}`);
  }
  return entry;
}

export function listFirstPartyComponentCatalogEntries(): readonly FirstPartyComponentCatalogEntry[] {
  return FIRST_PARTY_COMPONENT_IDS.map((componentId) => firstPartyComponentCatalog[componentId]);
}

export function resolveFirstPartyComponentPublicReleaseVariant(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
}>): FirstPartyComponentPublicReleaseVariant {
  const entry = getFirstPartyComponentCatalogEntry(params.componentId);
  const ring = getReleaseRingCatalogEntry(params.channel);
  const suffix = ring.rollingReleaseSuffix;
  if (!suffix) {
    throw new Error(`Public release ring ${params.channel} does not define a rolling release suffix`);
  }

  const defaultInstallShims = params.channel === 'stable'
    ? entry.installShims
    : [`${entry.executableBaseName}-${suffix}`];

  return {
    channel: params.channel,
    releaseTag: `${entry.rollingReleasePrefix}-${suffix}`,
    installRootName: params.channel === 'stable' ? entry.installRootName : `${entry.installRootName}-${suffix}`,
    installShims: entry.installShimOverrides?.[params.channel] ?? defaultInstallShims,
  };
}
