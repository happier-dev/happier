/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Runtime reads this local artifact; executable plugin packages are only named as locators.
 */

import {
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderCliRuntimeSpec,
  isAgentId,
} from '@happier-dev/agents';
import type { AgentId } from '@happier-dev/agents';

import type {
  ResolvedActivationTarget,
  ResolvedBackendContribution,
  ResolvedCatalogEntry,
  ResolvedProviderContribution,
  ResolvedScmHostingProviderContribution,
} from '../types';

export type BundledFirstPartyPluginMetadata = Readonly<{
  agentId?: string;
  pluginId: string;
  pluginPackageId: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
  manifestDigest: string;
}>;

type BundledContributionMetadataFields = Pick<
  ResolvedActivationTarget,
  'pluginId' | 'manifestPath' | 'manifestDigest' | 'daemonEntryPath' | 'sourceSpec'
>;

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-scm-azure-devops",
  "@happier-dev/plugins-scm-bitbucket",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "claude",
    "manifestDigest": "bundled:@happier-dev/plugins-claude@0.0.0",
    "manifestPath": "bundled:claude",
    "packageName": "@happier-dev/plugins-claude",
    "packageVersion": "0.0.0",
    "pluginId": "claude",
    "pluginPackageId": "claude"
  },
  {
    "agentId": "codex",
    "manifestDigest": "bundled:@happier-dev/plugins-codex@0.0.0",
    "manifestPath": "bundled:codex",
    "packageName": "@happier-dev/plugins-codex",
    "packageVersion": "0.0.0",
    "pluginId": "codex",
    "pluginPackageId": "codex"
  },
  {
    "agentId": "opencode",
    "manifestDigest": "bundled:@happier-dev/plugins-opencode@0.0.0",
    "manifestPath": "bundled:opencode",
    "packageName": "@happier-dev/plugins-opencode",
    "packageVersion": "0.0.0",
    "pluginId": "opencode",
    "pluginPackageId": "opencode"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
    "manifestPath": "bundled:scm-azure-devops",
    "packageName": "@happier-dev/plugins-scm-azure-devops",
    "packageVersion": "0.0.0",
    "pluginId": "scm-azure-devops",
    "pluginPackageId": "scm-azure-devops"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
    "manifestPath": "bundled:scm-bitbucket",
    "packageName": "@happier-dev/plugins-scm-bitbucket",
    "packageVersion": "0.0.0",
    "pluginId": "scm-bitbucket",
    "pluginPackageId": "scm-bitbucket"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-github@0.0.0",
    "manifestPath": "bundled:scm-github",
    "packageName": "@happier-dev/plugins-scm-github",
    "packageVersion": "0.0.0",
    "pluginId": "scm-github",
    "pluginPackageId": "scm-github"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
    "manifestPath": "bundled:scm-gitlab",
    "packageName": "@happier-dev/plugins-scm-gitlab",
    "packageVersion": "0.0.0",
    "pluginId": "scm-gitlab",
    "pluginPackageId": "scm-gitlab"
  }
]);

const bundledPluginMetadataByAgentId = new Map(
  BUNDLED_FIRST_PARTY_PLUGIN_METADATA
    .filter((entry): entry is BundledFirstPartyPluginMetadata & Readonly<{ agentId: string }> => typeof entry.agentId === 'string')
    .map((entry) => [entry.agentId, entry] as const),
);

type BuiltInBackendCatalogDefinition = (ReturnType<typeof getAllBackendDefinitions>)[number];

function buildBundledSourceSpec(metadata: BundledFirstPartyPluginMetadata) {
  return {
    kind: 'package' as const,
    locator: metadata.packageName,
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
    resolvedVersion: metadata.packageVersion,
    resolvedDigest: metadata.manifestDigest,
  };
}

function readBundledPluginMetadata(agentId: string): BundledFirstPartyPluginMetadata | null {
  return bundledPluginMetadataByAgentId.get(agentId) ?? null;
}

function requireBuiltInAgentId(value: string, subject: string): AgentId {
  if (!isAgentId(value)) {
    throw new Error(`Expected built-in ${subject} id, received '${value}'`);
  }
  return value;
}

