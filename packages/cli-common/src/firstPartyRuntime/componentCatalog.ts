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
  releaseTagStable: string;
  releaseTagPreview: string;
  installRootName: string;
  retainVersions: number;
  nodeEntrypointRelativePath: string | null;
  binaryRelativePath: string;
  installShims: readonly string[];
  prefersManagedNodeFallback: boolean;
}

const SHARED_VERSION_RETENTION = 2;

export const firstPartyComponentCatalog = {
  'happier-cli': {
    id: 'happier-cli',
    runtimeKind: 'binary',
    executableBaseName: 'happier',
    releaseProductName: 'happier',
    releaseTagStable: 'latest',
    releaseTagPreview: 'preview',
    installRootName: 'cli',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: 'package-dist/index.mjs',
    binaryRelativePath: 'happier',
    installShims: ['happier'],
    prefersManagedNodeFallback: false,
  },
  'happier-daemon': {
    id: 'happier-daemon',
    runtimeKind: 'node-runtime-payload',
    executableBaseName: 'happier',
    releaseProductName: 'happier',
    releaseTagStable: 'latest',
    releaseTagPreview: 'preview',
    installRootName: 'cli',
    retainVersions: SHARED_VERSION_RETENTION,
    nodeEntrypointRelativePath: 'package-dist/index.mjs',
    binaryRelativePath: 'happier',
    installShims: ['happier'],
    prefersManagedNodeFallback: true,
  },
  'happier-server': {
    id: 'happier-server',
    runtimeKind: 'binary',
    executableBaseName: 'happier-server',
    releaseProductName: 'happier-server',
    releaseTagStable: 'latest',
    releaseTagPreview: 'preview',
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
    releaseTagStable: 'latest',
    releaseTagPreview: 'preview',
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
