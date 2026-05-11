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
  ResolvedConnectedAccountDescriptorContribution,
  ResolvedInstallableContribution,
  ResolvedProviderContribution,
  ResolvedScmBackendContribution,
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
  "@happier-dev/plugins-scm-git",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
  "@happier-dev/plugins-scm-sapling",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "claude",
    "manifestDigest": "bundled:@happier-dev/plugins-claude@0.0.0",
    "manifestPath": "bundled:happier.agent.claude",
    "packageName": "@happier-dev/plugins-claude",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.claude",
    "pluginPackageId": "claude"
  },
  {
    "agentId": "codex",
    "manifestDigest": "bundled:@happier-dev/plugins-codex@0.0.0",
    "manifestPath": "bundled:happier.agent.codex",
    "packageName": "@happier-dev/plugins-codex",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.codex",
    "pluginPackageId": "codex"
  },
  {
    "agentId": "opencode",
    "manifestDigest": "bundled:@happier-dev/plugins-opencode@0.0.0",
    "manifestPath": "bundled:happier.agent.opencode",
    "packageName": "@happier-dev/plugins-opencode",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.opencode",
    "pluginPackageId": "opencode"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
    "manifestPath": "bundled:happier.scm.hosting.azure-devops",
    "packageName": "@happier-dev/plugins-scm-azure-devops",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.hosting.azure-devops",
    "pluginPackageId": "scm-azure-devops"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
    "manifestPath": "bundled:happier.scm.hosting.bitbucket",
    "packageName": "@happier-dev/plugins-scm-bitbucket",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.hosting.bitbucket",
    "pluginPackageId": "scm-bitbucket"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-git@0.0.0",
    "manifestPath": "bundled:happier.scm.backend.git",
    "packageName": "@happier-dev/plugins-scm-git",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.git",
    "pluginPackageId": "scm-git"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-github@0.0.0",
    "manifestPath": "bundled:happier.scm.hosting.github",
    "packageName": "@happier-dev/plugins-scm-github",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.hosting.github",
    "pluginPackageId": "scm-github"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
    "manifestPath": "bundled:happier.scm.hosting.gitlab",
    "packageName": "@happier-dev/plugins-scm-gitlab",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.hosting.gitlab",
    "pluginPackageId": "scm-gitlab"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
    "manifestPath": "bundled:happier.scm.backend.sapling",
    "packageName": "@happier-dev/plugins-scm-sapling",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.sapling",
    "pluginPackageId": "scm-sapling"
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
    provenance: 'first_party',
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
    pluginId: "happier.scm.hosting.azure-devops",
    identity: {
      pluginId: "happier.scm.hosting.azure-devops",
      family: 'scmHostingProviders',
      contributionId: "scm.azure-devops",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.hosting.azure-devops",
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
  "auth": {
    "cloudOnly": false,
    "materializationKinds": []
  },
  "baseUrl": "https://dev.azure.com",
  "capabilities": {
    "capabilityScope": "remote-hosting-provider",
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
} as const satisfies ResolvedScmHostingProviderContribution['definition']),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.bitbucket",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.hosting.bitbucket",
    identity: {
      pluginId: "happier.scm.hosting.bitbucket",
      family: 'scmHostingProviders',
      contributionId: "scm.bitbucket",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.hosting.bitbucket",
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
  "auth": {
    "cloudOnly": true,
    "credentialPayloadKind": "bitbucket_basic_auth",
    "materializationKinds": [
      "scm_hosting_basic_auth"
    ]
  },
  "baseUrl": "https://bitbucket.org",
  "capabilities": {
    "capabilityScope": "remote-hosting-provider",
    "compareUrl": true,
    "openUrl": true,
    "pullRequests": {
      "checkout": true,
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
} as const satisfies ResolvedScmHostingProviderContribution['definition']),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.github",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.hosting.github",
    identity: {
      pluginId: "happier.scm.hosting.github",
      family: 'scmHostingProviders',
      contributionId: "scm.github",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.hosting.github",
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
  "auth": {
    "cloudOnly": false,
    "materializationKinds": []
  },
  "baseUrl": "https://github.com",
  "capabilities": {
    "capabilityScope": "remote-hosting-provider",
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
} as const satisfies ResolvedScmHostingProviderContribution['definition']),
  } satisfies ResolvedScmHostingProviderContribution),
  Object.freeze({
    id: "scm.gitlab",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.hosting.gitlab",
    identity: {
      pluginId: "happier.scm.hosting.gitlab",
      family: 'scmHostingProviders',
      contributionId: "scm.gitlab",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.hosting.gitlab",
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
  "auth": {
    "cloudOnly": false,
    "materializationKinds": []
  },
  "baseUrl": "https://gitlab.com",
  "capabilities": {
    "capabilityScope": "remote-hosting-provider",
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
} as const satisfies ResolvedScmHostingProviderContribution['definition']),
  } satisfies ResolvedScmHostingProviderContribution),
]);