function buildBundledMetadataFields(agentId: string): Partial<BundledContributionMetadataFields> {
  const metadata = readBundledPluginMetadata(agentId);
  if (!metadata) return {};
  return {
    pluginId: metadata.pluginId,
    manifestPath: metadata.manifestPath,
    manifestDigest: metadata.manifestDigest,
    daemonEntryPath: metadata.packageName,
    sourceSpec: buildBundledSourceSpec(metadata),
  };
}

export const BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS: readonly ResolvedActivationTarget[] = Object.freeze(
  BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((metadata): ResolvedActivationTarget => ({
    provenance: 'external',
    source: { kind: 'bundled' },
    pluginId: metadata.pluginId,
    manifestPath: metadata.manifestPath,
    manifestDigest: metadata.manifestDigest,
    daemonEntryPath: metadata.packageName,
    sourceSpec: buildBundledSourceSpec(metadata),
  })),
);

export const BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS: readonly ResolvedProviderContribution[] = Object.freeze(
  getAllProviderDefinitionContracts().map((definition): ResolvedProviderContribution => {
    const providerId = requireBuiltInAgentId(definition.id, 'provider');
    const richDefinition = getProviderDefinition(providerId);
    if (!richDefinition) {
      throw new Error(`Missing built-in provider catalog definition '${definition.id}'`);
    }
    const catalogEntry = Object.freeze({
      id: definition.id,
      cliSubcommand: richDefinition.core.cliSubcommand,
      vendorResumeSupport: richDefinition.core.resume.vendorResume,
    } satisfies ResolvedCatalogEntry);
    return Object.freeze({
      id: definition.id,
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition,
      richDefinition: {
        provenance: 'first_party',
        definition: richDefinition,
      },
      runtimeSpec: getProviderCliRuntimeSpec(providerId),
      catalogEntry,
      ...buildBundledMetadataFields(definition.id),
    } satisfies ResolvedProviderContribution);
  }),
);

