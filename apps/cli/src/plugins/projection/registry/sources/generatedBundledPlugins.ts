/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Runtime reads this local artifact; bundled plugin packages are locator metadata except
 * for narrow runtime contribution subpath imports.
 */

import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';
import type { CommandHandler } from '@/cli/commandRegistry';
import { createProviderRuntimeCatalogEntryHooks } from '../providerCatalogEntryHooks';
import { CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-claude/agent/contributions/runtime';
import { CODEX_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/runtime';
import { COPILOT_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-copilot/agent/contributions/runtime';
import { KILO_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kilo/agent/contributions/runtime';
import { KIMI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kimi/agent/contributions/runtime';
import { OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-opencode/agent/contributions/runtime';
import { PI_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/runtime';
import { createCodexExternalSessionCandidateHostAdapter as CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER } from '@/backends/codex/appServer/session/externalCandidates';
import { createCodexExternalSessionTranscriptStoreAdapter as CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER } from '@/backends/codex/rollout/sessionStore/externalTranscriptAdapter';

import type {
  ResolvedActivationTarget,
  ResolvedBackendContribution,
  ResolvedCatalogEntry,
  ResolvedConnectedAccountDescriptorContribution,
  ResolvedInstallableContribution,
  ResolvedExecutionRunProfileContribution,
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
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-pi",
  "@happier-dev/plugins-qwen",
  "@happier-dev/plugins-review-coderabbit",
  "@happier-dev/plugins-review-deepsec",
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
    "agentId": "auggie",
    "manifestDigest": "bundled:@happier-dev/plugins-auggie@0.0.0",
    "manifestPath": "bundled:happier.agent.auggie",
    "packageName": "@happier-dev/plugins-auggie",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.auggie",
    "pluginPackageId": "auggie"
  },
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
    "agentId": "copilot",
    "manifestDigest": "bundled:@happier-dev/plugins-copilot@0.0.0",
    "manifestPath": "bundled:happier.agent.copilot",
    "packageName": "@happier-dev/plugins-copilot",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.copilot",
    "pluginPackageId": "copilot"
  },
  {
    "agentId": "cursor",
    "manifestDigest": "bundled:@happier-dev/plugins-cursor@0.0.0",
    "manifestPath": "bundled:happier.agent.cursor",
    "packageName": "@happier-dev/plugins-cursor",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.cursor",
    "pluginPackageId": "cursor"
  },
  {
    "agentId": "gemini",
    "manifestDigest": "bundled:@happier-dev/plugins-gemini@0.0.0",
    "manifestPath": "bundled:happier.agent.gemini",
    "packageName": "@happier-dev/plugins-gemini",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.gemini",
    "pluginPackageId": "gemini"
  },
  {
    "agentId": "kilo",
    "manifestDigest": "bundled:@happier-dev/plugins-kilo@0.0.0",
    "manifestPath": "bundled:happier.agent.kilo",
    "packageName": "@happier-dev/plugins-kilo",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kilo",
    "pluginPackageId": "kilo"
  },
  {
    "agentId": "kimi",
    "manifestDigest": "bundled:@happier-dev/plugins-kimi@0.0.0",
    "manifestPath": "bundled:happier.agent.kimi",
    "packageName": "@happier-dev/plugins-kimi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kimi",
    "pluginPackageId": "kimi"
  },
  {
    "agentId": "ohMyPi",
    "manifestDigest": "bundled:@happier-dev/plugins-ohmypi@0.0.0",
    "manifestPath": "bundled:happier.agent.ohmypi",
    "packageName": "@happier-dev/plugins-ohmypi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.ohmypi",
    "pluginPackageId": "ohmypi"
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
    "agentId": "pi",
    "manifestDigest": "bundled:@happier-dev/plugins-pi@0.0.0",
    "manifestPath": "bundled:happier.agent.pi",
    "packageName": "@happier-dev/plugins-pi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.pi",
    "pluginPackageId": "pi"
  },
  {
    "agentId": "qwen",
    "manifestDigest": "bundled:@happier-dev/plugins-qwen@0.0.0",
    "manifestPath": "bundled:happier.agent.qwen",
    "packageName": "@happier-dev/plugins-qwen",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.qwen",
    "pluginPackageId": "qwen"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-review-coderabbit@0.0.0",
    "manifestPath": "bundled:happier.review.coderabbit",
    "packageName": "@happier-dev/plugins-review-coderabbit",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.coderabbit",
    "pluginPackageId": "review-coderabbit"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
    "manifestPath": "bundled:happier.review.deepsec",
    "packageName": "@happier-dev/plugins-review-deepsec",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.deepsec",
    "pluginPackageId": "review-deepsec"
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

export const BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID: Readonly<Record<string, ProviderCliRuntimeDescriptor>> = Object.freeze({
  auggie: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "auggie",
  "docsUrl": "https://augmentcode.com",
  "id": "auggie",
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "auggie",
    "kind": "managed_package",
    "packageName": "@augmentcode/auggie"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Auggie CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  claude: Object.freeze({
  "acceptsJavaScriptFileOverride": true,
  "binaryName": "claude",
  "docsUrl": "https://claude.ai",
  "id": "claude",
  "installGuideUrl": "https://code.claude.com/docs/en/setup",
  "knownUserBinDirSuffixes": [
    ".local/bin"
  ],
  "managedInstall": null,
  "manualInstallKind": "vendor_recipe",
  "manualInstallRecipes": {
    "darwin": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://claude.ai/install.sh | bash"
        ],
        "cmd": "bash"
      }
    ],
    "linux": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://claude.ai/install.sh | bash"
        ],
        "cmd": "bash"
      }
    ],
    "win32": [
      {
        "args": [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm https://claude.ai/install.ps1 | iex"
        ],
        "cmd": "powershell"
      }
    ]
  },
  "setupRecommendation": {
    "order": 10
  },
  "sourcePreferenceDefault": "system-first",
  "title": "Claude Code CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  codex: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "codex",
  "id": "codex",
  "managedInstall": null,
  "manualInstallKind": "none",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "codex CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  copilot: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "copilot",
  "docsUrl": "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
  "id": "copilot",
  "installGuideUrl": null,
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "copilot",
    "kind": "managed_package",
    "packageName": "@github/copilot"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "GitHub Copilot CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  cursor: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "cursor-agent",
  "docsUrl": "https://cursor.com/docs/cli",
  "id": "cursor",
  "installGuideUrl": "https://cursor.com/docs/cli/installation",
  "knownUserBinDirSuffixes": [
    ".local/bin"
  ],
  "managedInstall": null,
  "manualInstallKind": "vendor_recipe",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Cursor Agent CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  gemini: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "gemini",
  "docsUrl": "https://goo.gle/gemini-cli-auth-docs",
  "id": "gemini",
  "installGuideUrl": null,
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "gemini",
    "kind": "managed_package",
    "packageName": "@google/gemini-cli"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Google Gemini CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  kilo: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "kilo",
  "docsUrl": "https://kilo.ai/docs/cli",
  "id": "kilo",
  "installGuideUrl": null,
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "kilo",
    "kind": "managed_package",
    "packageName": "@kilocode/cli"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Kilo CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  kimi: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "kimi",
  "docsUrl": "https://code.kimi.com",
  "id": "kimi",
  "installGuideUrl": "https://kimi.moonshot.cn/docs/cli",
  "knownUserBinDirSuffixes": [
    ".local/bin"
  ],
  "managedInstall": null,
  "manualInstallKind": "vendor_recipe",
  "manualInstallRecipes": {
    "darwin": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://code.kimi.com/install.sh | bash"
        ],
        "cmd": "bash"
      }
    ],
    "linux": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://code.kimi.com/install.sh | bash"
        ],
        "cmd": "bash"
      }
    ],
    "win32": [
      {
        "args": [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression"
        ],
        "cmd": "powershell"
      }
    ]
  },
  "sourcePreferenceDefault": "system-first",
  "title": "Kimi CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  kiro: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "kiro-cli",
  "docsUrl": "https://kiro.dev/docs/cli/acp/",
  "id": "kiro",
  "knownUserBinDirSuffixes": null,
  "managedInstall": null,
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Kiro CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  ohMyPi: Object.freeze({
  "acceptsJavaScriptFileOverride": true,
  "binaryName": "omp",
  "docsUrl": "https://github.com/can1357/oh-my-pi",
  "id": "ohMyPi",
  "installGuideUrl": "https://github.com/can1357/oh-my-pi#via-bun-recommended",
  "knownUserBinDirSuffixes": [
    ".bun/bin"
  ],
  "managedInstall": {
    "binaryName": "omp",
    "githubRepo": "can1357/oh-my-pi",
    "kind": "github_release_binary"
  },
  "manualInstallKind": "vendor_recipe",
  "manualInstallRecipes": {
    "darwin": [
      {
        "args": [
          "install",
          "-g",
          "@oh-my-pi/pi-coding-agent"
        ],
        "cmd": "bun"
      }
    ],
    "linux": [
      {
        "args": [
          "install",
          "-g",
          "@oh-my-pi/pi-coding-agent"
        ],
        "cmd": "bun"
      }
    ],
    "win32": [
      {
        "args": [
          "install",
          "-g",
          "@oh-my-pi/pi-coding-agent"
        ],
        "cmd": "bun"
      }
    ]
  },
  "sourcePreferenceDefault": "system-first",
  "title": "oh-my-pi CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  opencode: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "opencode",
  "docsUrl": "https://opencode.ai",
  "id": "opencode",
  "installGuideUrl": "https://opencode.ai/docs",
  "knownUserBinDirSuffixes": [
    ".opencode/bin",
    "AppData/Roaming/npm"
  ],
  "managedInstall": null,
  "manualInstallKind": "vendor_recipe",
  "manualInstallRecipes": {
    "darwin": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://opencode.ai/install | bash"
        ],
        "cmd": "bash"
      }
    ],
    "linux": [
      {
        "args": [
          "-lc",
          "curl -fsSL https://opencode.ai/install | bash"
        ],
        "cmd": "bash"
      }
    ],
    "win32": [
      {
        "args": [
          "/c",
          "npm install -g opencode-ai"
        ],
        "cmd": "cmd.exe",
        "note": null
      }
    ]
  },
  "setupRecommendation": {
    "order": 40
  },
  "sourcePreferenceDefault": "system-first",
  "title": "OpenCode CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  pi: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "pi",
  "docsUrl": null,
  "id": "pi",
  "installGuideUrl": "https://github.com/badlogic/pi-mono",
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "pi",
    "kind": "managed_package",
    "packageName": "@earendil-works/pi-coding-agent"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Pi Coding Agent CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
  qwen: Object.freeze({
  "acceptsJavaScriptFileOverride": false,
  "binaryName": "qwen",
  "docsUrl": null,
  "id": "qwen",
  "installGuideUrl": "https://qwenlm.github.io/qwen-code-docs/",
  "knownUserBinDirSuffixes": null,
  "managedInstall": {
    "binaryName": "qwen",
    "kind": "managed_package",
    "packageName": "@qwen-code/qwen-code"
  },
  "manualInstallKind": "command",
  "manualInstallRecipes": null,
  "sourcePreferenceDefault": "system-first",
  "title": "Qwen CLI"
} as const satisfies ProviderCliRuntimeDescriptor),
});