export const BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS: readonly ResolvedInstallableContribution[] = Object.freeze([
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.backend.git",
    manifestPath: "bundled:happier.scm.backend.git",
    manifestDigest: "bundled:@happier-dev/plugins-scm-git@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-git",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-git",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-git@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "binary": {
    "commands": [
      "git"
    ],
    "managedFallback": false,
    "systemFirst": true
  },
  "capabilityGates": [],
  "capabilityId": "dep.git",
  "consent": {
    "commandsPreviewRequired": true,
    "install": "required",
    "update": "required"
  },
  "defaultPolicy": {
    "autoInstallWhenNeeded": false,
    "autoUpdateMode": "off"
  },
  "description": "Git command line executable used for local source-control operations.",
  "display": {
    "name": "Git",
    "subtitle": "System Git executable"
  },
  "hidden": false,
  "id": "dep.git",
  "key": "dep.git",
  "kind": "dep",
  "permissionGates": [],
  "redaction": "none",
  "source": {
    "kind": "manual_only",
    "setupUrl": "https://git-scm.com/downloads"
  },
  "stability": {
    "experimental": false,
    "supported": true
  },
  "ui": {
    "iconName": "git-branch",
    "setupUrl": "https://git-scm.com/downloads"
  },
  "version": "1"
} as const satisfies ResolvedInstallableContribution['definition']),
  } satisfies ResolvedInstallableContribution),
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.backend.sapling",
    manifestPath: "bundled:happier.scm.backend.sapling",
    manifestDigest: "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-sapling",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-sapling",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "binary": {
    "commands": [
      "sl"
    ],
    "managedFallback": false,
    "systemFirst": true
  },
  "capabilityGates": [],
  "capabilityId": "dep.sapling",
  "consent": {
    "commandsPreviewRequired": true,
    "install": "required",
    "update": "required"
  },
  "defaultPolicy": {
    "autoInstallWhenNeeded": false,
    "autoUpdateMode": "notify"
  },
  "description": "Sapling source control command-line tool used for local Sapling repositories.",
  "display": {
    "name": "Sapling",
    "subtitle": "Sapling source control CLI"
  },
  "hidden": false,
  "id": "dep.sapling",
  "key": "dep.sapling",
  "kind": "dep",
  "permissionGates": [],
  "redaction": "none",
  "source": {
    "kind": "manual_only",
    "setupUrl": "https://sapling-scm.com/docs/introduction/installation"
  },
  "stability": {
    "experimental": false,
    "supported": true
  },
  "version": "1"
} as const satisfies ResolvedInstallableContribution['definition']),
  } satisfies ResolvedInstallableContribution),
]);