export const BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS: readonly ResolvedScmHostingProviderContribution[] = Object.freeze([
  Object.freeze({
    id: "scm.azure-devops",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "scm-azure-devops",
    manifestPath: "bundled:scm-azure-devops",
    manifestDigest: "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-azure-devops",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-azure-devops",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "baseUrl": "https://dev.azure.com",
  "capabilities": {
    "compareUrl": true,
    "openUrl": true,
    "pullRequests": {
      "checkout": false,
      "create": false,
      "get": false,
      "list": false,
      "prepareWorktree": false,
      "runStacked": false
    },
    "repositoryProvisioning": {
      "createRepository": false,
      "describeTargets": false,
      "publish": false
    },
    "reviewThreads": {
      "read": false,
      "write": false
    }
  },
  "displayName": "Azure DevOps",
  "id": "scm.azure-devops",
  "kind": "azure-devops",
  "remoteHostMatchers": {
    "exactHosts": [
      "dev.azure.com",
      "ssh.dev.azure.com"
    ],
    "suffixHosts": [
      ".visualstudio.com"
    ]
  },
  "urlSafety": {
    "allowedBaseUrls": [
      "https://dev.azure.com"
    ],
    "allowedOrigins": [
      "https://dev.azure.com"
    ],
    "allowedSchemes": [
      "https:"
    ]
  }
}),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.bitbucket",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "scm-bitbucket",
    manifestPath: "bundled:scm-bitbucket",
    manifestDigest: "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-bitbucket",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-bitbucket",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "baseUrl": "https://bitbucket.org",
  "capabilities": {
    "compareUrl": true,
    "openUrl": true,
    "pullRequests": {
      "checkout": false,
      "create": false,
      "get": false,
      "list": false,
      "prepareWorktree": false,
      "runStacked": false
    },
    "repositoryProvisioning": {
      "createRepository": false,
      "describeTargets": false,
      "publish": false
    },
    "reviewThreads": {
      "read": false,
      "write": false
    }
  },
  "displayName": "Bitbucket",
  "id": "scm.bitbucket",
  "kind": "bitbucket",
  "remoteHostMatchers": {
    "exactHosts": [
      "bitbucket.org"
    ],
    "suffixHosts": []
  },
  "urlSafety": {
    "allowedBaseUrls": [
      "https://bitbucket.org"
    ],
    "allowedOrigins": [
      "https://bitbucket.org"
    ],
    "allowedSchemes": [
      "https:"
    ]
  }
}),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.github",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "scm-github",
    manifestPath: "bundled:scm-github",
    manifestDigest: "bundled:@happier-dev/plugins-scm-github@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-github",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-github",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-github@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "baseUrl": "https://github.com",
  "capabilities": {
    "compareUrl": true,
    "openUrl": true,
    "pullRequests": {
      "checkout": false,
      "create": true,
      "get": true,
      "list": true,
      "prepareWorktree": false,
      "runStacked": false
    },
    "repositoryProvisioning": {
      "createRepository": true,
      "describeTargets": true,
      "publish": false
    },
    "reviewThreads": {
      "read": false,
      "write": false
    }
  },
  "displayName": "GitHub",
  "id": "scm.github",
  "kind": "github",
  "remoteHostMatchers": {
    "exactHosts": [
      "github.com",
      "github.company.com",
      "ghe.internal.test"
    ],
    "suffixHosts": []
  },
  "urlSafety": {
    "allowedBaseUrls": [
      "https://github.com",
      "https://github.company.com",
      "https://ghe.internal.test"
    ],
    "allowedOrigins": [
      "https://github.com",
      "https://github.company.com",
      "https://ghe.internal.test"
    ],
    "allowedSchemes": [
      "https:"
    ]
  }
}),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.gitlab",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "scm-gitlab",
    manifestPath: "bundled:scm-gitlab",
    manifestDigest: "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-gitlab",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-gitlab",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "baseUrl": "https://gitlab.com",
  "capabilities": {
    "compareUrl": true,
    "openUrl": true,
    "pullRequests": {
      "checkout": false,
      "create": false,
      "get": false,
      "list": false,
      "prepareWorktree": false,
      "runStacked": false
    },
    "repositoryProvisioning": {
      "createRepository": false,
      "describeTargets": false,
      "publish": false
    },
    "reviewThreads": {
      "read": false,
      "write": false
    }
  },
  "displayName": "GitLab",
  "id": "scm.gitlab",
  "kind": "gitlab",
  "remoteHostMatchers": {
    "exactHosts": [
      "gitlab.com",
      "gitlab.company.com",
      "code.internal.test"
    ],
    "suffixHosts": []
  },
  "urlSafety": {
    "allowedBaseUrls": [
      "https://gitlab.com",
      "https://gitlab.company.com",
      "https://code.internal.test"
    ],
    "allowedOrigins": [
      "https://gitlab.com",
      "https://gitlab.company.com",
      "https://code.internal.test"
    ],
    "allowedSchemes": [
      "https:"
    ]
  }
}),
  } satisfies ResolvedScmHostingProviderContribution),
]);

const backendCatalogDefinitionsById = new Map<AgentId, BuiltInBackendCatalogDefinition>(
  getAllBackendDefinitions().map((definition) => [definition.id, definition] as const),
);

export const BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze(
  getAllBackendDefinitionContracts().map((definition): ResolvedBackendContribution => {
    const backendId = requireBuiltInAgentId(definition.id, 'backend');
    const richDefinition = backendCatalogDefinitionsById.get(backendId);
    if (!richDefinition) {
      throw new Error(`Missing built-in backend catalog definition '${definition.id}'`);
    }
    return Object.freeze({
      id: definition.id,
      providerId: definition.providerId,
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition,
      richDefinition: {
        provenance: 'first_party',
        definition: richDefinition,
      },
      runtimeKind: richDefinition.engine?.defaultRuntimeKind ?? 'native',
      ...buildBundledMetadataFields(definition.providerId),
    } satisfies ResolvedBackendContribution);
  }),
);

export const BUNDLED_FIRST_PARTY_CATALOG_ENTRIES: readonly ResolvedCatalogEntry[] = Object.freeze(
  BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) => provider.catalogEntry)
    .filter((entry): entry is ResolvedCatalogEntry => Boolean(entry)),
);