function readBundledFirstPartyAgentCliRuntimeSpec(agentId: string): ProviderCliRuntimeDescriptor {
  const runtimeSpec = BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID[agentId];
  if (!runtimeSpec) {
    throw new Error(`Missing bundled first-party agent CLI runtime spec for agent '${agentId}'`);
  }
  return runtimeSpec;
}

function createBundledProviderCliCommandHandler(agentId: string): () => Promise<CommandHandler> {
  return async () => {
    const { runBackendSessionCliCommand } = await import('@/cli/runBackendSessionCliCommand');
    return async (context) => {
      await runBackendSessionCliCommand({
        context,
        backendIdForSessionRuntime: agentId,
        agentIdForAccountSettings: agentId as Parameters<typeof runBackendSessionCliCommand>[0]['agentIdForAccountSettings'],
      });
    };
  };
}

export const BUNDLED_FIRST_PARTY_PROVIDER_CATALOG_ENTRY_HOOKS = Object.freeze({
  claude: createProviderRuntimeCatalogEntryHooks({
    agentId: 'claude',
    packageName: '@happier-dev/plugins-claude',
    systemTools: Object.freeze([
  {
    "defaultArgs": [],
    "displayName": "macOS Keychain security",
    "lookupNames": [
      "security"
    ],
    "source": "system",
    "toolId": "claude.macos.security"
  }
]),
    contribution: CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
  codex: createProviderRuntimeCatalogEntryHooks({
    agentId: 'codex',
    packageName: '@happier-dev/plugins-codex',
    systemTools: Object.freeze([
  {
    "defaultArgs": [],
    "displayName": "Codex ACP",
    "lookupNames": [
      "codex-acp"
    ],
    "source": "system",
    "toolId": "codex-acp"
  }
]),
    contribution: {
      ...CODEX_PROVIDER_RUNTIME_CONTRIBUTION,
      externalSessions: {
        createCandidateHostAdapter: CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER,
        createTranscriptStoreAdapter: CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER,
      },
    },
  }),
  copilot: createProviderRuntimeCatalogEntryHooks({
    agentId: 'copilot',
    packageName: '@happier-dev/plugins-copilot',
    contribution: COPILOT_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
  kilo: createProviderRuntimeCatalogEntryHooks({
    agentId: 'kilo',
    packageName: '@happier-dev/plugins-kilo',
    contribution: KILO_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
  kimi: createProviderRuntimeCatalogEntryHooks({
    agentId: 'kimi',
    packageName: '@happier-dev/plugins-kimi',
    contribution: KIMI_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
  opencode: createProviderRuntimeCatalogEntryHooks({
    agentId: 'opencode',
    packageName: '@happier-dev/plugins-opencode',
    contribution: OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
  pi: createProviderRuntimeCatalogEntryHooks({
    agentId: 'pi',
    packageName: '@happier-dev/plugins-pi',
    contribution: PI_PROVIDER_RUNTIME_CONTRIBUTION,
  }),
} satisfies Readonly<Record<string, () => Partial<ResolvedCatalogEntry>>>);

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
[
  Object.freeze({
    id: "claude",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "claude",
  "kindVersion": 1,
  "ownedBackendIds": [
    "claude"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("claude"),
    catalogEntry: Object.freeze({
      id: "claude",
      cliSubcommand: "claude",
      getCliCommandHandler: createBundledProviderCliCommandHandler("claude"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("claude"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "codex",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "codex",
  "kindVersion": 1,
  "ownedBackendIds": [
    "codex"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("codex"),
    catalogEntry: Object.freeze({
      id: "codex",
      cliSubcommand: "codex",
      getCliCommandHandler: createBundledProviderCliCommandHandler("codex"),
      vendorResumeSupport: "experimental",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("codex"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "opencode",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "opencode",
  "kindVersion": 1,
  "ownedBackendIds": [
    "opencode"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("opencode"),
    catalogEntry: Object.freeze({
      id: "opencode",
      cliSubcommand: "opencode",
      getCliCommandHandler: createBundledProviderCliCommandHandler("opencode"),
      vendorResumeSupport: "supported",
      rootHelpLabel: "happier opencode",
      rootHelpDescription: "Start OpenCode CLI",
      allowTmux: true,
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("opencode"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "gemini",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "gemini",
  "kindVersion": 1,
  "ownedBackendIds": [
    "gemini"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("gemini"),
    catalogEntry: Object.freeze({
      id: "gemini",
      cliSubcommand: "gemini",
      getCliCommandHandler: createBundledProviderCliCommandHandler("gemini"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("gemini"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "auggie",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "auggie",
  "kindVersion": 1,
  "ownedBackendIds": [
    "auggie"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("auggie"),
    catalogEntry: Object.freeze({
      id: "auggie",
      cliSubcommand: "auggie",
      getCliCommandHandler: createBundledProviderCliCommandHandler("auggie"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("auggie"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "qwen",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "qwen",
  "kindVersion": 1,
  "ownedBackendIds": [
    "qwen"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("qwen"),
    catalogEntry: Object.freeze({
      id: "qwen",
      cliSubcommand: "qwen",
      getCliCommandHandler: createBundledProviderCliCommandHandler("qwen"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("qwen"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "kimi",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "kimi",
  "kindVersion": 1,
  "ownedBackendIds": [
    "kimi"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("kimi"),
    catalogEntry: Object.freeze({
      id: "kimi",
      cliSubcommand: "kimi",
      getCliCommandHandler: createBundledProviderCliCommandHandler("kimi"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("kimi"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "kilo",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "kilo",
  "kindVersion": 1,
  "ownedBackendIds": [
    "kilo"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("kilo"),
    catalogEntry: Object.freeze({
      id: "kilo",
      cliSubcommand: "kilo",
      getCliCommandHandler: createBundledProviderCliCommandHandler("kilo"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("kilo"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "kiro",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "kiro",
  "kindVersion": 1,
  "ownedBackendIds": [
    "kiro"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("kiro"),
    catalogEntry: Object.freeze({
      id: "kiro",
      cliSubcommand: "kiro",
      getCliCommandHandler: createBundledProviderCliCommandHandler("kiro"),
      vendorResumeSupport: "experimental",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("kiro"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "cursor",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "cursor",
  "kindVersion": 1,
  "ownedBackendIds": [
    "cursor"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("cursor"),
    catalogEntry: Object.freeze({
      id: "cursor",
      cliSubcommand: "cursor",
      getCliCommandHandler: createBundledProviderCliCommandHandler("cursor"),
      vendorResumeSupport: "experimental",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("cursor"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "ohMyPi",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "ohMyPi",
  "kindVersion": 1,
  "ownedBackendIds": [
    "ohMyPi"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("ohMyPi"),
    catalogEntry: Object.freeze({
      id: "ohMyPi",
      cliSubcommand: "ohMyPi",
      getCliCommandHandler: createBundledProviderCliCommandHandler("ohMyPi"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("ohMyPi"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "pi",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "pi",
  "kindVersion": 1,
  "ownedBackendIds": [
    "pi"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("pi"),
    catalogEntry: Object.freeze({
      id: "pi",
      cliSubcommand: "pi",
      getCliCommandHandler: createBundledProviderCliCommandHandler("pi"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("pi"),
  } satisfies ResolvedProviderContribution),
  Object.freeze({
    id: "copilot",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: Object.freeze({
  "id": "copilot",
  "kindVersion": 1,
  "ownedBackendIds": [
    "copilot"
  ]
} as const satisfies ResolvedProviderContribution['definition']),
    runtimeSpec: readBundledFirstPartyAgentCliRuntimeSpec("copilot"),
    catalogEntry: Object.freeze({
      id: "copilot",
      cliSubcommand: "copilot",
      getCliCommandHandler: createBundledProviderCliCommandHandler("copilot"),
      vendorResumeSupport: "supported",
    } satisfies ResolvedCatalogEntry),
    ...buildBundledMetadataFields("copilot"),
  } satisfies ResolvedProviderContribution),
]
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
        "support": "supported"
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
        "reason": "not_implemented",
        "support": "unsupported"
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
    "oauthAddActionModes": [],
    "shortName": "GitHub"
  },
  "version": "1"
} satisfies ResolvedConnectedAccountDescriptorContribution['definition']),
  } satisfies ResolvedConnectedAccountDescriptorContribution),
]);

const bundledBackendSurfaceHandlersById = new Map<string, NonNullable<ResolvedBackendContribution['surfaceHandlers']>>([
  ["claude", Object.freeze([
  {
    "handler": {
      "exportName": "resolveClaudeExternalSessionSource",
      "target": "daemon"
    },
    "id": "claude.externalSession.resolveSource",
    "kind": "externalSession",
    "operation": "resolveSource",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "listClaudeExternalSessionCandidates",
      "target": "daemon"
    },
    "id": "claude.externalSession.listCandidates",
    "kind": "externalSession",
    "operation": "listCandidates",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "getClaudeExternalSessionActivity",
      "target": "daemon"
    },
    "id": "claude.externalSession.getActivity",
    "kind": "externalSession",
    "operation": "getActivity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "pageClaudeExternalSessionTranscript",
      "target": "daemon"
    },
    "id": "claude.externalSession.pageTranscript",
    "kind": "externalSession",
    "operation": "pageTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "readClaudeExternalSessionAfterTranscript",
      "target": "daemon"
    },
    "id": "claude.externalSession.readAfterTranscript",
    "kind": "externalSession",
    "operation": "readAfterTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveClaudeExternalSessionFollowTranscriptPath",
      "target": "daemon"
    },
    "id": "claude.externalSession.resolveFollowTranscriptPath",
    "kind": "externalSession",
    "operation": "resolveFollowTranscriptPath",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "acquireClaudeExternalSessionFollowLease",
      "target": "daemon"
    },
    "id": "claude.externalSession.acquireFollowLease",
    "kind": "externalSession",
    "operation": "acquireFollowLease",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveClaudeExternalSessionLinkIdentity",
      "target": "daemon"
    },
    "id": "claude.externalSession.resolveLinkIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveLinkedClaudeExternalSessionIdentity",
      "target": "daemon"
    },
    "id": "claude.externalSession.resolveLinkedIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkedIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveClaudeExternalSessionTakeoverLaunch",
      "target": "daemon"
    },
    "id": "claude.externalSession.resolveTakeoverLaunch",
    "kind": "externalSession",
    "operation": "resolveTakeoverLaunch",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "exportClaudeSessionBundle",
      "target": "daemon"
    },
    "id": "claude.handoff.exportBundle",
    "kind": "handoff",
    "operation": "exportBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "importClaudeSessionBundle",
      "target": "daemon"
    },
    "id": "claude.handoff.importBundle",
    "kind": "handoff",
    "operation": "importBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  }
] as const)],
  ["codex", Object.freeze([
  {
    "handler": {
      "exportName": "exportCodexSessionBundle",
      "target": "daemon"
    },
    "id": "codex.handoff.exportBundle",
    "kind": "handoff",
    "operation": "exportBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "importCodexSessionBundle",
      "target": "daemon"
    },
    "id": "codex.handoff.importBundle",
    "kind": "handoff",
    "operation": "importBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "forkCodexSession",
      "target": "daemon"
    },
    "id": "codex.fork.fork",
    "kind": "fork",
    "operation": "fork",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.terminalRuntime.launch",
    "kind": "terminalRuntime",
    "operation": "launch",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.resolveSource",
    "kind": "externalSession",
    "operation": "resolveSource",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.listCandidates",
    "kind": "externalSession",
    "operation": "listCandidates",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.getActivity",
    "kind": "externalSession",
    "operation": "getActivity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.pageTranscript",
    "kind": "externalSession",
    "operation": "pageTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.readAfterTranscript",
    "kind": "externalSession",
    "operation": "readAfterTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.resolveFollowTranscriptPath",
    "kind": "externalSession",
    "operation": "resolveFollowTranscriptPath",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.acquireFollowLease",
    "kind": "externalSession",
    "operation": "acquireFollowLease",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.resolveLinkIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.resolveLinkedIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkedIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "target": "daemon"
    },
    "id": "codex.externalSession.resolveTakeoverLaunch",
    "kind": "externalSession",
    "operation": "resolveTakeoverLaunch",
    "support": "supported",
    "surfaceApiVersion": 1
  }
] as const)],
  ["ohMyPi", Object.freeze([
  {
    "handler": {
      "exportName": "resolveOhMyPiExternalSessionSource",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.resolveSource",
    "kind": "externalSession",
    "operation": "resolveSource",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "listOhMyPiExternalSessionCandidates",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.listCandidates",
    "kind": "externalSession",
    "operation": "listCandidates",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "getOhMyPiExternalSessionActivity",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.getActivity",
    "kind": "externalSession",
    "operation": "getActivity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "pageOhMyPiExternalSessionTranscript",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.pageTranscript",
    "kind": "externalSession",
    "operation": "pageTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "readOhMyPiExternalSessionAfterTranscript",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.readAfterTranscript",
    "kind": "externalSession",
    "operation": "readAfterTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOhMyPiExternalSessionFollowTranscriptPath",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.resolveFollowTranscriptPath",
    "kind": "externalSession",
    "operation": "resolveFollowTranscriptPath",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "acquireOhMyPiExternalSessionFollowLease",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.acquireFollowLease",
    "kind": "externalSession",
    "operation": "acquireFollowLease",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOhMyPiExternalSessionLinkIdentity",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.resolveLinkIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveLinkedOhMyPiExternalSessionIdentity",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.resolveLinkedIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkedIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOhMyPiExternalSessionTakeoverLaunch",
      "target": "daemon"
    },
    "id": "ohMyPi.externalSession.resolveTakeoverLaunch",
    "kind": "externalSession",
    "operation": "resolveTakeoverLaunch",
    "support": "supported",
    "surfaceApiVersion": 1
  }
] as const)],
  ["opencode", Object.freeze([
  {
    "handler": {
      "exportName": "resolveOpenCodeExternalSessionSource",
      "target": "daemon"
    },
    "id": "opencode.externalSession.resolveSource",
    "kind": "externalSession",
    "operation": "resolveSource",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "listOpenCodeExternalSessionCandidates",
      "target": "daemon"
    },
    "id": "opencode.externalSession.listCandidates",
    "kind": "externalSession",
    "operation": "listCandidates",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "getOpenCodeExternalSessionActivity",
      "target": "daemon"
    },
    "id": "opencode.externalSession.getActivity",
    "kind": "externalSession",
    "operation": "getActivity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "pageOpenCodeExternalSessionTranscript",
      "target": "daemon"
    },
    "id": "opencode.externalSession.pageTranscript",
    "kind": "externalSession",
    "operation": "pageTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "readOpenCodeExternalSessionAfterTranscript",
      "target": "daemon"
    },
    "id": "opencode.externalSession.readAfterTranscript",
    "kind": "externalSession",
    "operation": "readAfterTranscript",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOpenCodeExternalSessionLinkIdentity",
      "target": "daemon"
    },
    "id": "opencode.externalSession.resolveLinkIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveLinkedOpenCodeExternalSessionIdentity",
      "target": "daemon"
    },
    "id": "opencode.externalSession.resolveLinkedIdentity",
    "kind": "externalSession",
    "operation": "resolveLinkedIdentity",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOpenCodeExternalSessionTakeoverLaunch",
      "target": "daemon"
    },
    "id": "opencode.externalSession.resolveTakeoverLaunch",
    "kind": "externalSession",
    "operation": "resolveTakeoverLaunch",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "exportOpenCodeSessionBundle",
      "target": "daemon"
    },
    "id": "opencode.handoff.exportBundle",
    "kind": "handoff",
    "operation": "exportBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "importOpenCodeSessionBundle",
      "target": "daemon"
    },
    "id": "opencode.handoff.importBundle",
    "kind": "handoff",
    "operation": "importBundle",
    "support": "supported",
    "surfaceApiVersion": 1
  },
  {
    "handler": {
      "exportName": "resolveOpenCodeReplayForkChildLaunch",
      "target": "daemon"
    },
    "id": "opencode.fork.resolveReplayChildLaunch",
    "kind": "fork",
    "operation": "resolveReplayChildLaunch",
    "support": "supported",
    "surfaceApiVersion": 1
  }
] as const)],
]);

export const BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze(
[
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("claude");
    return Object.freeze({
      id: "claude",
      providerId: "claude",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "claude",
  "kindVersion": 1,
  "providerId": "claude"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("claude"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("codex");
    return Object.freeze({
      id: "codex",
      providerId: "codex",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "codex",
  "kindVersion": 1,
  "providerId": "codex"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "appServer",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("codex"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("opencode");
    return Object.freeze({
      id: "opencode",
      providerId: "opencode",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "opencode",
  "kindVersion": 1,
  "providerId": "opencode"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "server",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("opencode"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("gemini");
    return Object.freeze({
      id: "gemini",
      providerId: "gemini",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "gemini",
  "kindVersion": 1,
  "providerId": "gemini"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("gemini"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("auggie");
    return Object.freeze({
      id: "auggie",
      providerId: "auggie",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "auggie",
  "kindVersion": 1,
  "providerId": "auggie"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("auggie"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("qwen");
    return Object.freeze({
      id: "qwen",
      providerId: "qwen",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "qwen",
  "kindVersion": 1,
  "providerId": "qwen"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("qwen"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("kimi");
    return Object.freeze({
      id: "kimi",
      providerId: "kimi",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "kimi",
  "kindVersion": 1,
  "providerId": "kimi"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("kimi"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("kilo");
    return Object.freeze({
      id: "kilo",
      providerId: "kilo",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "kilo",
  "kindVersion": 1,
  "providerId": "kilo"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("kilo"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("kiro");
    return Object.freeze({
      id: "kiro",
      providerId: "kiro",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "kiro",
  "kindVersion": 1,
  "providerId": "kiro"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("kiro"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("cursor");
    return Object.freeze({
      id: "cursor",
      providerId: "cursor",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "cursor",
  "kindVersion": 1,
  "providerId": "cursor"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("cursor"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("ohMyPi");
    return Object.freeze({
      id: "ohMyPi",
      providerId: "ohMyPi",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "ohMyPi",
  "kindVersion": 1,
  "providerId": "ohMyPi"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("ohMyPi"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("pi");
    return Object.freeze({
      id: "pi",
      providerId: "pi",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "pi",
  "kindVersion": 1,
  "providerId": "pi"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("pi"),
    } satisfies ResolvedBackendContribution);
  })(),
  (() => {
    const surfaceHandlers = bundledBackendSurfaceHandlersById.get("copilot");
    return Object.freeze({
      id: "copilot",
      providerId: "copilot",
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: Object.freeze({
  "id": "copilot",
  "kindVersion": 1,
  "providerId": "copilot"
} as const satisfies ResolvedBackendContribution['definition']),
      runtimeKind: "native",
      ...(surfaceHandlers ? { surfaceHandlers } : {}),
      ...buildBundledMetadataFields("copilot"),
    } satisfies ResolvedBackendContribution);
  })(),
]
);

export const BUNDLED_FIRST_PARTY_PLUGIN_BACKEND_CONTRIBUTIONS: readonly ResolvedBackendContribution[] = Object.freeze([
  Object.freeze({
    id: "coderabbit",
    providerId: "coderabbit",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.review.coderabbit",
    manifestPath: "bundled:happier.review.coderabbit",
    manifestDigest: "bundled:@happier-dev/plugins-review-coderabbit@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-review-coderabbit",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-review-coderabbit",
  "resolvedDigest": "bundled:@happier-dev/plugins-review-coderabbit@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "id": "coderabbit",
  "kindVersion": 1,
  "providerId": "coderabbit"
} as const),
    richDefinition: {
      provenance: 'external',
      definition: Object.freeze({
  "capabilities": {
    "executionRun": {
      "review": {
        "cancellation": {
          "processTree": true,
          "supportsAbort": true
        },
        "costClass": "metered",
        "directCommentWrite": false,
        "intents": [
          "review"
        ],
        "modes": [
          "change_scoped_review"
        ],
        "requiredSecrets": [
          "CODERABBIT_API_KEY"
        ],
        "requiresSystemCli": "coderabbit",
        "taxonomyFamilies": [
          "style",
          "correctness",
          "maintainability"
        ]
      },
      "supported": true
    },
    "session": {
      "contextCompaction": {
        "events": {
          "supported": false
        },
        "manualTrigger": {
          "supported": false
        },
        "transcriptInference": {
          "supported": false
        }
      },
      "media": {
        "acceptsImageInput": {
          "supported": false
        },
        "emitsSessionMedia": {
          "supported": false
        },
        "nativeImageGeneration": {
          "supported": false
        }
      },
      "supported": false
    }
  },
  "id": "coderabbit",
  "kindVersion": 1,
  "providerId": "coderabbit",
  "runtimeKind": "custom",
  "surfaceHandlers": [],
  "title": "CodeRabbit"
} as const),
    },
    runtimeKind: "custom",
    capabilities: Object.freeze({
  "executionRun": {
    "review": {
      "cancellation": {
        "processTree": true,
        "supportsAbort": true
      },
      "costClass": "metered",
      "directCommentWrite": false,
      "intents": [
        "review"
      ],
      "modes": [
        "change_scoped_review"
      ],
      "requiredSecrets": [
        "CODERABBIT_API_KEY"
      ],
      "requiresSystemCli": "coderabbit",
      "taxonomyFamilies": [
        "style",
        "correctness",
        "maintainability"
      ]
    },
    "supported": true
  },
  "session": {
    "contextCompaction": {
      "events": {
        "supported": false
      },
      "manualTrigger": {
        "supported": false
      },
      "transcriptInference": {
        "supported": false
      }
    },
    "media": {
      "acceptsImageInput": {
        "supported": false
      },
      "emitsSessionMedia": {
        "supported": false
      },
      "nativeImageGeneration": {
        "supported": false
      }
    },
    "supported": false
  }
} as const),
    surfaceHandlers: Object.freeze([] as const),
  } satisfies ResolvedBackendContribution),
  Object.freeze({
    id: "deepsec",
    providerId: "deepsec",
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.review.deepsec",
    manifestPath: "bundled:happier.review.deepsec",
    manifestDigest: "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-review-deepsec",
  "resolvedDigest": "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "id": "deepsec",
  "kindVersion": 1,
  "providerId": "deepsec"
} as const),
    richDefinition: {
      provenance: 'external',
      definition: Object.freeze({
  "capabilities": {
    "executionRun": {
      "review": {
        "cancellation": {
          "processTree": true,
          "supportsAbort": true
        },
        "costClass": "expensive",
        "directCommentWrite": false,
        "intents": [
          "review"
        ],
        "modes": [
          "repository_security_audit",
          "change_scoped_review"
        ],
        "requiredPrerequisites": [
          "node>=22",
          "claude-or-codex",
          "AI_GATEWAY_API_KEY"
        ],
        "requiresSystemCli": "deepsec",
        "taxonomyFamilies": [
          "security",
          "cwe",
          "cve",
          "secrets"
        ]
      },
      "supported": true
    },
    "session": {
      "contextCompaction": {
        "events": {
          "supported": false
        },
        "manualTrigger": {
          "supported": false
        },
        "transcriptInference": {
          "supported": false
        }
      },
      "media": {
        "acceptsImageInput": {
          "supported": false
        },
        "emitsSessionMedia": {
          "supported": false
        },
        "nativeImageGeneration": {
          "supported": false
        }
      },
      "supported": false
    }
  },
  "id": "deepsec",
  "kindVersion": 1,
  "providerId": "deepsec",
  "runtimeKind": "custom",
  "surfaceHandlers": [],
  "title": "DeepSec"
} as const),
    },
    runtimeKind: "custom",
    capabilities: Object.freeze({
  "executionRun": {
    "review": {
      "cancellation": {
        "processTree": true,
        "supportsAbort": true
      },
      "costClass": "expensive",
      "directCommentWrite": false,
      "intents": [
        "review"
      ],
      "modes": [
        "repository_security_audit",
        "change_scoped_review"
      ],
      "requiredPrerequisites": [
        "node>=22",
        "claude-or-codex",
        "AI_GATEWAY_API_KEY"
      ],
      "requiresSystemCli": "deepsec",
      "taxonomyFamilies": [
        "security",
        "cwe",
        "cve",
        "secrets"
      ]
    },
    "supported": true
  },
  "session": {
    "contextCompaction": {
      "events": {
        "supported": false
      },
      "manualTrigger": {
        "supported": false
      },
      "transcriptInference": {
        "supported": false
      }
    },
    "media": {
      "acceptsImageInput": {
        "supported": false
      },
      "emitsSessionMedia": {
        "supported": false
      },
      "nativeImageGeneration": {
        "supported": false
      }
    },
    "supported": false
  }
} as const),
    surfaceHandlers: Object.freeze([] as const),
  } satisfies ResolvedBackendContribution),
]);

export const BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS: readonly ResolvedExecutionRunProfileContribution[] = Object.freeze([
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.review.coderabbit",
    manifestPath: "bundled:happier.review.coderabbit",
    manifestDigest: "bundled:@happier-dev/plugins-review-coderabbit@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-review-coderabbit",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-review-coderabbit",
  "resolvedDigest": "bundled:@happier-dev/plugins-review-coderabbit@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "actionIds": [
    "review.start"
  ],
  "capabilityGates": [],
  "displayKey": "plugins.coderabbit.executionRuns.review.label",
  "hidden": false,
  "id": "coderabbit.review",
  "intent": "review",
  "kind": "executionRun.profile",
  "permissionGates": [],
  "redaction": "none",
  "version": "1"
} as const satisfies ResolvedExecutionRunProfileContribution['definition']),
  } satisfies ResolvedExecutionRunProfileContribution),
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.review.deepsec",
    manifestPath: "bundled:happier.review.deepsec",
    manifestDigest: "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-review-deepsec",
  "resolvedDigest": "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "actionIds": [
    "review.start"
  ],
  "capabilityGates": [],
  "displayKey": "plugins.deepsec.executionRuns.review.label",
  "hidden": false,
  "id": "deepsec.review",
  "intent": "review",
  "kind": "executionRun.profile",
  "permissionGates": [],
  "redaction": "none",
  "version": "1"
} as const satisfies ResolvedExecutionRunProfileContribution['definition']),
  } satisfies ResolvedExecutionRunProfileContribution),
  Object.freeze({
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: "happier.review.deepsec",
    manifestPath: "bundled:happier.review.deepsec",
    manifestDigest: "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: {
  "installPolicy": "link",
  "kind": "package",
  "locator": "@happier-dev/plugins-review-deepsec",
  "resolvedDigest": "bundled:@happier-dev/plugins-review-deepsec@0.0.0",
  "resolvedVersion": "0.0.0",
  "trustPolicy": "local_trusted"
},
    definition: Object.freeze({
  "actionIds": [
    "review.start"
  ],
  "capabilityGates": [],
  "displayKey": "plugins.deepsec.executionRuns.securityReview.label",
  "hidden": false,
  "id": "deepsec.securityReview",
  "intent": "review",
  "kind": "executionRun.profile",
  "permissionGates": [],
  "redaction": "none",
  "version": "1"
} as const satisfies ResolvedExecutionRunProfileContribution['definition']),
  } satisfies ResolvedExecutionRunProfileContribution),
]);

export const BUNDLED_FIRST_PARTY_CATALOG_ENTRIES: readonly ResolvedCatalogEntry[] = Object.freeze(
  BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) => provider.catalogEntry)
    .filter((entry): entry is ResolvedCatalogEntry => Boolean(entry)),
);