export const BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS: readonly ResolvedScmBackendContribution[] = Object.freeze([
  Object.freeze({
    id: "git",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.backend.git",
    identity: {
      pluginId: "happier.scm.backend.git",
      family: 'scmBackends',
      contributionId: "git",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.backend.git",
    manifestDigest: "bundled:@happier-dev/plugins-scm-git@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-git",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-git",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-git@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "capabilities": {
    "branch": {
      "checkout": {
        "support": "supported"
      },
      "create": {
        "support": "supported"
      },
      "list": {
        "support": "supported"
      },
      "merge": {
        "support": "supported"
      },
      "operationControl": {
        "support": "supported"
      },
      "rebase": {
        "support": "supported"
      }
    },
    "changeSet": {
      "diffAreas": [
        "included",
        "pending",
        "both"
      ],
      "discard": {
        "support": "supported"
      },
      "exclude": {
        "support": "supported"
      },
      "include": {
        "support": "supported"
      },
      "model": "index"
    },
    "checkpoints": {
      "aliasFinalize": {
        "support": "supported"
      },
      "backup": {
        "support": "supported"
      },
      "capture": {
        "support": "supported"
      },
      "cleanup": {
        "support": "supported"
      },
      "diff": {
        "support": "supported"
      },
      "rollbackApply": {
        "support": "supported"
      }
    },
    "commit": {
      "backout": {
        "support": "supported"
      },
      "create": {
        "support": "supported"
      },
      "lineSelection": {
        "support": "supported"
      },
      "pathSelection": {
        "support": "supported"
      }
    },
    "detection": {
      "executable": {
        "support": "supported"
      },
      "ignoredPath": {
        "support": "supported"
      },
      "repoIdentity": {
        "support": "supported"
      },
      "repoMode": {
        "support": "supported"
      },
      "repository": {
        "support": "supported"
      }
    },
    "freshness": {
      "expiry": {
        "support": "supported"
      },
      "observed": {
        "support": "supported"
      }
    },
    "hosting": {
      "providerDetection": {
        "support": "supported"
      },
      "pullRequestCheckout": {
        "support": "supported"
      },
      "pullRequestCreate": {
        "support": "supported"
      },
      "pullRequestPrepareWorktree": {
        "support": "supported"
      },
      "pullRequestRead": {
        "support": "supported"
      },
      "pullRequestReuse": {
        "support": "supported"
      },
      "pullRequestRunStacked": {
        "support": "supported"
      },
      "pullRequestStatus": {
        "support": "supported"
      },
      "repositoryPublish": {
        "support": "supported"
      },
      "repositoryPublishTargets": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "lifecycle": {
      "clone": {
        "support": "supported"
      },
      "identityRediscovery": {
        "support": "supported"
      },
      "init": {
        "support": "supported"
      },
      "publish": {
        "support": "supported"
      },
      "removeIndexLock": {
        "support": "supported"
      }
    },
    "operationLabels": {
      "commit": "Commit staged"
    },
    "read": {
      "branches": {
        "support": "supported"
      },
      "defaultBranch": {
        "support": "supported"
      },
      "diffCommit": {
        "support": "supported"
      },
      "diffFile": {
        "support": "supported"
      },
      "hostingProvider": {
        "support": "supported"
      },
      "log": {
        "support": "supported"
      },
      "pullRequestStatus": {
        "support": "supported"
      },
      "stash": {
        "support": "supported"
      },
      "status": {
        "support": "supported"
      }
    },
    "remote": {
      "add": {
        "support": "supported"
      },
      "fetch": {
        "support": "supported"
      },
      "publish": {
        "support": "supported"
      },
      "pull": {
        "support": "supported"
      },
      "push": {
        "support": "supported"
      },
      "read": {
        "support": "supported"
      },
      "remove": {
        "support": "supported"
      },
      "setUrl": {
        "support": "supported"
      }
    },
    "tooling": {
      "binarySafe": {
        "support": "supported"
      },
      "managedCliResolution": {
        "support": "supported"
      },
      "systemCliResolution": {
        "support": "supported"
      }
    },
    "workspaceIntegration": {
      "checkoutMaterialization": {
        "support": "supported"
      },
      "exportPortability": {
        "support": "supported"
      },
      "inspectLocation": {
        "support": "supported"
      },
      "portablePathClassification": {
        "support": "supported"
      },
      "workspaceTransfer": {
        "support": "supported"
      }
    },
    "worktree": {
      "create": {
        "support": "supported"
      },
      "prepare": {
        "support": "supported"
      },
      "prune": {
        "support": "supported"
      },
      "remove": {
        "support": "supported"
      }
    }
  },
  "description": "Local Git repository backend.",
  "detection": {
    "rootMarkers": [
      ".git"
    ]
  },
  "displayName": "Git",
  "id": "git",
  "installableDependencies": [
    "dep.git"
  ],
  "repoModes": [
    ".git"
  ],
  "safetyConstraints": {
    "mutatesWorkingTree": true,
    "requiresUserConfirmationForDestructiveWrites": true
  },
  "tooling": {
    "commands": [
      {
        "command": "git",
        "installableKey": "dep.git"
      }
    ],
    "managedFallback": false,
    "systemFirst": true
  }
} as const satisfies ResolvedScmBackendContribution['definition']),
  } satisfies ResolvedScmBackendContribution),
  Object.freeze({
    id: "sapling",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.backend.sapling",
    identity: {
      pluginId: "happier.scm.backend.sapling",
      family: 'scmBackends',
      contributionId: "sapling",
      provenance: 'first_party',
    },
    manifestPath: "bundled:happier.scm.backend.sapling",
    manifestDigest: "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-sapling",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-scm-sapling",
  "resolvedDigest": "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "capabilities": {
    "branch": {
      "checkout": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "create": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "list": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "merge": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "operationControl": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "rebase": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "changeSet": {
      "diffAreas": [
        "pending",
        "both"
      ],
      "discard": {
        "support": "supported"
      },
      "exclude": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "include": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "model": "working-copy"
    },
    "checkpoints": {
      "aliasFinalize": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "backup": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "capture": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "cleanup": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "diff": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "rollbackApply": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "commit": {
      "backout": {
        "support": "supported"
      },
      "create": {
        "support": "supported"
      },
      "lineSelection": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "pathSelection": {
        "support": "supported"
      }
    },
    "detection": {
      "executable": {
        "support": "supported"
      },
      "ignoredPath": {
        "support": "supported"
      },
      "repoIdentity": {
        "support": "supported"
      },
      "repoMode": {
        "support": "supported"
      },
      "repository": {
        "support": "supported"
      }
    },
    "freshness": {
      "expiry": {
        "support": "supported"
      },
      "observed": {
        "support": "supported"
      }
    },
    "hosting": {
      "providerDetection": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestCheckout": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestCreate": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestPrepareWorktree": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestRead": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestReuse": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestRunStacked": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "pullRequestStatus": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "repositoryPublish": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "repositoryPublishTargets": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      }
    },
    "lifecycle": {
      "clone": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "identityRediscovery": {
        "support": "supported"
      },
      "init": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "publish": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "removeIndexLock": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "operationLabels": {
      "commit": "Commit changes"
    },
    "read": {
      "branches": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "defaultBranch": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "diffCommit": {
        "support": "supported"
      },
      "diffFile": {
        "support": "supported"
      },
      "hostingProvider": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "log": {
        "support": "supported"
      },
      "pullRequestStatus": {
        "reason": "hosting_provider_missing",
        "support": "unsupported"
      },
      "stash": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "status": {
        "support": "supported"
      }
    },
    "remote": {
      "add": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "fetch": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "publish": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "pull": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "push": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "read": {
        "support": "supported"
      },
      "remove": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "setUrl": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "tooling": {
      "binarySafe": {
        "support": "supported"
      },
      "managedCliResolution": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "systemCliResolution": {
        "support": "supported"
      }
    },
    "workspaceIntegration": {
      "checkoutMaterialization": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "exportPortability": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "inspectLocation": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "portablePathClassification": {
        "support": "supported"
      },
      "workspaceTransfer": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    },
    "worktree": {
      "create": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "prepare": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "prune": {
        "reason": "not_implemented",
        "support": "unsupported"
      },
      "remove": {
        "reason": "not_implemented",
        "support": "unsupported"
      }
    }
  },
  "description": "Sapling local source control backend.",
  "detection": {
    "rootMarkers": [
      ".sl"
    ]
  },
  "displayName": "Sapling",
  "id": "sapling",
  "installableDependencies": [
    "dep.sapling"
  ],
  "repoModes": [
    ".sl",
    ".git"
  ],
  "safetyConstraints": {
    "mutatesWorkingTree": true,
    "requiresUserConfirmationForDestructiveWrites": true
  },
  "tooling": {
    "commands": [
      {
        "command": "sl",
        "installableKey": "dep.sapling"
      }
    ],
    "managedFallback": false,
    "systemFirst": true
  }
} as const satisfies ResolvedScmBackendContribution['definition']),
  } satisfies ResolvedScmBackendContribution),
]);

