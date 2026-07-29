/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (WS1.T3)
 *
 * Locator/provenance records and trusted implementation bindings only.
 * Contribution declarations are ingested from each PLUGIN_MANIFEST by the
 * same canonical path used for installed plugins.
 */

import { createPluginContributionIdentity } from '@happier-dev/protocol';
import type { PluginContributionIdentityV1, PluginSourceSpecV1 } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as ANTIGRAVITY_PLUGIN_MANIFEST } from '@happier-dev/plugins-antigravity/manifest';
import { PLUGIN_MANIFEST as AUGGIE_PLUGIN_MANIFEST } from '@happier-dev/plugins-auggie/manifest';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { PLUGIN_MANIFEST as CLIPROXYAPI_PLUGIN_MANIFEST } from '@happier-dev/plugins-cliproxyapi/manifest';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { PLUGIN_MANIFEST as COPILOT_PLUGIN_MANIFEST } from '@happier-dev/plugins-copilot/manifest';
import { PLUGIN_MANIFEST as CURSOR_PLUGIN_MANIFEST } from '@happier-dev/plugins-cursor/manifest';
import { PLUGIN_MANIFEST as DEEPSEEK_PLUGIN_MANIFEST } from '@happier-dev/plugins-deepseek/manifest';
import { PLUGIN_MANIFEST as ELEVENLABS_PLUGIN_MANIFEST } from '@happier-dev/plugins-elevenlabs/manifest';
import { PLUGIN_MANIFEST as GEMINI_PLUGIN_MANIFEST } from '@happier-dev/plugins-gemini/manifest';
import { PLUGIN_MANIFEST as GOOGLE_PLUGIN_MANIFEST } from '@happier-dev/plugins-google/manifest';
import { PLUGIN_MANIFEST as GROK_PLUGIN_MANIFEST } from '@happier-dev/plugins-grok/manifest';
import { PLUGIN_MANIFEST as INSPECTOR_PLUGIN_MANIFEST } from '@happier-dev/plugins-inspector/manifest';
import { PLUGIN_MANIFEST as KILO_PLUGIN_MANIFEST } from '@happier-dev/plugins-kilo/manifest';
import { PLUGIN_MANIFEST as KIMI_PLUGIN_MANIFEST } from '@happier-dev/plugins-kimi/manifest';
import { PLUGIN_MANIFEST as KIRO_PLUGIN_MANIFEST } from '@happier-dev/plugins-kiro/manifest';
import { PLUGIN_MANIFEST as LMSTUDIO_PLUGIN_MANIFEST } from '@happier-dev/plugins-lmstudio/manifest';
import { PLUGIN_MANIFEST as OHMYPI_PLUGIN_MANIFEST } from '@happier-dev/plugins-ohmypi/manifest';
import { PLUGIN_MANIFEST as OLLAMA_PLUGIN_MANIFEST } from '@happier-dev/plugins-ollama/manifest';
import { PLUGIN_MANIFEST as OPENAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-openai/manifest';
import { PLUGIN_MANIFEST as OPENAI_MODELS_PLUGIN_MANIFEST } from '@happier-dev/plugins-openai-models/manifest';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import { PLUGIN_MANIFEST as OPENROUTER_PLUGIN_MANIFEST } from '@happier-dev/plugins-openrouter/manifest';
import { PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST } from '@happier-dev/plugins-pi/manifest';
import { PLUGIN_MANIFEST as QWEN_PLUGIN_MANIFEST } from '@happier-dev/plugins-qwen/manifest';
import { PLUGIN_MANIFEST as REVIEW_CODERABBIT_PLUGIN_MANIFEST } from '@happier-dev/plugins-review-coderabbit/manifest';
import { PLUGIN_MANIFEST as REVIEW_DEEPSEC_PLUGIN_MANIFEST } from '@happier-dev/plugins-review-deepsec/manifest';
import { PLUGIN_MANIFEST as SCM_AZURE_DEVOPS_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-azure-devops/manifest';
import { PLUGIN_MANIFEST as SCM_BITBUCKET_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-bitbucket/manifest';
import { PLUGIN_MANIFEST as SCM_GIT_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-git/manifest';
import { PLUGIN_MANIFEST as SCM_GITHUB_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-github/manifest';
import { PLUGIN_MANIFEST as SCM_GITLAB_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-gitlab/manifest';
import { PLUGIN_MANIFEST as SCM_SAPLING_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-sapling/manifest';
import { PLUGIN_MANIFEST as XAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-xai/manifest';
import { PLUGIN_MANIFEST as ZAI_PLUGIN_MANIFEST } from '@happier-dev/plugins-zai/manifest';
import { MANAGED_PROVIDER_RUNTIME_ADAPTER as CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER } from '@happier-dev/plugins-cliproxyapi';
import { createAgentRuntimeCatalogEntryHooks } from '../agentCatalogEntryHooks';
import { ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-antigravity/agent/contributions/runtime';
import { AUGGIE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-auggie/agent/contributions/runtime';
import { CLAUDE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-claude/agent/contributions/runtime';
import { CODEX_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/runtime';
import { COPILOT_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-copilot/agent/contributions/runtime';
import { CURSOR_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-cursor/agent/contributions/runtime';
import { GEMINI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-gemini/agent/contributions/runtime';
import { GROK_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-grok/agent/contributions/runtime';
import { KILO_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kilo/agent/contributions/runtime';
import { KIMI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kimi/agent/contributions/runtime';
import { KIRO_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kiro/agent/contributions/runtime';
import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-ohmypi/agent/contributions/runtime';
import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-opencode/agent/contributions/runtime';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/runtime';

export type BundledFirstPartyPluginMetadata = Readonly<{
  agentId?: string;
  pluginId: string;
  pluginPackageId: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
  manifestDigest: string;
}>;

export type BundledFirstPartyPluginLocator = Readonly<{
  pluginId: string;
  manifest: unknown;
  manifestPath: string;
  manifestDigest: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath?: string | null;
  sourceSpec: PluginSourceSpecV1;
}>;

export type BundledFirstPartyImplementationBinding = Readonly<{
  identity: PluginContributionIdentityV1;
  implementationOwnerId: string;
  registrationFamily: string;
  implementation: unknown;
  runtimeAdapter?: unknown;
}>;

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-antigravity",
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-elevenlabs",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-google",
  "@happier-dev/plugins-grok",
  "@happier-dev/plugins-inspector",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-kiro",
  "@happier-dev/plugins-lmstudio",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-ollama",
  "@happier-dev/plugins-openai",
  "@happier-dev/plugins-openai-models",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-openrouter",
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
  "@happier-dev/plugins-xai",
  "@happier-dev/plugins-zai",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "antigravity",
    "manifestDigest": "bundled:@happier-dev/plugins-antigravity@0.0.0",
    "manifestPath": "bundled:happier.agent.antigravity",
    "packageName": "@happier-dev/plugins-antigravity",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.antigravity",
    "pluginPackageId": "antigravity"
  },
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
    "manifestDigest": "bundled:@happier-dev/plugins-cliproxyapi@0.0.0",
    "manifestPath": "bundled:happier.provider.cliproxyapi",
    "packageName": "@happier-dev/plugins-cliproxyapi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.cliproxyapi",
    "pluginPackageId": "cliproxyapi"
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
    "manifestDigest": "bundled:@happier-dev/plugins-deepseek@0.0.0",
    "manifestPath": "bundled:happier.provider.deepseek",
    "packageName": "@happier-dev/plugins-deepseek",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.deepseek",
    "pluginPackageId": "deepseek"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-elevenlabs@0.0.0",
    "manifestPath": "bundled:happier.voice.elevenlabs",
    "packageName": "@happier-dev/plugins-elevenlabs",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.elevenlabs",
    "pluginPackageId": "elevenlabs"
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
    "manifestDigest": "bundled:@happier-dev/plugins-google@0.0.0",
    "manifestPath": "bundled:happier.voice.google",
    "packageName": "@happier-dev/plugins-google",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.google",
    "pluginPackageId": "google"
  },
  {
    "agentId": "grok",
    "manifestDigest": "bundled:@happier-dev/plugins-grok@0.0.0",
    "manifestPath": "bundled:happier.agent.grok",
    "packageName": "@happier-dev/plugins-grok",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.grok",
    "pluginPackageId": "grok"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-inspector@0.0.0",
    "manifestPath": "bundled:happier.inspector",
    "packageName": "@happier-dev/plugins-inspector",
    "packageVersion": "0.0.0",
    "pluginId": "happier.inspector",
    "pluginPackageId": "inspector"
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
    "agentId": "kiro",
    "manifestDigest": "bundled:@happier-dev/plugins-kiro@0.0.0",
    "manifestPath": "bundled:happier.agent.kiro",
    "packageName": "@happier-dev/plugins-kiro",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kiro",
    "pluginPackageId": "kiro"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-lmstudio@0.0.0",
    "manifestPath": "bundled:happier.provider.lmstudio",
    "packageName": "@happier-dev/plugins-lmstudio",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.lmstudio",
    "pluginPackageId": "lmstudio"
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
    "manifestDigest": "bundled:@happier-dev/plugins-ollama@0.0.0",
    "manifestPath": "bundled:happier.provider.ollama",
    "packageName": "@happier-dev/plugins-ollama",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.ollama",
    "pluginPackageId": "ollama"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-openai@0.0.0",
    "manifestPath": "bundled:happier.voice.openai",
    "packageName": "@happier-dev/plugins-openai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.openai",
    "pluginPackageId": "openai"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-openai-models@0.0.0",
    "manifestPath": "bundled:happier.provider.openai",
    "packageName": "@happier-dev/plugins-openai-models",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openai",
    "pluginPackageId": "openai-models"
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
    "manifestDigest": "bundled:@happier-dev/plugins-openrouter@0.0.0",
    "manifestPath": "bundled:happier.provider.openrouter",
    "packageName": "@happier-dev/plugins-openrouter",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openrouter",
    "pluginPackageId": "openrouter"
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
    "agentId": "coderabbit",
    "manifestDigest": "sha256:23914961d24555ee8e9c2c3f0ea0d6c76775b4fb78c2406a61d17f2b3e699270",
    "manifestPath": "bundled:happier.review.coderabbit",
    "packageName": "@happier-dev/plugins-review-coderabbit",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.coderabbit",
    "pluginPackageId": "review-coderabbit"
  },
  {
    "agentId": "deepsec",
    "manifestDigest": "sha256:376850bb9f07407225e4b69d4545398113d3c66e62b09926cc4d157ea355c2e7",
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
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-xai@0.0.0",
    "manifestPath": "bundled:happier.voice.xai",
    "packageName": "@happier-dev/plugins-xai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.xai",
    "pluginPackageId": "xai"
  },
  {
    "manifestDigest": "bundled:@happier-dev/plugins-zai@0.0.0",
    "manifestPath": "bundled:happier.provider.zai",
    "packageName": "@happier-dev/plugins-zai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.zai",
    "pluginPackageId": "zai"
  }
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly BundledFirstPartyPluginLocator[] = Object.freeze([
  Object.freeze({
    pluginId: "happier.agent.antigravity",
    manifest: ANTIGRAVITY_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.antigravity",
    manifestDigest: "bundled:@happier-dev/plugins-antigravity@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-antigravity",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-antigravity",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-antigravity@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.auggie",
    manifest: AUGGIE_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.auggie",
    manifestDigest: "bundled:@happier-dev/plugins-auggie@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-auggie",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-auggie",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-auggie@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.claude",
    manifest: CLAUDE_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.claude",
    manifestDigest: "bundled:@happier-dev/plugins-claude@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-claude",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-claude",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-claude@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.cliproxyapi",
    manifest: CLIPROXYAPI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.cliproxyapi",
    manifestDigest: "bundled:@happier-dev/plugins-cliproxyapi@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cliproxyapi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-cliproxyapi@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.codex",
    manifest: CODEX_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.codex",
    manifestDigest: "bundled:@happier-dev/plugins-codex@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-codex",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-codex",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-codex@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.copilot",
    manifest: COPILOT_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.copilot",
    manifestDigest: "bundled:@happier-dev/plugins-copilot@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-copilot",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-copilot",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-copilot@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.cursor",
    manifest: CURSOR_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.cursor",
    manifestDigest: "bundled:@happier-dev/plugins-cursor@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-cursor",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cursor",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-cursor@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.deepseek",
    manifest: DEEPSEEK_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.deepseek",
    manifestDigest: "bundled:@happier-dev/plugins-deepseek@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-deepseek",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-deepseek@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.elevenlabs",
    manifest: ELEVENLABS_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.voice.elevenlabs",
    manifestDigest: "bundled:@happier-dev/plugins-elevenlabs@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-elevenlabs",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-elevenlabs@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.gemini",
    manifest: GEMINI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.gemini",
    manifestDigest: "bundled:@happier-dev/plugins-gemini@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-gemini",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-gemini",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-gemini@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.google",
    manifest: GOOGLE_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.voice.google",
    manifestDigest: "bundled:@happier-dev/plugins-google@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-google",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-google",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-google@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.grok",
    manifest: GROK_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.grok",
    manifestDigest: "bundled:@happier-dev/plugins-grok@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-grok",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-grok",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-grok@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.inspector",
    manifest: INSPECTOR_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.inspector",
    manifestDigest: "bundled:@happier-dev/plugins-inspector@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-inspector",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-inspector",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-inspector@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kilo",
    manifest: KILO_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.kilo",
    manifestDigest: "bundled:@happier-dev/plugins-kilo@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-kilo",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kilo",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-kilo@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kimi",
    manifest: KIMI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.kimi",
    manifestDigest: "bundled:@happier-dev/plugins-kimi@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-kimi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kimi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-kimi@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kiro",
    manifest: KIRO_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.kiro",
    manifestDigest: "bundled:@happier-dev/plugins-kiro@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-kiro",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kiro",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-kiro@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.lmstudio",
    manifest: LMSTUDIO_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.lmstudio",
    manifestDigest: "bundled:@happier-dev/plugins-lmstudio@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-lmstudio",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-lmstudio@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.ohmypi",
    manifest: OHMYPI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.ohmypi",
    manifestDigest: "bundled:@happier-dev/plugins-ohmypi@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-ohmypi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ohmypi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-ohmypi@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.ollama",
    manifest: OLLAMA_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.ollama",
    manifestDigest: "bundled:@happier-dev/plugins-ollama@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ollama",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-ollama@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.openai",
    manifest: OPENAI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.voice.openai",
    manifestDigest: "bundled:@happier-dev/plugins-openai@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-openai",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-openai@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openai",
    manifest: OPENAI_MODELS_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.openai",
    manifestDigest: "bundled:@happier-dev/plugins-openai-models@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai-models",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-openai-models@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.opencode",
    manifest: OPENCODE_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.opencode",
    manifestDigest: "bundled:@happier-dev/plugins-opencode@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-opencode",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-opencode",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-opencode@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openrouter",
    manifest: OPENROUTER_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.openrouter",
    manifestDigest: "bundled:@happier-dev/plugins-openrouter@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openrouter",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-openrouter@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.pi",
    manifest: PI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.pi",
    manifestDigest: "bundled:@happier-dev/plugins-pi@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-pi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-pi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-pi@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.qwen",
    manifest: QWEN_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.agent.qwen",
    manifestDigest: "bundled:@happier-dev/plugins-qwen@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-qwen",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-qwen",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-qwen@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.coderabbit",
    manifest: REVIEW_CODERABBIT_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.review.coderabbit",
    manifestDigest: "sha256:23914961d24555ee8e9c2c3f0ea0d6c76775b4fb78c2406a61d17f2b3e699270",
    daemonEntryPath: "@happier-dev/plugins-review-coderabbit",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-coderabbit",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "sha256:cbdc0fb6530598e301a21a1c54045a9e1d849a1ec7a5bcb74e525866270ff0f5",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.deepsec",
    manifest: REVIEW_DEEPSEC_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.review.deepsec",
    manifestDigest: "sha256:376850bb9f07407225e4b69d4545398113d3c66e62b09926cc4d157ea355c2e7",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-deepsec",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "sha256:c58c2c488fa3febfa08505e999a2b0112ed9c6e12b8601fc455aad8cf706af58",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.hosting.azure-devops",
    manifest: SCM_AZURE_DEVOPS_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.hosting.azure-devops",
    manifestDigest: "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-azure-devops",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-azure-devops",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-azure-devops@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.hosting.bitbucket",
    manifest: SCM_BITBUCKET_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.hosting.bitbucket",
    manifestDigest: "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-bitbucket",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-bitbucket",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-bitbucket@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.git",
    manifest: SCM_GIT_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.backend.git",
    manifestDigest: "bundled:@happier-dev/plugins-scm-git@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-git",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-git",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-git@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.hosting.github",
    manifest: SCM_GITHUB_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.hosting.github",
    manifestDigest: "bundled:@happier-dev/plugins-scm-github@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-github",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-github",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-github@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.hosting.gitlab",
    manifest: SCM_GITLAB_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.hosting.gitlab",
    manifestDigest: "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-gitlab",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-gitlab",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-gitlab@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.sapling",
    manifest: SCM_SAPLING_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.scm.backend.sapling",
    manifestDigest: "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
    daemonEntryPath: "@happier-dev/plugins-scm-sapling",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-sapling",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-scm-sapling@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.xai",
    manifest: XAI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.voice.xai",
    manifestDigest: "bundled:@happier-dev/plugins-xai@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-xai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-xai@0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.zai",
    manifest: ZAI_PLUGIN_MANIFEST,
    manifestPath: "bundled:happier.provider.zai",
    manifestDigest: "bundled:@happier-dev/plugins-zai@0.0.0",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-zai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
      resolvedDigest: "bundled:@happier-dev/plugins-zai@0.0.0",
    }),
  }),
]);

export const BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS: readonly BundledFirstPartyImplementationBinding[] = Object.freeze([
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.antigravity",
      localId: "antigravity",
    }),
    implementationOwnerId: "antigravity",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'antigravity',
      packageName: '@happier-dev/plugins-antigravity',
      contribution: ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: ANTIGRAVITY_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.auggie",
      localId: "auggie",
    }),
    implementationOwnerId: "auggie",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'auggie',
      packageName: '@happier-dev/plugins-auggie',
      contribution: AUGGIE_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: AUGGIE_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.claude",
      localId: "claude",
    }),
    implementationOwnerId: "claude",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'claude',
      packageName: '@happier-dev/plugins-claude',
      contribution: CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: CLAUDE_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.codex",
      localId: "codex",
    }),
    implementationOwnerId: "codex",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'codex',
      packageName: '@happier-dev/plugins-codex',
      contribution: CODEX_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: CODEX_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.copilot",
      localId: "copilot",
    }),
    implementationOwnerId: "copilot",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'copilot',
      packageName: '@happier-dev/plugins-copilot',
      contribution: COPILOT_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: COPILOT_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.cursor",
      localId: "cursor",
    }),
    implementationOwnerId: "cursor",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'cursor',
      packageName: '@happier-dev/plugins-cursor',
      contribution: CURSOR_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: CURSOR_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.gemini",
      localId: "gemini",
    }),
    implementationOwnerId: "gemini",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'gemini',
      packageName: '@happier-dev/plugins-gemini',
      contribution: GEMINI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: GEMINI_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.grok",
      localId: "grok",
    }),
    implementationOwnerId: "grok",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'grok',
      packageName: '@happier-dev/plugins-grok',
      contribution: GROK_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: GROK_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.kilo",
      localId: "kilo",
    }),
    implementationOwnerId: "kilo",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'kilo',
      packageName: '@happier-dev/plugins-kilo',
      contribution: KILO_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: KILO_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.kimi",
      localId: "kimi",
    }),
    implementationOwnerId: "kimi",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'kimi',
      packageName: '@happier-dev/plugins-kimi',
      contribution: KIMI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: KIMI_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.kiro",
      localId: "kiro",
    }),
    implementationOwnerId: "kiro",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'kiro',
      packageName: '@happier-dev/plugins-kiro',
      contribution: KIRO_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: KIRO_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.ohmypi",
      localId: "ohmypi",
    }),
    implementationOwnerId: "ohMyPi",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'ohMyPi',
      packageName: '@happier-dev/plugins-ohmypi',
      contribution: OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: OHMYPI_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.opencode",
      localId: "opencode",
    }),
    implementationOwnerId: "opencode",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'opencode',
      packageName: '@happier-dev/plugins-opencode',
      contribution: OPENCODE_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: OPENCODE_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.agent.pi",
      localId: "pi",
    }),
    implementationOwnerId: "pi",
    registrationFamily: 'agents',
    implementation: createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: PI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools: PI_PLUGIN_MANIFEST.contributes.systemTools,
    }),
  }),
  Object.freeze({
    identity: createPluginContributionIdentity({
      pluginId: "happier.provider.cliproxyapi",
      localId: "cliproxyapi",
    }),
    implementationOwnerId: "happier.provider.cliproxyapi/cliproxyapi",
    registrationFamily: 'providers',
    implementation: Object.freeze({
  "connectedAccounts": [
    {
      "materializationKinds": [
        "httpHeaders"
      ],
      "purpose": "openai-upstream",
      "required": false,
      "service": {
        "localId": "openai-codex",
        "pluginId": "happier.agent.codex"
      }
    },
    {
      "materializationKinds": [
        "httpHeaders"
      ],
      "purpose": "anthropic-upstream",
      "required": false,
      "service": {
        "localId": "claude-subscription",
        "pluginId": "happier.agent.claude"
      }
    }
  ],
  "managedEndpoint": {
    "localService": {
      "cleanup": {
        "staleAfterMs": 60000
      },
      "healthCheck": {
        "kind": "http",
        "path": "/healthz"
      },
      "hostPolicy": {
        "host": "127.0.0.1",
        "kind": "loopback"
      },
      "id": "cliproxyapi-managed",
      "launch": {
        "directorySegments": [
          "tools",
          "unpacked"
        ],
        "executableBaseName": "happier-cliproxyapi-managed",
        "kind": "packaged-runtime-binary",
        "privateConfigPathFlag": "--config"
      },
      "launchMode": {
        "environment": {
          "inject": [
            "PORT",
            "HOST"
          ]
        },
        "kind": "assignAndInject",
        "portPolicy": {
          "kind": "allocated"
        }
      },
      "name": {
        "name": "CLIProxyAPI managed gateway",
        "strategy": "fixed"
      },
      "restart": {
        "kind": "never"
      }
    },
    "protocols": [
      "openai-chat",
      "openai-responses",
      "anthropic"
    ]
  },
  "requestAuthUses": [
    {
      "materialization": {
        "headerNames": [
          "authorization",
          "chatgpt-account-id"
        ],
        "kind": "httpHeaders",
        "origin": "https://chatgpt.com"
      },
      "purpose": "openai-upstream"
    },
    {
      "materialization": {
        "headerNames": [
          "authorization"
        ],
        "kind": "httpHeaders",
        "origin": "https://api.anthropic.com"
      },
      "purpose": "anthropic-upstream"
    }
  ]
}),
    runtimeAdapter: CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER,
  }),
]);