export const BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS: readonly ResolvedConnectedAccountDescriptorContribution[] = Object.freeze([
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.hosting.bitbucket",
    manifestPath: "bundled:happier.scm.hosting.bitbucket",
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
  "aliases": [
    "bitbucket"
  ],
  "capabilityGates": [],
  "connectModes": [
    {
      "credentialKind": "token",
      "default": true,
      "mode": "token",
      "targetId": "bitbucket",
      "tokenKind": "api-token"
    }
  ],
  "credentialKinds": [
    "token"
  ],
  "defaultCredentialKind": "token",
  "displayKey": "connectedServices.serviceNames.bitbucket",
  "hidden": false,
  "id": "bitbucket",
  "kind": "auth.connectedAccount",
  "materialization": {
    "hookKey": "connectedServices.materialization.bitbucketScmHostingBasicAuth",
    "materializationKinds": [
      "scm_hosting_basic_auth"
    ]
  },
  "permissionGates": [],
  "quota": {
    "capabilityIds": []
  },
  "redaction": "none",
  "tokenSetup": {
    "credentialPayloadKind": "bitbucket_basic_auth",
    "identity": {
      "kind": "email_or_username",
      "missingValueErrorKey": "connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername",
      "promptLabelKey": "connectedServices.tokenPrompts.bitbucketEmailOrUsername"
    },
    "missingValueErrorKey": "connectedServices.tokenPrompts.errors.missingApiToken",
    "promptLabelKey": "connectedServices.tokenPrompts.bitbucketApiToken",
    "setupUrl": "https://bitbucket.org/account/settings/app-passwords/",
    "tokenKind": "api-token"
  },
  "ui": {
    "connectCommand": "happier connect bitbucket --token",
    "oauthAddActionModes": []
  },
  "version": "1"
} satisfies ResolvedConnectedAccountDescriptorContribution['definition']),
  } satisfies ResolvedConnectedAccountDescriptorContribution),
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.scm.hosting.github",
    manifestPath: "bundled:happier.scm.hosting.github",
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
  "aliases": [
    "github"
  ],
  "capabilityGates": [],
  "connectModes": [
    {
      "credentialKind": "token",
      "default": true,
      "mode": "token",
      "targetId": "github",
      "tokenKind": "personal-access-token"
    }
  ],
  "credentialKinds": [
    "token"
  ],
  "defaultCredentialKind": "token",
  "displayKey": "connectedServices.serviceNames.github",
  "hidden": false,
  "id": "github",
  "kind": "auth.connectedAccount",
  "materialization": {
    "hookKey": "connectedServices.materialization.githubScmHostingToken",
    "materializationKinds": [
      "scm_hosting_token"
    ]
  },
  "permissionGates": [],
  "quota": {
    "capabilityIds": []
  },
  "redaction": "none",
  "tokenSetup": {
    "missingValueErrorKey": "connectedServices.tokenPrompts.errors.missingPersonalAccessToken",
    "permissions": {
      "administration": "write",
      "contents": "write",
      "pull_requests": "write"
    },
    "promptLabelKey": "connectedServices.tokenPrompts.githubPersonalAccessToken",
    "setupUrl": "https://github.com/settings/personal-access-tokens/new?name=Happier+SCM&description=Token+for+Happier+source-control+workflows&expires_in=90&contents=write&pull_requests=write&administration=write",
    "tokenKind": "personal-access-token"
  },
  "ui": {
    "connectCommand": "happier connect github --token",
    "oauthAddActionModes": []
  },
  "version": "1"
} satisfies ResolvedConnectedAccountDescriptorContribution['definition']),
  } satisfies ResolvedConnectedAccountDescriptorContribution),
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
