/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (WS1.T3)
 *
 * Data-only locator and provenance records.
 * Contribution declarations are ingested from generator-normalized manifest
 * data by the same canonical path used for installed plugins.
 */

import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';

export type BundledFirstPartyPluginMetadata = Readonly<{
  agentId?: string;
  pluginId: string;
  pluginPackageId: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
}>;

export type BundledFirstPartyPluginLocator = Readonly<{
  pluginId: string;
  manifestRelativePath: string;
  manifestPath: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath?: string | null;
  sourceSpec: PluginSourceSpecV1;
}>;

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-antigravity",
  "@happier-dev/plugins-app-context",
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-channel-discord",
  "@happier-dev/plugins-channel-email",
  "@happier-dev/plugins-channel-slack",
  "@happier-dev/plugins-channel-telegram",
  "@happier-dev/plugins-channels",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-codebuddy",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-custom-acp",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-devin",
  "@happier-dev/plugins-droid",
  "@happier-dev/plugins-elevenlabs",
  "@happier-dev/plugins-fx",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-google",
  "@happier-dev/plugins-grok",
  "@happier-dev/plugins-inspector",
  "@happier-dev/plugins-jira",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-kiro",
  "@happier-dev/plugins-lang-typescript",
  "@happier-dev/plugins-linear",
  "@happier-dev/plugins-lmstudio",
  "@happier-dev/plugins-machine-boat",
  "@happier-dev/plugins-machine-crabbox",
  "@happier-dev/plugins-machine-cua",
  "@happier-dev/plugins-machine-digitalocean",
  "@happier-dev/plugins-machine-docker-sandboxes",
  "@happier-dev/plugins-machine-fly",
  "@happier-dev/plugins-machine-hetzner",
  "@happier-dev/plugins-machine-lima",
  "@happier-dev/plugins-machine-lume",
  "@happier-dev/plugins-machine-modal",
  "@happier-dev/plugins-machine-services",
  "@happier-dev/plugins-minimax",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-ollama",
  "@happier-dev/plugins-openai",
  "@happier-dev/plugins-openai-compat",
  "@happier-dev/plugins-openai-models",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-openrouter",
  "@happier-dev/plugins-pi",
  "@happier-dev/plugins-posthog",
  "@happier-dev/plugins-qwen",
  "@happier-dev/plugins-review-coderabbit",
  "@happier-dev/plugins-review-deepsec",
  "@happier-dev/plugins-scm-azure-devops",
  "@happier-dev/plugins-scm-bitbucket",
  "@happier-dev/plugins-scm-git",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
  "@happier-dev/plugins-scm-sapling",
  "@happier-dev/plugins-sentry",
  "@happier-dev/plugins-triage",
  "@happier-dev/plugins-xai",
  "@happier-dev/plugins-zai",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "antigravity",
    "manifestPath": "bundled:happier.agent.antigravity",
    "packageName": "@happier-dev/plugins-antigravity",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.antigravity",
    "pluginPackageId": "antigravity"
  },
  {
    "manifestPath": "bundled:happier.app-context",
    "packageName": "@happier-dev/plugins-app-context",
    "packageVersion": "0.0.0",
    "pluginId": "happier.app-context",
    "pluginPackageId": "app-context"
  },
  {
    "agentId": "auggie",
    "manifestPath": "bundled:happier.agent.auggie",
    "packageName": "@happier-dev/plugins-auggie",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.auggie",
    "pluginPackageId": "auggie"
  },
  {
    "manifestPath": "bundled:happier.channel.discord",
    "packageName": "@happier-dev/plugins-channel-discord",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.discord",
    "pluginPackageId": "channel-discord"
  },
  {
    "manifestPath": "bundled:happier.channel.email",
    "packageName": "@happier-dev/plugins-channel-email",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.email",
    "pluginPackageId": "channel-email"
  },
  {
    "manifestPath": "bundled:happier.channel.slack",
    "packageName": "@happier-dev/plugins-channel-slack",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.slack",
    "pluginPackageId": "channel-slack"
  },
  {
    "manifestPath": "bundled:happier.channel.telegram",
    "packageName": "@happier-dev/plugins-channel-telegram",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.telegram",
    "pluginPackageId": "channel-telegram"
  },
  {
    "manifestPath": "bundled:happier.channels",
    "packageName": "@happier-dev/plugins-channels",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channels",
    "pluginPackageId": "channels"
  },
  {
    "agentId": "claude",
    "manifestPath": "bundled:happier.agent.claude",
    "packageName": "@happier-dev/plugins-claude",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.claude",
    "pluginPackageId": "claude"
  },
  {
    "manifestPath": "bundled:happier.provider.cliproxyapi",
    "packageName": "@happier-dev/plugins-cliproxyapi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.cliproxyapi",
    "pluginPackageId": "cliproxyapi"
  },
  {
    "agentId": "codebuddy",
    "manifestPath": "bundled:happier.agent.codebuddy",
    "packageName": "@happier-dev/plugins-codebuddy",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.codebuddy",
    "pluginPackageId": "codebuddy"
  },
  {
    "agentId": "codex",
    "manifestPath": "bundled:happier.agent.codex",
    "packageName": "@happier-dev/plugins-codex",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.codex",
    "pluginPackageId": "codex"
  },
  {
    "agentId": "copilot",
    "manifestPath": "bundled:happier.agent.copilot",
    "packageName": "@happier-dev/plugins-copilot",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.copilot",
    "pluginPackageId": "copilot"
  },
  {
    "agentId": "cursor",
    "manifestPath": "bundled:happier.agent.cursor",
    "packageName": "@happier-dev/plugins-cursor",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.cursor",
    "pluginPackageId": "cursor"
  },
  {
    "agentId": "custom-acp",
    "manifestPath": "bundled:happier.agent.custom-acp",
    "packageName": "@happier-dev/plugins-custom-acp",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.custom-acp",
    "pluginPackageId": "custom-acp"
  },
  {
    "manifestPath": "bundled:happier.provider.deepseek",
    "packageName": "@happier-dev/plugins-deepseek",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.deepseek",
    "pluginPackageId": "deepseek"
  },
  {
    "agentId": "devin",
    "manifestPath": "bundled:happier.agent.devin",
    "packageName": "@happier-dev/plugins-devin",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.devin",
    "pluginPackageId": "devin"
  },
  {
    "agentId": "droid",
    "manifestPath": "bundled:happier.agent.droid",
    "packageName": "@happier-dev/plugins-droid",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.droid",
    "pluginPackageId": "droid"
  },
  {
    "manifestPath": "bundled:happier.voice.elevenlabs",
    "packageName": "@happier-dev/plugins-elevenlabs",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.elevenlabs",
    "pluginPackageId": "elevenlabs"
  },
  {
    "agentId": "fx",
    "manifestPath": "bundled:happier.agent.fx",
    "packageName": "@happier-dev/plugins-fx",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.fx",
    "pluginPackageId": "fx"
  },
  {
    "agentId": "gemini",
    "manifestPath": "bundled:happier.agent.gemini",
    "packageName": "@happier-dev/plugins-gemini",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.gemini",
    "pluginPackageId": "gemini"
  },
  {
    "manifestPath": "bundled:happier.voice.google",
    "packageName": "@happier-dev/plugins-google",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.google",
    "pluginPackageId": "google"
  },
  {
    "agentId": "grok",
    "manifestPath": "bundled:happier.agent.grok",
    "packageName": "@happier-dev/plugins-grok",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.grok",
    "pluginPackageId": "grok"
  },
  {
    "manifestPath": "bundled:happier.inspector",
    "packageName": "@happier-dev/plugins-inspector",
    "packageVersion": "0.0.0",
    "pluginId": "happier.inspector",
    "pluginPackageId": "inspector"
  },
  {
    "manifestPath": "bundled:happier.jira",
    "packageName": "@happier-dev/plugins-jira",
    "packageVersion": "0.0.0",
    "pluginId": "happier.jira",
    "pluginPackageId": "jira"
  },
  {
    "agentId": "kilo",
    "manifestPath": "bundled:happier.agent.kilo",
    "packageName": "@happier-dev/plugins-kilo",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kilo",
    "pluginPackageId": "kilo"
  },
  {
    "agentId": "kimi",
    "manifestPath": "bundled:happier.agent.kimi",
    "packageName": "@happier-dev/plugins-kimi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kimi",
    "pluginPackageId": "kimi"
  },
  {
    "agentId": "kiro",
    "manifestPath": "bundled:happier.agent.kiro",
    "packageName": "@happier-dev/plugins-kiro",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kiro",
    "pluginPackageId": "kiro"
  },
  {
    "manifestPath": "bundled:happier.language.typescript",
    "packageName": "@happier-dev/plugins-lang-typescript",
    "packageVersion": "0.0.0",
    "pluginId": "happier.language.typescript",
    "pluginPackageId": "lang-typescript"
  },
  {
    "manifestPath": "bundled:happier.linear",
    "packageName": "@happier-dev/plugins-linear",
    "packageVersion": "0.0.0",
    "pluginId": "happier.linear",
    "pluginPackageId": "linear"
  },
  {
    "manifestPath": "bundled:happier.provider.lmstudio",
    "packageName": "@happier-dev/plugins-lmstudio",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.lmstudio",
    "pluginPackageId": "lmstudio"
  },
  {
    "manifestPath": "bundled:happier.machine.boat",
    "packageName": "@happier-dev/plugins-machine-boat",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.boat",
    "pluginPackageId": "machine-boat"
  },
  {
    "manifestPath": "bundled:happier.machine.crabbox",
    "packageName": "@happier-dev/plugins-machine-crabbox",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.crabbox",
    "pluginPackageId": "machine-crabbox"
  },
  {
    "manifestPath": "bundled:happier.machine.cua",
    "packageName": "@happier-dev/plugins-machine-cua",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.cua",
    "pluginPackageId": "machine-cua"
  },
  {
    "manifestPath": "bundled:happier.machine.digitalocean",
    "packageName": "@happier-dev/plugins-machine-digitalocean",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.digitalocean",
    "pluginPackageId": "machine-digitalocean"
  },
  {
    "manifestPath": "bundled:happier.machine.docker-sandboxes",
    "packageName": "@happier-dev/plugins-machine-docker-sandboxes",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.docker-sandboxes",
    "pluginPackageId": "machine-docker-sandboxes"
  },
  {
    "manifestPath": "bundled:happier.machine.fly",
    "packageName": "@happier-dev/plugins-machine-fly",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.fly",
    "pluginPackageId": "machine-fly"
  },
  {
    "manifestPath": "bundled:happier.machine.hetzner",
    "packageName": "@happier-dev/plugins-machine-hetzner",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.hetzner",
    "pluginPackageId": "machine-hetzner"
  },
  {
    "manifestPath": "bundled:happier.machine.lima",
    "packageName": "@happier-dev/plugins-machine-lima",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.lima",
    "pluginPackageId": "machine-lima"
  },
  {
    "manifestPath": "bundled:happier.machine.lume",
    "packageName": "@happier-dev/plugins-machine-lume",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.lume",
    "pluginPackageId": "machine-lume"
  },
  {
    "manifestPath": "bundled:happier.machine.modal",
    "packageName": "@happier-dev/plugins-machine-modal",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.modal",
    "pluginPackageId": "machine-modal"
  },
  {
    "manifestPath": "bundled:happier.machine.services",
    "packageName": "@happier-dev/plugins-machine-services",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.services",
    "pluginPackageId": "machine-services"
  },
  {
    "manifestPath": "bundled:happier.provider.minimax",
    "packageName": "@happier-dev/plugins-minimax",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.minimax",
    "pluginPackageId": "minimax"
  },
  {
    "agentId": "ohmypi",
    "manifestPath": "bundled:happier.agent.ohmypi",
    "packageName": "@happier-dev/plugins-ohmypi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.ohmypi",
    "pluginPackageId": "ohmypi"
  },
  {
    "manifestPath": "bundled:happier.provider.ollama",
    "packageName": "@happier-dev/plugins-ollama",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.ollama",
    "pluginPackageId": "ollama"
  },
  {
    "manifestPath": "bundled:happier.voice.openai",
    "packageName": "@happier-dev/plugins-openai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.openai",
    "pluginPackageId": "openai"
  },
  {
    "manifestPath": "bundled:happier.voice.openai-compat",
    "packageName": "@happier-dev/plugins-openai-compat",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.openai-compat",
    "pluginPackageId": "openai-compat"
  },
  {
    "manifestPath": "bundled:happier.provider.openai",
    "packageName": "@happier-dev/plugins-openai-models",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openai",
    "pluginPackageId": "openai-models"
  },
  {
    "agentId": "opencode",
    "manifestPath": "bundled:happier.agent.opencode",
    "packageName": "@happier-dev/plugins-opencode",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.opencode",
    "pluginPackageId": "opencode"
  },
  {
    "manifestPath": "bundled:happier.provider.openrouter",
    "packageName": "@happier-dev/plugins-openrouter",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openrouter",
    "pluginPackageId": "openrouter"
  },
  {
    "agentId": "pi",
    "manifestPath": "bundled:happier.agent.pi",
    "packageName": "@happier-dev/plugins-pi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.pi",
    "pluginPackageId": "pi"
  },
  {
    "manifestPath": "bundled:happier.posthog",
    "packageName": "@happier-dev/plugins-posthog",
    "packageVersion": "0.0.0",
    "pluginId": "happier.posthog",
    "pluginPackageId": "posthog"
  },
  {
    "agentId": "qwen",
    "manifestPath": "bundled:happier.agent.qwen",
    "packageName": "@happier-dev/plugins-qwen",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.qwen",
    "pluginPackageId": "qwen"
  },
  {
    "agentId": "coderabbit",
    "manifestPath": "bundled:happier.review.coderabbit",
    "packageName": "@happier-dev/plugins-review-coderabbit",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.coderabbit",
    "pluginPackageId": "review-coderabbit"
  },
  {
    "agentId": "deepsec",
    "manifestPath": "bundled:happier.review.deepsec",
    "packageName": "@happier-dev/plugins-review-deepsec",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.deepsec",
    "pluginPackageId": "review-deepsec"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.azure-devops",
    "packageName": "@happier-dev/plugins-scm-azure-devops",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.azure-devops",
    "pluginPackageId": "scm-azure-devops"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.bitbucket",
    "packageName": "@happier-dev/plugins-scm-bitbucket",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.bitbucket",
    "pluginPackageId": "scm-bitbucket"
  },
  {
    "manifestPath": "bundled:happier.scm.backend.git",
    "packageName": "@happier-dev/plugins-scm-git",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.git",
    "pluginPackageId": "scm-git"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.github",
    "packageName": "@happier-dev/plugins-scm-github",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.github",
    "pluginPackageId": "scm-github"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.gitlab",
    "packageName": "@happier-dev/plugins-scm-gitlab",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.gitlab",
    "pluginPackageId": "scm-gitlab"
  },
  {
    "manifestPath": "bundled:happier.scm.backend.sapling",
    "packageName": "@happier-dev/plugins-scm-sapling",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.sapling",
    "pluginPackageId": "scm-sapling"
  },
  {
    "manifestPath": "bundled:happier.sentry",
    "packageName": "@happier-dev/plugins-sentry",
    "packageVersion": "0.0.0",
    "pluginId": "happier.sentry",
    "pluginPackageId": "sentry"
  },
  {
    "manifestPath": "bundled:happier.triage",
    "packageName": "@happier-dev/plugins-triage",
    "packageVersion": "0.0.0",
    "pluginId": "happier.triage",
    "pluginPackageId": "triage"
  },
  {
    "manifestPath": "bundled:happier.voice.xai",
    "packageName": "@happier-dev/plugins-xai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.xai",
    "pluginPackageId": "xai"
  },
  {
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
    manifestRelativePath: "assets/bundled-plugin-manifests/antigravity.json",
    manifestPath: "bundled:happier.agent.antigravity",
    daemonEntryPath: "@happier-dev/plugins-antigravity",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-antigravity",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.app-context",
    manifestRelativePath: "assets/bundled-plugin-manifests/app-context.json",
    manifestPath: "bundled:happier.app-context",
    daemonEntryPath: "@happier-dev/plugins-app-context",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-app-context",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.auggie",
    manifestRelativePath: "assets/bundled-plugin-manifests/auggie.json",
    manifestPath: "bundled:happier.agent.auggie",
    daemonEntryPath: "@happier-dev/plugins-auggie",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-auggie",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.discord",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-discord.json",
    manifestPath: "bundled:happier.channel.discord",
    daemonEntryPath: "@happier-dev/plugins-channel-discord",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-discord",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.email",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-email.json",
    manifestPath: "bundled:happier.channel.email",
    daemonEntryPath: "@happier-dev/plugins-channel-email",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-email",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.slack",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-slack.json",
    manifestPath: "bundled:happier.channel.slack",
    daemonEntryPath: "@happier-dev/plugins-channel-slack",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-slack",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.telegram",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-telegram.json",
    manifestPath: "bundled:happier.channel.telegram",
    daemonEntryPath: "@happier-dev/plugins-channel-telegram",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-telegram",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channels",
    manifestRelativePath: "assets/bundled-plugin-manifests/channels.json",
    manifestPath: "bundled:happier.channels",
    daemonEntryPath: "@happier-dev/plugins-channels",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channels",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.claude",
    manifestRelativePath: "assets/bundled-plugin-manifests/claude.json",
    manifestPath: "bundled:happier.agent.claude",
    daemonEntryPath: "@happier-dev/plugins-claude",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-claude",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.services",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-services.json",
    manifestPath: "bundled:happier.machine.services",
    daemonEntryPath: "@happier-dev/plugins-machine-services",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-services",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.cliproxyapi",
    manifestRelativePath: "assets/bundled-plugin-manifests/cliproxyapi.json",
    manifestPath: "bundled:happier.provider.cliproxyapi",
    daemonEntryPath: "@happier-dev/plugins-cliproxyapi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cliproxyapi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.codebuddy",
    manifestRelativePath: "assets/bundled-plugin-manifests/codebuddy.json",
    manifestPath: "bundled:happier.agent.codebuddy",
    daemonEntryPath: "@happier-dev/plugins-codebuddy",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-codebuddy",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.codex",
    manifestRelativePath: "assets/bundled-plugin-manifests/codex.json",
    manifestPath: "bundled:happier.agent.codex",
    daemonEntryPath: "@happier-dev/plugins-codex",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-codex",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.copilot",
    manifestRelativePath: "assets/bundled-plugin-manifests/copilot.json",
    manifestPath: "bundled:happier.agent.copilot",
    daemonEntryPath: "@happier-dev/plugins-copilot",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-copilot",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.cursor",
    manifestRelativePath: "assets/bundled-plugin-manifests/cursor.json",
    manifestPath: "bundled:happier.agent.cursor",
    daemonEntryPath: "@happier-dev/plugins-cursor",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cursor",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.custom-acp",
    manifestRelativePath: "assets/bundled-plugin-manifests/custom-acp.json",
    manifestPath: "bundled:happier.agent.custom-acp",
    daemonEntryPath: "@happier-dev/plugins-custom-acp",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-custom-acp",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.deepseek",
    manifestRelativePath: "assets/bundled-plugin-manifests/deepseek.json",
    manifestPath: "bundled:happier.provider.deepseek",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-deepseek",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.devin",
    manifestRelativePath: "assets/bundled-plugin-manifests/devin.json",
    manifestPath: "bundled:happier.agent.devin",
    daemonEntryPath: "@happier-dev/plugins-devin",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-devin",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.droid",
    manifestRelativePath: "assets/bundled-plugin-manifests/droid.json",
    manifestPath: "bundled:happier.agent.droid",
    daemonEntryPath: "@happier-dev/plugins-droid",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-droid",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.elevenlabs",
    manifestRelativePath: "assets/bundled-plugin-manifests/elevenlabs.json",
    manifestPath: "bundled:happier.voice.elevenlabs",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-elevenlabs",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.fx",
    manifestRelativePath: "assets/bundled-plugin-manifests/fx.json",
    manifestPath: "bundled:happier.agent.fx",
    daemonEntryPath: "@happier-dev/plugins-fx",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-fx",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.gemini",
    manifestRelativePath: "assets/bundled-plugin-manifests/gemini.json",
    manifestPath: "bundled:happier.agent.gemini",
    daemonEntryPath: "@happier-dev/plugins-gemini",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-gemini",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.google",
    manifestRelativePath: "assets/bundled-plugin-manifests/google.json",
    manifestPath: "bundled:happier.voice.google",
    daemonEntryPath: "@happier-dev/plugins-google",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-google",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.grok",
    manifestRelativePath: "assets/bundled-plugin-manifests/grok.json",
    manifestPath: "bundled:happier.agent.grok",
    daemonEntryPath: "@happier-dev/plugins-grok",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-grok",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.inspector",
    manifestRelativePath: "assets/bundled-plugin-manifests/inspector.json",
    manifestPath: "bundled:happier.inspector",
    daemonEntryPath: "@happier-dev/plugins-inspector",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-inspector",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.jira",
    manifestRelativePath: "assets/bundled-plugin-manifests/jira.json",
    manifestPath: "bundled:happier.jira",
    daemonEntryPath: "@happier-dev/plugins-jira",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-jira",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kilo",
    manifestRelativePath: "assets/bundled-plugin-manifests/kilo.json",
    manifestPath: "bundled:happier.agent.kilo",
    daemonEntryPath: "@happier-dev/plugins-kilo",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kilo",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kimi",
    manifestRelativePath: "assets/bundled-plugin-manifests/kimi.json",
    manifestPath: "bundled:happier.agent.kimi",
    daemonEntryPath: "@happier-dev/plugins-kimi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kimi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kiro",
    manifestRelativePath: "assets/bundled-plugin-manifests/kiro.json",
    manifestPath: "bundled:happier.agent.kiro",
    daemonEntryPath: "@happier-dev/plugins-kiro",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kiro",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.language.typescript",
    manifestRelativePath: "assets/bundled-plugin-manifests/lang-typescript.json",
    manifestPath: "bundled:happier.language.typescript",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-lang-typescript",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.linear",
    manifestRelativePath: "assets/bundled-plugin-manifests/linear.json",
    manifestPath: "bundled:happier.linear",
    daemonEntryPath: "@happier-dev/plugins-linear",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-linear",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.lmstudio",
    manifestRelativePath: "assets/bundled-plugin-manifests/lmstudio.json",
    manifestPath: "bundled:happier.provider.lmstudio",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-lmstudio",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.boat",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-boat.json",
    manifestPath: "bundled:happier.machine.boat",
    daemonEntryPath: "@happier-dev/plugins-machine-boat",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-boat",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.crabbox",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-crabbox.json",
    manifestPath: "bundled:happier.machine.crabbox",
    daemonEntryPath: "@happier-dev/plugins-machine-crabbox",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-crabbox",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.cua",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-cua.json",
    manifestPath: "bundled:happier.machine.cua",
    daemonEntryPath: "@happier-dev/plugins-machine-cua",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-cua",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.digitalocean",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-digitalocean.json",
    manifestPath: "bundled:happier.machine.digitalocean",
    daemonEntryPath: "@happier-dev/plugins-machine-digitalocean",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-digitalocean",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.docker-sandboxes",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-docker-sandboxes.json",
    manifestPath: "bundled:happier.machine.docker-sandboxes",
    daemonEntryPath: "@happier-dev/plugins-machine-docker-sandboxes",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-docker-sandboxes",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.fly",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-fly.json",
    manifestPath: "bundled:happier.machine.fly",
    daemonEntryPath: "@happier-dev/plugins-machine-fly",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-fly",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.hetzner",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-hetzner.json",
    manifestPath: "bundled:happier.machine.hetzner",
    daemonEntryPath: "@happier-dev/plugins-machine-hetzner",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-hetzner",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.lima",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-lima.json",
    manifestPath: "bundled:happier.machine.lima",
    daemonEntryPath: "@happier-dev/plugins-machine-lima",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-lima",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.lume",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-lume.json",
    manifestPath: "bundled:happier.machine.lume",
    daemonEntryPath: "@happier-dev/plugins-machine-lume",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-lume",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.modal",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-modal.json",
    manifestPath: "bundled:happier.machine.modal",
    daemonEntryPath: "@happier-dev/plugins-machine-modal",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-modal",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.minimax",
    manifestRelativePath: "assets/bundled-plugin-manifests/minimax.json",
    manifestPath: "bundled:happier.provider.minimax",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-minimax",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.ohmypi",
    manifestRelativePath: "assets/bundled-plugin-manifests/ohmypi.json",
    manifestPath: "bundled:happier.agent.ohmypi",
    daemonEntryPath: "@happier-dev/plugins-ohmypi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ohmypi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.ollama",
    manifestRelativePath: "assets/bundled-plugin-manifests/ollama.json",
    manifestPath: "bundled:happier.provider.ollama",
    daemonEntryPath: "@happier-dev/plugins-ollama",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ollama",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.openai",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai.json",
    manifestPath: "bundled:happier.voice.openai",
    daemonEntryPath: "@happier-dev/plugins-openai",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.openai-compat",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai-compat.json",
    manifestPath: "bundled:happier.voice.openai-compat",
    daemonEntryPath: "@happier-dev/plugins-openai-compat",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai-compat",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openai",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai-models.json",
    manifestPath: "bundled:happier.provider.openai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai-models",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.opencode",
    manifestRelativePath: "assets/bundled-plugin-manifests/opencode.json",
    manifestPath: "bundled:happier.agent.opencode",
    daemonEntryPath: "@happier-dev/plugins-opencode",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-opencode",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openrouter",
    manifestRelativePath: "assets/bundled-plugin-manifests/openrouter.json",
    manifestPath: "bundled:happier.provider.openrouter",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openrouter",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.pi",
    manifestRelativePath: "assets/bundled-plugin-manifests/pi.json",
    manifestPath: "bundled:happier.agent.pi",
    daemonEntryPath: "@happier-dev/plugins-pi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-pi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.posthog",
    manifestRelativePath: "assets/bundled-plugin-manifests/posthog.json",
    manifestPath: "bundled:happier.posthog",
    daemonEntryPath: "@happier-dev/plugins-posthog",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-posthog",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.qwen",
    manifestRelativePath: "assets/bundled-plugin-manifests/qwen.json",
    manifestPath: "bundled:happier.agent.qwen",
    daemonEntryPath: "@happier-dev/plugins-qwen",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-qwen",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.coderabbit",
    manifestRelativePath: "assets/bundled-plugin-manifests/review-coderabbit.json",
    manifestPath: "bundled:happier.review.coderabbit",
    daemonEntryPath: "@happier-dev/plugins-review-coderabbit",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-coderabbit",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.deepsec",
    manifestRelativePath: "assets/bundled-plugin-manifests/review-deepsec.json",
    manifestPath: "bundled:happier.review.deepsec",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-deepsec",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.azure-devops",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-azure-devops.json",
    manifestPath: "bundled:happier.scm.forge.azure-devops",
    daemonEntryPath: "@happier-dev/plugins-scm-azure-devops",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-azure-devops",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.bitbucket",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-bitbucket.json",
    manifestPath: "bundled:happier.scm.forge.bitbucket",
    daemonEntryPath: "@happier-dev/plugins-scm-bitbucket",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-bitbucket",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.git",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-git.json",
    manifestPath: "bundled:happier.scm.backend.git",
    daemonEntryPath: "@happier-dev/plugins-scm-git",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-git",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.github",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-github.json",
    manifestPath: "bundled:happier.scm.forge.github",
    daemonEntryPath: "@happier-dev/plugins-scm-github",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-github",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.gitlab",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-gitlab.json",
    manifestPath: "bundled:happier.scm.forge.gitlab",
    daemonEntryPath: "@happier-dev/plugins-scm-gitlab",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-gitlab",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.sapling",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-sapling.json",
    manifestPath: "bundled:happier.scm.backend.sapling",
    daemonEntryPath: "@happier-dev/plugins-scm-sapling",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-sapling",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.sentry",
    manifestRelativePath: "assets/bundled-plugin-manifests/sentry.json",
    manifestPath: "bundled:happier.sentry",
    daemonEntryPath: "@happier-dev/plugins-sentry",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-sentry",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.triage",
    manifestRelativePath: "assets/bundled-plugin-manifests/triage.json",
    manifestPath: "bundled:happier.triage",
    daemonEntryPath: "@happier-dev/plugins-triage",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-triage",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.xai",
    manifestRelativePath: "assets/bundled-plugin-manifests/xai.json",
    manifestPath: "bundled:happier.voice.xai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-xai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.zai",
    manifestRelativePath: "assets/bundled-plugin-manifests/zai.json",
    manifestPath: "bundled:happier.provider.zai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-zai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
]);


/** Narrow build-time projection; executable and schema graphs remain demand-loaded. */
import type { BundledPluginCommandMetadata } from '../../../../cli/commandDescriptors';
export const BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA: readonly BundledPluginCommandMetadata[] = Object.freeze(
[{"pluginId":"happier.agent.antigravity","agents":[{"id":"antigravity","cliSubcommand":"antigravity","title":"Antigravity CLI"}],"commands":[]},{"pluginId":"happier.app-context","agents":[],"commands":[]},{"pluginId":"happier.agent.auggie","agents":[{"id":"auggie","cliSubcommand":"auggie","title":"Auggie CLI"}],"commands":[]},{"pluginId":"happier.channel.discord","agents":[],"commands":[]},{"pluginId":"happier.channel.email","agents":[],"commands":[]},{"pluginId":"happier.channel.slack","agents":[],"commands":[]},{"pluginId":"happier.channel.telegram","agents":[],"commands":[]},{"pluginId":"happier.channels","agents":[],"commands":[]},{"pluginId":"happier.agent.claude","agents":[{"id":"claude","cliSubcommand":"claude","title":"Claude Code CLI"}],"commands":[]},{"pluginId":"happier.provider.cliproxyapi","agents":[],"commands":[]},{"pluginId":"happier.agent.codebuddy","agents":[{"id":"codebuddy","cliSubcommand":"codebuddy","title":"CodeBuddy Code CLI"}],"commands":[]},{"pluginId":"happier.agent.codex","agents":[{"id":"codex","cliSubcommand":"codex","title":"OpenAI Codex CLI"}],"commands":[]},{"pluginId":"happier.agent.copilot","agents":[{"id":"copilot","cliSubcommand":"copilot","title":"GitHub Copilot CLI"}],"commands":[]},{"pluginId":"happier.agent.cursor","agents":[{"id":"cursor","cliSubcommand":"cursor","title":"Cursor Agent CLI"}],"commands":[]},{"pluginId":"happier.agent.custom-acp","agents":[{"id":"custom-acp","cliSubcommand":"custom-acp","title":"custom-acp"}],"commands":[]},{"pluginId":"happier.provider.deepseek","agents":[],"commands":[]},{"pluginId":"happier.agent.devin","agents":[{"id":"devin","cliSubcommand":"devin","title":"Devin CLI"}],"commands":[]},{"pluginId":"happier.agent.droid","agents":[{"id":"droid","cliSubcommand":"droid","title":"Factory Droid CLI"}],"commands":[]},{"pluginId":"happier.voice.elevenlabs","agents":[],"commands":[]},{"pluginId":"happier.agent.fx","agents":[{"id":"fx","cliSubcommand":"fx","title":"FX CLI"}],"commands":[]},{"pluginId":"happier.agent.gemini","agents":[{"id":"gemini","cliSubcommand":"gemini","title":"Google Gemini CLI"}],"commands":[]},{"pluginId":"happier.voice.google","agents":[],"commands":[]},{"pluginId":"happier.agent.grok","agents":[{"id":"grok","cliSubcommand":"grok","title":"Grok"}],"commands":[]},{"pluginId":"happier.inspector","agents":[],"commands":[]},{"pluginId":"happier.jira","agents":[],"commands":[]},{"pluginId":"happier.agent.kilo","agents":[{"id":"kilo","cliSubcommand":"kilo","title":"Kilo CLI"}],"commands":[]},{"pluginId":"happier.agent.kimi","agents":[{"id":"kimi","cliSubcommand":"kimi","title":"Kimi Code CLI"}],"commands":[]},{"pluginId":"happier.agent.kiro","agents":[{"id":"kiro","cliSubcommand":"kiro","title":"Kiro CLI"}],"commands":[]},{"pluginId":"happier.language.typescript","agents":[],"commands":[]},{"pluginId":"happier.linear","agents":[],"commands":[]},{"pluginId":"happier.provider.lmstudio","agents":[],"commands":[]},{"pluginId":"happier.machine.boat","agents":[],"commands":[]},{"pluginId":"happier.machine.crabbox","agents":[],"commands":[]},{"pluginId":"happier.machine.cua","agents":[],"commands":[]},{"pluginId":"happier.machine.digitalocean","agents":[],"commands":[]},{"pluginId":"happier.machine.docker-sandboxes","agents":[],"commands":[]},{"pluginId":"happier.machine.fly","agents":[],"commands":[]},{"pluginId":"happier.machine.hetzner","agents":[],"commands":[]},{"pluginId":"happier.machine.lima","agents":[],"commands":[]},{"pluginId":"happier.machine.lume","agents":[],"commands":[]},{"pluginId":"happier.machine.modal","agents":[],"commands":[]},{"pluginId":"happier.provider.minimax","agents":[],"commands":[]},{"pluginId":"happier.agent.ohmypi","agents":[{"id":"ohMyPi","cliSubcommand":"ohmypi","title":"oh-my-pi CLI"}],"commands":[]},{"pluginId":"happier.provider.ollama","agents":[],"commands":[]},{"pluginId":"happier.voice.openai","agents":[],"commands":[]},{"pluginId":"happier.voice.openai-compat","agents":[],"commands":[]},{"pluginId":"happier.provider.openai","agents":[],"commands":[]},{"pluginId":"happier.agent.opencode","agents":[{"id":"opencode","cliSubcommand":"opencode","title":"OpenCode CLI"}],"commands":[]},{"pluginId":"happier.provider.openrouter","agents":[],"commands":[]},{"pluginId":"happier.agent.pi","agents":[{"id":"pi","cliSubcommand":"pi","title":"Pi Coding Agent CLI"}],"commands":[]},{"pluginId":"happier.posthog","agents":[],"commands":[]},{"pluginId":"happier.agent.qwen","agents":[{"id":"qwen","cliSubcommand":"qwen","title":"Qwen CLI"}],"commands":[]},{"pluginId":"happier.review.coderabbit","agents":[{"id":"coderabbit","cliSubcommand":"coderabbit","title":"CodeRabbit"}],"commands":[]},{"pluginId":"happier.review.deepsec","agents":[{"id":"deepsec","cliSubcommand":"deepsec","title":"DeepSec"}],"commands":[]},{"pluginId":"happier.scm.forge.azure-devops","agents":[],"commands":[]},{"pluginId":"happier.scm.forge.bitbucket","agents":[],"commands":[]},{"pluginId":"happier.scm.backend.git","agents":[],"commands":[]},{"pluginId":"happier.scm.forge.github","agents":[],"commands":[]},{"pluginId":"happier.scm.forge.gitlab","agents":[],"commands":[]},{"pluginId":"happier.scm.backend.sapling","agents":[],"commands":[]},{"pluginId":"happier.sentry","agents":[],"commands":[]},{"pluginId":"happier.triage","agents":[],"commands":[]},{"pluginId":"happier.voice.xai","agents":[],"commands":[]},{"pluginId":"happier.provider.zai","agents":[],"commands":[]}]);

import type { ActionCliCommandPathDeclaration } from '../../../../cli/actions/commandPatterns';
export const BUNDLED_ACTION_CLI_COMMAND_PATHS: readonly ActionCliCommandPathDeclaration[] = Object.freeze(
[{"actionId":"memory.decision.save","path":["memory","decision","save"],"visibility":"canonical","pattern":["memory","decision","save"]},{"actionId":"memory.remember","path":["memory","remember"],"visibility":"canonical","pattern":["memory","remember"]},{"actionId":"memory.update","path":["memory","update"],"visibility":"canonical","pattern":["memory","update"]},{"actionId":"memory.forget","path":["memory","forget"],"visibility":"canonical","pattern":["memory","forget"]},{"actionId":"memory.read","path":["memory","read"],"visibility":"canonical","pattern":["memory","read"]},{"actionId":"memory.list","path":["memory","list"],"visibility":"canonical","pattern":["memory","list"]},{"actionId":"doc.read","path":["doc","read"],"visibility":"canonical","pattern":["doc","read"]},{"actionId":"doc.comment.reply","path":["doc","comment","reply"],"visibility":"canonical","pattern":["doc","comment","reply"]},{"actionId":"doc.edit.propose","path":["doc","edit","propose"],"visibility":"canonical","pattern":["doc","edit","propose"]},{"actionId":"doc.edit.accept","path":["doc","edit","accept"],"visibility":"canonical","pattern":["doc","edit","accept"]},{"actionId":"doc.edit.decline","path":["doc","edit","decline"],"visibility":"canonical","pattern":["doc","edit","decline"]},{"actionId":"projects.trust.list","path":["project","trust","list"],"visibility":"canonical","pattern":["project","trust","list"]},{"actionId":"projects.trust.revoke","path":["project","trust","revoke"],"visibility":"canonical","pattern":["project","trust","revoke"]},{"actionId":"projects.prepare","path":["project","prepare"],"visibility":"canonical","pattern":["project","prepare"]},{"actionId":"projects.script.run","path":["project","script","run"],"visibility":"canonical","pattern":["project","script","run"]},{"actionId":"projects.compute.exec","path":["project","compute","exec"],"visibility":"canonical","pattern":["project","compute","exec"]},{"actionId":"projects.inspect","path":["project","inspect"],"visibility":"canonical","pattern":["project","inspect"]},{"actionId":"projects.manifest.update","path":["project","manifest","update"],"visibility":"canonical","pattern":["project","manifest","update"]},{"actionId":"workflow.authoring.conversation.bind","path":["workflow","authoring","conversation","bind"],"visibility":"canonical","pattern":["workflow","authoring","conversation","bind"]},{"actionId":"workflow.trigger.test","path":["workflow","trigger","test"],"visibility":"canonical","pattern":["workflow","trigger","test"]},{"actionId":"workflow.starters.list","path":["workflow","starters","list"],"visibility":"canonical","pattern":["workflow","starters","list"]},{"actionId":"workflow.starters.resolve","path":["workflow","starters","resolve"],"visibility":"canonical","pattern":["workflow","starters","resolve"]},{"actionId":"composer.transaction.apply","path":["composer","transaction","apply"],"visibility":"canonical","pattern":["composer","transaction","apply"]},{"actionId":"composer.attachments.pick","path":["composer","attachments","pick"],"visibility":"canonical","pattern":["composer","attachments","pick"]},{"actionId":"repository.upload.pick","path":["repository","upload","pick"],"visibility":"canonical","pattern":["repository","upload","pick"]},{"actionId":"session.organization.move","path":["session","organization","move"],"visibility":"canonical","pattern":["session","organization","move"]},{"actionId":"session.pending.reorder","path":["session","pending","reorder"],"visibility":"canonical","pattern":["session","pending","reorder"]},{"actionId":"tasks.internal.reorder","path":["tasks","internal","reorder"],"visibility":"canonical","pattern":["tasks","internal","reorder"]},{"actionId":"tasks.internal.session.link","path":["tasks","internal","session","link"],"visibility":"canonical","pattern":["tasks","internal","session","link"]},{"actionId":"tasks.internal.list","path":["tasks","internal","list"],"visibility":"canonical","pattern":["tasks","internal","list"]},{"actionId":"tasks.internal.create","path":["tasks","internal","create"],"visibility":"canonical","pattern":["tasks","internal","create"]},{"actionId":"tasks.internal.edit","path":["tasks","internal","edit"],"visibility":"canonical","pattern":["tasks","internal","edit"]},{"actionId":"tasks.internal.transition","path":["tasks","internal","transition"],"visibility":"canonical","pattern":["tasks","internal","transition"]},{"actionId":"session.terminals.list","path":["session","terminals","list"],"visibility":"canonical","pattern":["session","terminals","list"]},{"actionId":"session.terminals.open","path":["session","terminals","open"],"visibility":"canonical","pattern":["session","terminals","open"]},{"actionId":"session.terminals.split","path":["session","terminals","split"],"visibility":"canonical","pattern":["session","terminals","split"]},{"actionId":"session.terminals.focus","path":["session","terminals","focus"],"visibility":"canonical","pattern":["session","terminals","focus"]},{"actionId":"session.terminals.restart","path":["session","terminals","restart"],"visibility":"canonical","pattern":["session","terminals","restart"]},{"actionId":"session.terminals.open_in_details","path":["session","terminals","open_in_details"],"visibility":"canonical","pattern":["session","terminals","open_in_details"]},{"actionId":"session.terminals.close","path":["session","terminals","close"],"visibility":"canonical","pattern":["session","terminals","close"]},{"actionId":"session.terminals.close_others","path":["session","terminals","close_others"],"visibility":"canonical","pattern":["session","terminals","close_others"]},{"actionId":"session.terminals.close_tab","path":["session","terminals","close_tab"],"visibility":"canonical","pattern":["session","terminals","close_tab"]},{"actionId":"session.terminals.resize","path":["session","terminals","resize"],"visibility":"canonical","pattern":["session","terminals","resize"]},{"actionId":"session.terminals.rename","path":["session","terminals","rename"],"visibility":"canonical","pattern":["session","terminals","rename"]},{"actionId":"session.terminals.list_view","path":["session","terminals","list_view"],"visibility":"canonical","pattern":["session","terminals","list_view"]},{"actionId":"session.terminals.run_script","path":["session","terminals","run_script"],"visibility":"canonical","pattern":["session","terminals","run_script"]},{"actionId":"session.terminals.detach","path":["session","terminals","detach"],"visibility":"canonical","pattern":["session","terminals","detach"]},{"actionId":"session.terminals.reorder","path":["session","terminals","reorder"],"visibility":"canonical","pattern":["session","terminals","reorder"]},{"actionId":"session.draft.open","path":["session","draft","open"],"visibility":"canonical","pattern":["session","draft","open"]},{"actionId":"session.draft.append","path":["session","draft","append"],"visibility":"canonical","pattern":["session","draft","append"]},{"actionId":"session.work.get","path":["session","work","get"],"visibility":"canonical","pattern":["session","work","get"]},{"actionId":"inbox.get","path":["inbox","get"],"visibility":"canonical","pattern":["inbox","get"]},{"actionId":"inbox.mark_all_read","path":["inbox","mark-all-read"],"visibility":"canonical","pattern":["inbox","mark-all-read"]},{"actionId":"session.draft.delete","path":["session","draft","delete"],"visibility":"canonical","pattern":["session","draft","delete"]},{"actionId":"session.draft.directory.set","path":["session","draft","directory","set"],"visibility":"canonical","pattern":["session","draft","directory","set"]},{"actionId":"clipboard.write","path":["clipboard","write"],"visibility":"canonical","pattern":["clipboard","write"]},{"actionId":"diagnostics.diagnosis.run","path":["diagnostics","diagnosis","run"],"visibility":"canonical","pattern":["diagnostics","diagnosis","run"]},{"actionId":"diagnostics.daemons.check","path":["diagnostics","daemons","check"],"visibility":"canonical","pattern":["diagnostics","daemons","check"]},{"actionId":"diagnostics.status.get","path":["diagnostics","status","get"],"visibility":"canonical","pattern":["diagnostics","status","get"]},{"actionId":"actions.policy.get","path":["actions","policy","get"],"visibility":"canonical","pattern":["actions","policy","get"]},{"actionId":"actions.policy.set","path":["actions","policy","set"],"visibility":"canonical","pattern":["actions","policy","set"]},{"actionId":"actions.policy.reset","path":["actions","policy","reset"],"visibility":"canonical","pattern":["actions","policy","reset"]},{"actionId":"settings.list","path":["settings","list"],"visibility":"canonical","pattern":["settings","list"]},{"actionId":"settings.get","path":["settings","get"],"visibility":"canonical","pattern":["settings","get"]},{"actionId":"settings.set","path":["settings","set"],"visibility":"canonical","pattern":["settings","set"]},{"actionId":"settings.reset","path":["settings","reset"],"visibility":"canonical","pattern":["settings","reset"]},{"actionId":"settings.invoke","path":["settings","invoke"],"visibility":"canonical","pattern":["settings","invoke"]},{"actionId":"boards.list","path":["boards","list"],"visibility":"canonical","pattern":["boards","list"]},{"actionId":"boards.apply","path":["boards","apply"],"visibility":"canonical","pattern":["boards","apply"]},{"actionId":"widgets.catalog.list","path":["widgets","catalog","list"],"visibility":"canonical","pattern":["widgets","catalog","list"]},{"actionId":"widgets.item.list","path":["widgets","item","list"],"visibility":"canonical","pattern":["widgets","item","list"]},{"actionId":"widgets.item.add","path":["widgets","item","add"],"visibility":"canonical","pattern":["widgets","item","add"]},{"actionId":"widgets.item.remove","path":["widgets","item","remove"],"visibility":"canonical","pattern":["widgets","item","remove"]},{"actionId":"widgets.item.move","path":["widgets","item","move"],"visibility":"canonical","pattern":["widgets","item","move"]},{"actionId":"widgets.item.rename","path":["widgets","item","rename"],"visibility":"canonical","pattern":["widgets","item","rename"]},{"actionId":"widgets.item.size.set","path":["widgets","item","size","set"],"visibility":"canonical","pattern":["widgets","item","size","set"]},{"actionId":"widgets.item.frame.set","path":["widgets","item","frame","set"],"visibility":"canonical","pattern":["widgets","item","frame","set"]},{"actionId":"widgets.item.network.set","path":["widgets","item","network","set"],"visibility":"canonical","pattern":["widgets","item","network","set"]},{"actionId":"widgets.item.inputs.get","path":["widgets","item","inputs","get"],"visibility":"canonical","pattern":["widgets","item","inputs","get"]},{"actionId":"widgets.item.inputs.validate","path":["widgets","item","inputs","validate"],"visibility":"canonical","pattern":["widgets","item","inputs","validate"]},{"actionId":"widgets.item.inputs.set","path":["widgets","item","inputs","set"],"visibility":"canonical","pattern":["widgets","item","inputs","set"]},{"actionId":"widgets.item.inputs.reset","path":["widgets","item","inputs","reset"],"visibility":"canonical","pattern":["widgets","item","inputs","reset"]},{"actionId":"widgets.item.refresh","path":["widgets","item","refresh"],"visibility":"canonical","pattern":["widgets","item","refresh"]},{"actionId":"widgets.group.create","path":["widgets","group","create"],"visibility":"canonical","pattern":["widgets","group","create"]},{"actionId":"widgets.group.add","path":["widgets","group","add"],"visibility":"canonical","pattern":["widgets","group","add"]},{"actionId":"widgets.group.ungroup","path":["widgets","group","ungroup"],"visibility":"canonical","pattern":["widgets","group","ungroup"]},{"actionId":"widgets.group.set","path":["widgets","group","set"],"visibility":"canonical","pattern":["widgets","group","set"]},{"actionId":"widgets.group.inputs.set","path":["widgets","group","inputs","set"],"visibility":"canonical","pattern":["widgets","group","inputs","set"]},{"actionId":"widgets.area.layout.select","path":["widgets","area","layout","select"],"visibility":"canonical","pattern":["widgets","area","layout","select"]},{"actionId":"widgets.area.layout.reset","path":["widgets","area","layout","reset"],"visibility":"canonical","pattern":["widgets","area","layout","reset"]},{"actionId":"widgets.area.layout.undo","path":["widgets","area","layout","undo"],"visibility":"canonical","pattern":["widgets","area","layout","undo"]},{"actionId":"widgets.area.layout.list","path":["widgets","area","layout","list"],"visibility":"canonical","pattern":["widgets","area","layout","list"]},{"actionId":"widgets.area.layout.create","path":["widgets","area","layout","create"],"visibility":"canonical","pattern":["widgets","area","layout","create"]},{"actionId":"widgets.area.layout.rename","path":["widgets","area","layout","rename"],"visibility":"canonical","pattern":["widgets","area","layout","rename"]},{"actionId":"widgets.area.layout.delete","path":["widgets","area","layout","delete"],"visibility":"canonical","pattern":["widgets","area","layout","delete"]},{"actionId":"widgets.area.layout.reorder","path":["widgets","area","layout","reorder"],"visibility":"canonical","pattern":["widgets","area","layout","reorder"]},{"actionId":"widgets.definition.list","path":["widgets","definition","list"],"visibility":"canonical","pattern":["widgets","definition","list"]},{"actionId":"widgets.definition.get","path":["widgets","definition","get"],"visibility":"canonical","pattern":["widgets","definition","get"]},{"actionId":"widgets.definition.create","path":["widgets","definition","create"],"visibility":"canonical","pattern":["widgets","definition","create"]},{"actionId":"widgets.definition.update","path":["widgets","definition","update"],"visibility":"canonical","pattern":["widgets","definition","update"]},{"actionId":"widgets.definition.duplicate","path":["widgets","definition","duplicate"],"visibility":"canonical","pattern":["widgets","definition","duplicate"]},{"actionId":"widgets.definition.delete","path":["widgets","definition","delete"],"visibility":"canonical","pattern":["widgets","definition","delete"]},{"actionId":"widgets.definition.saveFromSession","path":["widgets","definition","save-from-session"],"visibility":"canonical","pattern":["widgets","definition","save-from-session"]},{"actionId":"widgets.fragment.list","path":["widgets","fragment","list"],"visibility":"canonical","pattern":["widgets","fragment","list"]},{"actionId":"widgets.fragment.get","path":["widgets","fragment","get"],"visibility":"canonical","pattern":["widgets","fragment","get"]},{"actionId":"widgets.fragment.create","path":["widgets","fragment","create"],"visibility":"canonical","pattern":["widgets","fragment","create"]},{"actionId":"widgets.fragment.update","path":["widgets","fragment","update"],"visibility":"canonical","pattern":["widgets","fragment","update"]},{"actionId":"widgets.fragment.duplicate","path":["widgets","fragment","duplicate"],"visibility":"canonical","pattern":["widgets","fragment","duplicate"]},{"actionId":"widgets.fragment.delete","path":["widgets","fragment","delete"],"visibility":"canonical","pattern":["widgets","fragment","delete"]},{"actionId":"widgets.snapshot.post","path":["widgets","snapshot","post"],"visibility":"canonical","pattern":["widgets","snapshot","post"]},{"actionId":"artifact.access.grants.list","path":["artifact","access","grants","list"],"visibility":"canonical","pattern":["artifact","access","grants","list"]},{"actionId":"artifact.access.grants.set","path":["artifact","access","grants","set"],"visibility":"canonical","pattern":["artifact","access","grants","set"]},{"actionId":"artifact.access.grants.remove","path":["artifact","access","grants","remove"],"visibility":"canonical","pattern":["artifact","access","grants","remove"]},{"actionId":"artifact.create","path":["artifact","create"],"visibility":"canonical","pattern":["artifact","create"]},{"actionId":"artifact.get","path":["artifact","get"],"visibility":"canonical","pattern":["artifact","get"]},{"actionId":"artifact.export","path":["artifact","export"],"visibility":"canonical","pattern":["artifact","export"]},{"actionId":"artifact.list","path":["artifact","list"],"visibility":"canonical","pattern":["artifact","list"]},{"actionId":"artifact.update","path":["artifact","update"],"visibility":"canonical","pattern":["artifact","update"]},{"actionId":"artifact.delete","path":["artifact","delete"],"visibility":"canonical","pattern":["artifact","delete"]},{"actionId":"artifact.publish_from_file","path":["artifact","publish-from-file"],"visibility":"canonical","pattern":["artifact","publish-from-file"]},{"actionId":"artifact.revisions.list","path":["artifact","revisions","list"],"visibility":"canonical","pattern":["artifact","revisions","list"]},{"actionId":"artifact.revisions.restore","path":["artifact","revisions","restore"],"visibility":"canonical","pattern":["artifact","revisions","restore"]},{"actionId":"artifact.storage.usage","path":["artifact","storage","usage"],"visibility":"canonical","pattern":["artifact","storage","usage"]},{"actionId":"artifact.public_link.create","path":["artifact","public-link","create"],"visibility":"canonical","pattern":["artifact","public-link","create"]},{"actionId":"artifact.public_link.list","path":["artifact","public-link","list"],"visibility":"canonical","pattern":["artifact","public-link","list"]},{"actionId":"artifact.public_link.revoke","path":["artifact","public-link","revoke"],"visibility":"canonical","pattern":["artifact","public-link","revoke"]},{"actionId":"artifact.public_link.audit","path":["artifact","public-link","audit"],"visibility":"canonical","pattern":["artifact","public-link","audit"]},{"actionId":"launch_profiles.publish","path":["launch_profiles","publish"],"visibility":"canonical","pattern":["launch_profiles","publish"]},{"actionId":"session.role.set","path":["session","role","set"],"visibility":"canonical","pattern":["session","role","set"]},{"actionId":"session.roles.override.set","path":["session","roles","override","set"],"visibility":"canonical","pattern":["session","roles","override","set"]},{"actionId":"session.roles.override.clear","path":["session","roles","override","clear"],"visibility":"canonical","pattern":["session","roles","override","clear"]},{"actionId":"session.roles.add","path":["session","roles","add"],"visibility":"canonical","pattern":["session","roles","add"]},{"actionId":"session.roles.remove","path":["session","roles","remove"],"visibility":"canonical","pattern":["session","roles","remove"]},{"actionId":"session.notes.set","path":["session","notes","set"],"visibility":"canonical","pattern":["session","notes","set"]},{"actionId":"session.roles.apply_to_reports","path":["session","roles","apply_to_reports"],"visibility":"canonical","pattern":["session","roles","apply_to_reports"]},{"actionId":"roles.list","path":["roles","list"],"visibility":"canonical","pattern":["roles","list"]},{"actionId":"roles.get","path":["roles","get"],"visibility":"canonical","pattern":["roles","get"]},{"actionId":"roles.create","path":["roles","create"],"visibility":"canonical","pattern":["roles","create"]},{"actionId":"roles.update","path":["roles","update"],"visibility":"canonical","pattern":["roles","update"]},{"actionId":"roles.delete","path":["roles","delete"],"visibility":"canonical","pattern":["roles","delete"]},{"actionId":"roles.override.set","path":["roles","override","set"],"visibility":"canonical","pattern":["roles","override","set"]},{"actionId":"roles.override.reset","path":["roles","override","reset"],"visibility":"canonical","pattern":["roles","override","reset"]},{"actionId":"plugins.install","path":["plugins","install"],"visibility":"canonical","pattern":["plugins","install"]},{"actionId":"plugins.install","path":["plugins","update"],"visibility":"alias","pattern":["plugins","update"]},{"actionId":"plugins.install","path":["plugins","marketplace","install"],"visibility":"alias","pattern":["plugins","marketplace","install"]},{"actionId":"plugins.uninstall","path":["plugins","uninstall"],"visibility":"canonical","pattern":["plugins","uninstall"]},{"actionId":"plugins.enable","path":["plugins","enable"],"visibility":"canonical","pattern":["plugins","enable"]},{"actionId":"plugins.disable","path":["plugins","disable"],"visibility":"canonical","pattern":["plugins","disable"]},{"actionId":"plugins.rollback","path":["plugins","rollback"],"visibility":"canonical","pattern":["plugins","rollback"]},{"actionId":"plugins.trust.forget","path":["plugins","trust","forget"],"visibility":"canonical","pattern":["plugins","trust","forget"]},{"actionId":"plugins.update_policy.set","path":["plugins","update-policy","set"],"visibility":"canonical","pattern":["plugins","update-policy","set"]},{"actionId":"reviews.comments.create","path":["reviews","comments","create"],"visibility":"canonical","pattern":["reviews","comments","create"]},{"actionId":"reviews.comments.list","path":["reviews","comments","list"],"visibility":"canonical","pattern":["reviews","comments","list"]},{"actionId":"reviews.comments.get","path":["reviews","comments","get"],"visibility":"canonical","pattern":["reviews","comments","get"]},{"actionId":"reviews.comments.transition","path":["reviews","comments","transition"],"visibility":"canonical","pattern":["reviews","comments","transition"]},{"actionId":"reviews.comments.edit","path":["reviews","comments","edit"],"visibility":"canonical","pattern":["reviews","comments","edit"]},{"actionId":"reviews.comments.reply","path":["reviews","comments","reply"],"visibility":"canonical","pattern":["reviews","comments","reply"]},{"actionId":"reviews.comments.redact","path":["reviews","comments","redact"],"visibility":"canonical","pattern":["reviews","comments","redact"]},{"actionId":"reviews.comments.setDisposition","path":["reviews","comments","set-disposition"],"visibility":"canonical","pattern":["reviews","comments","set-disposition"]},{"actionId":"reviews.comments.attachEvidence","path":["reviews","comments","attach-evidence"],"visibility":"canonical","pattern":["reviews","comments","attach-evidence"]},{"actionId":"reviews.comments.bulkTransition","path":["reviews","comments","bulk-transition"],"visibility":"canonical","pattern":["reviews","comments","bulk-transition"]},{"actionId":"localServices.inventory.list","path":["services","inventory","list"],"visibility":"canonical","pattern":["services","inventory","list"]},{"actionId":"localServices.inventory.refresh","path":["services","inventory","refresh"],"visibility":"canonical","pattern":["services","inventory","refresh"]},{"actionId":"localServices.launcher.snapshot","path":["services","launcher","snapshot"],"visibility":"canonical","pattern":["services","launcher","snapshot"]},{"actionId":"localServices.launcher.start","path":["services","start"],"visibility":"canonical","pattern":["services","start"]},{"actionId":"localServices.launcher.registerPreview","path":["services","launcher","register-preview"],"visibility":"canonical","pattern":["services","launcher","register-preview"]},{"actionId":"localServices.launcher.history.clear","path":["services","launcher","history","clear"],"visibility":"canonical","pattern":["services","launcher","history","clear"]},{"actionId":"localServices.preview.openOrCreate","path":["services","preview","create"],"visibility":"canonical","pattern":["services","preview","create"]},{"actionId":"localServices.preview.status","path":["services","preview","status"],"visibility":"canonical","pattern":["services","preview","status"]},{"actionId":"localServices.preview.revoke","path":["services","preview","revoke"],"visibility":"canonical","pattern":["services","preview","revoke"]},{"actionId":"localServices.publicPreview.create","path":["services","public-preview","create"],"visibility":"canonical","pattern":["services","public-preview","create"]},{"actionId":"localServices.publicPreview.status","path":["services","public-preview","status"],"visibility":"canonical","pattern":["services","public-preview","status"]},{"actionId":"localServices.publicPreview.revoke","path":["services","public-preview","revoke"],"visibility":"canonical","pattern":["services","public-preview","revoke"]},{"actionId":"projects.service.relocate","path":["projects","service","relocate"],"visibility":"canonical","pattern":["projects","service","relocate"]},{"actionId":"localServices.actions.forget","path":["services","forget"],"visibility":"canonical","pattern":["services","forget"]},{"actionId":"localServices.actions.stopManaged","path":["services","stop"],"visibility":"canonical","pattern":["services","stop"]},{"actionId":"localServices.actions.restartManaged","path":["services","restart"],"visibility":"canonical","pattern":["services","restart"]},{"actionId":"localServices.actions.terminateDetected","path":["services","terminate"],"visibility":"canonical","pattern":["services","terminate"]},{"actionId":"plugins.execution_origin.list","path":["plugins","execution-origin","list"],"visibility":"canonical","pattern":["plugins","execution-origin","list"]},{"actionId":"plugins.execution_origin.set","path":["plugins","execution-origin","set"],"visibility":"canonical","pattern":["plugins","execution-origin","set"]},{"actionId":"plugins.execution_origin.clear","path":["plugins","execution-origin","clear"],"visibility":"canonical","pattern":["plugins","execution-origin","clear"]},{"actionId":"home.public_profiles.restrict","path":["home","public-profiles","restrict"],"visibility":"canonical","pattern":["home","public-profiles","restrict"]},{"actionId":"home.public_profiles.restore","path":["home","public-profiles","restore"],"visibility":"canonical","pattern":["home","public-profiles","restore"]},{"actionId":"home.public_profiles.handle_reclaim","path":["home","public-profiles","handle-reclaim"],"visibility":"canonical","pattern":["home","public-profiles","handle-reclaim"]},{"actionId":"home.search.rebuild","path":["home","search","rebuild"],"visibility":"canonical","pattern":["home","search","rebuild"]},{"actionId":"home.governance.get","path":["home","governance","get"],"visibility":"canonical","pattern":["home","governance","get"]},{"actionId":"home.governance.eligibility.get","path":["home","governance","eligibility","get"],"visibility":"canonical","pattern":["home","governance","eligibility","get"]},{"actionId":"home.emptiness.get","path":["home","emptiness","get"],"visibility":"canonical","pattern":["home","emptiness","get"]},{"actionId":"home.governance.claim","path":["home","governance","claim"],"visibility":"canonical","pattern":["home","governance","claim"]},{"actionId":"home.accounts.list","path":["home","accounts","list"],"visibility":"canonical","pattern":["home","accounts","list"]},{"actionId":"home.accounts.search","path":["home","accounts","search"],"visibility":"canonical","pattern":["home","accounts","search"]},{"actionId":"home.accounts.get","path":["home","accounts","get"],"visibility":"canonical","pattern":["home","accounts","get"]},{"actionId":"home.accounts.role.set","path":["home","accounts","role","set"],"visibility":"canonical","pattern":["home","accounts","role","set"]},{"actionId":"home.accounts.disable","path":["home","accounts","disable"],"visibility":"canonical","pattern":["home","accounts","disable"]},{"actionId":"home.accounts.enable","path":["home","accounts","enable"],"visibility":"canonical","pattern":["home","accounts","enable"]},{"actionId":"home.accounts.delete","path":["home","accounts","delete"],"visibility":"canonical","pattern":["home","accounts","delete"]},{"actionId":"home.accounts.signOutEverywhere","path":["home","accounts","sign-out-everywhere"],"visibility":"canonical","pattern":["home","accounts","sign-out-everywhere"]},{"actionId":"home.policy.set","path":["home","policy","set"],"visibility":"canonical","pattern":["home","policy","set"]},{"actionId":"home.settings.get","path":["home","settings","get"],"visibility":"canonical","pattern":["home","settings","get"]},{"actionId":"home.settings.set","path":["home","settings","set"],"visibility":"canonical","pattern":["home","settings","set"]},{"actionId":"home.mailDelivery.get","path":["home","mail-delivery","get"],"visibility":"canonical","pattern":["home","mail-delivery","get"]},{"actionId":"home.mailDelivery.test","path":["home","mail-delivery","test"],"visibility":"canonical","pattern":["home","mail-delivery","test"]},{"actionId":"home.audit.list","path":["home","audit","list"],"visibility":"canonical","pattern":["home","audit","list"]},{"actionId":"home.reachability.get","path":["home","reachability","get"],"visibility":"canonical","pattern":["home","reachability","get"]},{"actionId":"home.reachability.iroh.set","path":["home","reachability","iroh","set"],"visibility":"canonical","pattern":["home","reachability","iroh","set"]},{"actionId":"home.retention.dryRun","path":["home","retention","dry-run"],"visibility":"canonical","pattern":["home","retention","dry-run"]},{"actionId":"account.profile.get","path":["account","profile","get"],"visibility":"canonical","pattern":["account","profile","get"]},{"actionId":"account.name.set","path":["account","name","set"],"visibility":"canonical","pattern":["account","name","set"]},{"actionId":"account.username.set","path":["account","username","set"],"visibility":"canonical","pattern":["account","username","set"]},{"actionId":"account.username.check","path":["account","username","check"],"visibility":"canonical","pattern":["account","username","check"]},{"actionId":"account.username.release","path":["account","username","release"],"visibility":"canonical","pattern":["account","username","release"]},{"actionId":"account.public_profile.get","path":["account","public-profile","get"],"visibility":"canonical","pattern":["account","public-profile","get"]},{"actionId":"account.public_profile.preview","path":["account","public-profile","preview"],"visibility":"canonical","pattern":["account","public-profile","preview"]},{"actionId":"account.public_profile.publish","path":["account","public-profile","publish"],"visibility":"canonical","pattern":["account","public-profile","publish"]},{"actionId":"account.public_profile.resume","path":["account","public-profile","resume"],"visibility":"canonical","pattern":["account","public-profile","resume"]},{"actionId":"account.public_profile.update","path":["account","public-profile","update"],"visibility":"canonical","pattern":["account","public-profile","update"]},{"actionId":"account.public_profile.refresh","path":["account","public-profile","refresh"],"visibility":"canonical","pattern":["account","public-profile","refresh"]},{"actionId":"account.public_profile.pause","path":["account","public-profile","pause"],"visibility":"canonical","pattern":["account","public-profile","pause"]},{"actionId":"account.public_profile.unpublish","path":["account","public-profile","unpublish"],"visibility":"canonical","pattern":["account","public-profile","unpublish"]},{"actionId":"account.public_profile.report.get","path":["account","public-profile","report","get"],"visibility":"canonical","pattern":["account","public-profile","report","get"]},{"actionId":"account.public_profile.embed.get","path":["account","public-profile","embed","get"],"visibility":"canonical","pattern":["account","public-profile","embed","get"]},{"actionId":"friends.add","path":["friends","add"],"visibility":"canonical","pattern":["friends","add"]},{"actionId":"friends.remove","path":["friends","remove"],"visibility":"canonical","pattern":["friends","remove"]},{"actionId":"home.identity.connections.list","path":["home","identity","connections","list"],"visibility":"canonical","pattern":["home","identity","connections","list"]},{"actionId":"home.identity.connections.create","path":["home","identity","connections","create"],"visibility":"canonical","pattern":["home","identity","connections","create"]},{"actionId":"home.identity.connections.settings.update","path":["home","identity","connections","settings","update"],"visibility":"canonical","pattern":["home","identity","connections","settings","update"]},{"actionId":"home.identity.connections.enable","path":["home","identity","connections","enable"],"visibility":"canonical","pattern":["home","identity","connections","enable"]},{"actionId":"home.identity.connections.disable","path":["home","identity","connections","disable"],"visibility":"canonical","pattern":["home","identity","connections","disable"]},{"actionId":"home.identity.connections.remove.preview","path":["home","identity","connections","remove","preview"],"visibility":"canonical","pattern":["home","identity","connections","remove","preview"]},{"actionId":"home.identity.connections.remove","path":["home","identity","connections","remove"],"visibility":"canonical","pattern":["home","identity","connections","remove"]},{"actionId":"home.identity.connections.test.start","path":["home","identity","connections","test","start"],"visibility":"canonical","pattern":["home","identity","connections","test","start"]},{"actionId":"home.identity.connections.test.consume","path":["home","identity","connections","test","consume"],"visibility":"canonical","pattern":["home","identity","connections","test","consume"]},{"actionId":"home.identity.workos.adminPortalLink.create","path":["home","identity","workos","admin-portal-link","create"],"visibility":"canonical","pattern":["home","identity","workos","admin-portal-link","create"]},{"actionId":"home.identity.workos.connection.create","path":["home","identity","workos","connection","create"],"visibility":"canonical","pattern":["home","identity","workos","connection","create"]},{"actionId":"home.identity.workos.reconcile","path":["home","identity","workos","reconcile"],"visibility":"canonical","pattern":["home","identity","workos","reconcile"]},{"actionId":"home.identity.workos.connection.set","path":["home","identity","workos","connection","set"],"visibility":"canonical","pattern":["home","identity","workos","connection","set"]},{"actionId":"session.sections.list","path":["session","sections","list"],"visibility":"canonical","pattern":["session","sections","list"]},{"actionId":"session.sections.create","path":["session","sections","create"],"visibility":"canonical","pattern":["session","sections","create"]},{"actionId":"session.sections.update","path":["session","sections","update"],"visibility":"canonical","pattern":["session","sections","update"]},{"actionId":"session.sections.reorder","path":["session","sections","reorder"],"visibility":"canonical","pattern":["session","sections","reorder"]},{"actionId":"session.sections.delete","path":["session","sections","delete"],"visibility":"canonical","pattern":["session","sections","delete"]},{"actionId":"session.sections.archive","path":["session","sections","archive"],"visibility":"canonical","pattern":["session","sections","archive"]},{"actionId":"session.section.set","path":["session","section","set"],"visibility":"canonical","pattern":["session","section","set"]},{"actionId":"session.tags.list","path":["session","tags","list"],"visibility":"canonical","pattern":["session","tags","list"]},{"actionId":"session.tags.create","path":["session","tags","create"],"visibility":"canonical","pattern":["session","tags","create"]},{"actionId":"session.tags.rename","path":["session","tags","rename"],"visibility":"canonical","pattern":["session","tags","rename"]},{"actionId":"session.tags.delete","path":["session","tags","delete"],"visibility":"canonical","pattern":["session","tags","delete"]},{"actionId":"machines.metadata.update","path":["machines","metadata","update"],"visibility":"canonical","pattern":["machines","metadata","update"]},{"actionId":"machines.daemon.stop","path":["machines","daemon","stop"],"visibility":"canonical","pattern":["machines","daemon","stop"]},{"actionId":"machines.remove","path":["machines","remove"],"visibility":"canonical","pattern":["machines","remove"]},{"actionId":"machines.capabilities.install","path":["machines","capabilities","install"],"visibility":"canonical","pattern":["machines","capabilities","install"]},{"actionId":"machines.replacement.set","path":["machines","replacement","set"],"visibility":"canonical","pattern":["machines","replacement","set"]},{"actionId":"machines.replacement.clear","path":["machines","replacement","clear"],"visibility":"canonical","pattern":["machines","replacement","clear"]},{"actionId":"machines.terminal.open","path":["machines","terminal","open"],"visibility":"canonical","pattern":["machines","terminal","open"]},{"actionId":"machines.terminal.list","path":["machines","terminal","list"],"visibility":"canonical","pattern":["machines","terminal","list"]},{"actionId":"machines.terminal.read","path":["machines","terminal","read"],"visibility":"canonical","pattern":["machines","terminal","read"]},{"actionId":"machines.terminal.write","path":["machines","terminal","write"],"visibility":"canonical","pattern":["machines","terminal","write"]},{"actionId":"machines.terminal.close","path":["machines","terminal","close"],"visibility":"canonical","pattern":["machines","terminal","close"]},{"actionId":"machines.terminal.restart","path":["machines","terminal","restart"],"visibility":"canonical","pattern":["machines","terminal","restart"]},{"actionId":"machines.vitals.get","path":["machines","vitals","get"],"visibility":"canonical","pattern":["machines","vitals","get"]},{"actionId":"machines.vitals.history.get","path":["machines","vitals","history","get"],"visibility":"canonical","pattern":["machines","vitals","history","get"]},{"actionId":"machines.vitals.summaries.list","path":["machines","vitals","summaries","list"],"visibility":"canonical","pattern":["machines","vitals","summaries","list"]},{"actionId":"machines.processes.list","path":["machines","processes","list"],"visibility":"canonical","pattern":["machines","processes","list"]},{"actionId":"machines.processes.get","path":["machines","processes","get"],"visibility":"canonical","pattern":["machines","processes","get"]},{"actionId":"machines.processes.check","path":["machines","processes","check"],"visibility":"canonical","pattern":["machines","processes","check"]},{"actionId":"machines.processes.stop","path":["machines","processes","stop"],"visibility":"canonical","pattern":["machines","processes","stop"]},{"actionId":"machines.processes.startAgain","path":["machines","processes","start-again"],"visibility":"canonical","pattern":["machines","processes","start-again"]},{"actionId":"machines.processes.kill","path":["machines","processes","kill"],"visibility":"canonical","pattern":["machines","processes","kill"]},{"actionId":"machines.processes.leftBehind.cleanUp","path":["machines","processes","clean-up"],"visibility":"canonical","pattern":["machines","processes","clean-up"]},{"actionId":"machines.storage.summary.get","path":["machines","storage","summary","get"],"visibility":"canonical","pattern":["machines","storage","summary","get"]},{"actionId":"machines.storage.pile.get","path":["machines","storage","pile","get"],"visibility":"canonical","pattern":["machines","storage","pile","get"]},{"actionId":"machines.storage.pile.set","path":["machines","storage","pile","set"],"visibility":"canonical","pattern":["machines","storage","pile","set"]},{"actionId":"machines.storage.items.check","path":["machines","storage","items","check"],"visibility":"canonical","pattern":["machines","storage","items","check"]},{"actionId":"machines.storage.trash.move","path":["machines","storage","trash","move"],"visibility":"canonical","pattern":["machines","storage","trash","move"]},{"actionId":"machines.storage.deleteNow","path":["machines","storage","delete-now"],"visibility":"canonical","pattern":["machines","storage","delete-now"]},{"actionId":"machines.storage.trash.empty","path":["machines","storage","trash","empty"],"visibility":"canonical","pattern":["machines","storage","trash","empty"]},{"actionId":"machines.storage.trash.restore","path":["machines","storage","trash","restore"],"visibility":"canonical","pattern":["machines","storage","trash","restore"]},{"actionId":"machines.storage.worktrees.list","path":["machines","storage","worktrees","list"],"visibility":"canonical","pattern":["machines","storage","worktrees","list"]},{"actionId":"machines.storage.suggestions.list","path":["machines","storage","suggestions","list"],"visibility":"canonical","pattern":["machines","storage","suggestions","list"]},{"actionId":"machines.storage.suggestions.decline","path":["machines","storage","suggestions","decline"],"visibility":"canonical","pattern":["machines","storage","suggestions","decline"]},{"actionId":"machines.storage.scan.start","path":["machines","storage","scan","start"],"visibility":"canonical","pattern":["machines","storage","scan","start"]},{"actionId":"machines.storage.scan.get","path":["machines","storage","scan","get"],"visibility":"canonical","pattern":["machines","storage","scan","get"]},{"actionId":"machines.storage.scan.cancel","path":["machines","storage","scan","cancel"],"visibility":"canonical","pattern":["machines","storage","scan","cancel"]},{"actionId":"machines.storage.scan.skip","path":["machines","storage","scan","skip"],"visibility":"canonical","pattern":["machines","storage","scan","skip"]},{"actionId":"machines.storage.protected.add","path":["machines","storage","protected","add"],"visibility":"canonical","pattern":["machines","storage","protected","add"]},{"actionId":"machines.storage.protected.remove","path":["machines","storage","protected","remove"],"visibility":"canonical","pattern":["machines","storage","protected","remove"]},{"actionId":"machines.storage.category.list","path":["machines","storage","category","list"],"visibility":"canonical","pattern":["machines","storage","category","list"]},{"actionId":"machines.storage.size.refresh","path":["machines","storage","size","refresh"],"visibility":"canonical","pattern":["machines","storage","size","refresh"]},{"actionId":"machines.resources.policy.get","path":["machines","resources","policy","get"],"visibility":"canonical","pattern":["machines","resources","policy","get"]},{"actionId":"machines.resources.policy.set","path":["machines","resources","policy","set"],"visibility":"canonical","pattern":["machines","resources","policy","set"]},{"actionId":"machines.resources.policy.set","path":["machines","processes","all"],"visibility":"alias","pattern":["machines","processes","all"]},{"actionId":"machines.guard.get","path":["machines","guard","get"],"visibility":"canonical","pattern":["machines","guard","get"]},{"actionId":"machines.guard.activity.list","path":["machines","guard","activity","list"],"visibility":"canonical","pattern":["machines","guard","activity","list"]},{"actionId":"machines.guard.activity.undo","path":["machines","guard","activity","undo"],"visibility":"canonical","pattern":["machines","guard","activity","undo"]},{"actionId":"machines.guard.idleStop.keepRunning","path":["machines","guard","idle-stop","keep-running"],"visibility":"canonical","pattern":["machines","guard","idle-stop","keep-running"]},{"actionId":"machines.guard.sessionCeiling.set","path":["machines","guard","session-ceiling","set"],"visibility":"canonical","pattern":["machines","guard","session-ceiling","set"]},{"actionId":"teams.credentials.usage.export","path":["teams","credentials","usage","export"],"visibility":"canonical","pattern":["teams","credentials","usage","export"]},{"actionId":"teams.credentials.list","path":["credentials","list"],"visibility":"canonical","pattern":["credentials","list"]},{"actionId":"teams.credentials.sources.list","path":["credentials","sources","list"],"visibility":"canonical","pattern":["credentials","sources","list"]},{"actionId":"teams.credentials.requestPolicySupport.get","path":["credentials","request-policy-support","get"],"visibility":"canonical","pattern":["credentials","request-policy-support","get"]},{"actionId":"teams.credentials.sourceResources.list","path":["credentials","source-resources","list"],"visibility":"canonical","pattern":["credentials","source-resources","list"]},{"actionId":"teams.credentials.get","path":["credentials","get"],"visibility":"canonical","pattern":["credentials","get"]},{"actionId":"teams.credentials.entitled.list","path":["credentials","entitled","list"],"visibility":"canonical","pattern":["credentials","entitled","list"]},{"actionId":"teams.credentials.create","path":["credentials","create"],"visibility":"canonical","pattern":["credentials","create"]},{"actionId":"teams.credentials.update","path":["credentials","update"],"visibility":"canonical","pattern":["credentials","update"]},{"actionId":"teams.credentials.audience.set","path":["credentials","audience","set"],"visibility":"canonical","pattern":["credentials","audience","set"]},{"actionId":"teams.credentials.delete","path":["credentials","delete"],"visibility":"canonical","pattern":["credentials","delete"]},{"actionId":"teams.credentials.test","path":["credentials","test"],"visibility":"canonical","pattern":["credentials","test"]},{"actionId":"teams.credentials.preparation.get","path":["credentials","preparation","get"],"visibility":"canonical","pattern":["credentials","preparation","get"]},{"actionId":"teams.credentials.activity.list","path":["credentials","activity","list"],"visibility":"canonical","pattern":["credentials","activity","list"]},{"actionId":"teams.credentials.limits.list","path":["credentials","limits","list"],"visibility":"canonical","pattern":["credentials","limits","list"]},{"actionId":"teams.credentials.limits.upsert","path":["credentials","limits","upsert"],"visibility":"canonical","pattern":["credentials","limits","upsert"]},{"actionId":"teams.credentials.limits.delete","path":["credentials","limits","delete"],"visibility":"canonical","pattern":["credentials","limits","delete"]},{"actionId":"teams.credentials.usage.query","path":["credentials","usage","query"],"visibility":"canonical","pattern":["credentials","usage","query"]},{"actionId":"teams.credentials.externalKeys.create","path":["credentials","external-keys","create"],"visibility":"canonical","pattern":["credentials","external-keys","create"]},{"actionId":"teams.credentials.externalKeys.authorize","path":["credentials","external-keys","authorize"],"visibility":"canonical","pattern":["credentials","external-keys","authorize"]},{"actionId":"teams.credentials.externalKeys.list","path":["credentials","external-keys","list"],"visibility":"canonical","pattern":["credentials","external-keys","list"]},{"actionId":"teams.credentials.externalKeys.revoke","path":["credentials","external-keys","revoke"],"visibility":"canonical","pattern":["credentials","external-keys","revoke"]},{"actionId":"teams.credentials.externalKeys.revokeAll","path":["credentials","external-keys","revoke-all"],"visibility":"canonical","pattern":["credentials","external-keys","revoke-all"]},{"actionId":"teams.list","path":["teams","list"],"visibility":"canonical","pattern":["teams","list"]},{"actionId":"teams.get","path":["teams","get"],"visibility":"canonical","pattern":["teams","get"]},{"actionId":"teams.create","path":["teams","create"],"visibility":"canonical","pattern":["teams","create"]},{"actionId":"teams.update","path":["teams","update"],"visibility":"canonical","pattern":["teams","update"]},{"actionId":"teams.logo.set","path":["teams","logo","set"],"visibility":"canonical","pattern":["teams","logo","set"]},{"actionId":"teams.logo.remove","path":["teams","logo","remove"],"visibility":"canonical","pattern":["teams","logo","remove"]},{"actionId":"teams.policy.set","path":["teams","policy","set"],"visibility":"canonical","pattern":["teams","policy","set"]},{"actionId":"teams.archive","path":["teams","archive"],"visibility":"canonical","pattern":["teams","archive"]},{"actionId":"teams.restore","path":["teams","restore"],"visibility":"canonical","pattern":["teams","restore"]},{"actionId":"teams.members.list","path":["teams","members","list"],"visibility":"canonical","pattern":["teams","members","list"]},{"actionId":"teams.members.get","path":["teams","members","get"],"visibility":"canonical","pattern":["teams","members","get"]},{"actionId":"teams.members.add","path":["teams","members","add"],"visibility":"canonical","pattern":["teams","members","add"]},{"actionId":"teams.members.role.set","path":["teams","members","role","set"],"visibility":"canonical","pattern":["teams","members","role","set"]},{"actionId":"teams.members.suspend","path":["teams","members","suspend"],"visibility":"canonical","pattern":["teams","members","suspend"]},{"actionId":"teams.members.reactivate","path":["teams","members","reactivate"],"visibility":"canonical","pattern":["teams","members","reactivate"]},{"actionId":"teams.members.remove","path":["teams","members","remove"],"visibility":"canonical","pattern":["teams","members","remove"]},{"actionId":"teams.members.leave","path":["teams","members","leave"],"visibility":"canonical","pattern":["teams","members","leave"]},{"actionId":"teams.members.management.set","path":["teams","members","management","set"],"visibility":"canonical","pattern":["teams","members","management","set"]},{"actionId":"teams.members.groups.list","path":["teams","members","groups","list"],"visibility":"canonical","pattern":["teams","members","groups","list"]},{"actionId":"teams.groups.list","path":["teams","groups","list"],"visibility":"canonical","pattern":["teams","groups","list"]},{"actionId":"teams.groups.get","path":["teams","groups","get"],"visibility":"canonical","pattern":["teams","groups","get"]},{"actionId":"teams.groups.create","path":["teams","groups","create"],"visibility":"canonical","pattern":["teams","groups","create"]},{"actionId":"teams.groups.update","path":["teams","groups","update"],"visibility":"canonical","pattern":["teams","groups","update"]},{"actionId":"teams.groups.archive","path":["teams","groups","archive"],"visibility":"canonical","pattern":["teams","groups","archive"]},{"actionId":"teams.groups.restore","path":["teams","groups","restore"],"visibility":"canonical","pattern":["teams","groups","restore"]},{"actionId":"teams.groups.members.list","path":["teams","groups","members","list"],"visibility":"canonical","pattern":["teams","groups","members","list"]},{"actionId":"teams.groups.members.add","path":["teams","groups","members","add"],"visibility":"canonical","pattern":["teams","groups","members","add"]},{"actionId":"teams.groups.members.remove","path":["teams","groups","members","remove"],"visibility":"canonical","pattern":["teams","groups","members","remove"]},{"actionId":"teams.invitations.list","path":["teams","invitations","list"],"visibility":"canonical","pattern":["teams","invitations","list"]},{"actionId":"teams.invitations.create","path":["teams","invitations","create"],"visibility":"canonical","pattern":["teams","invitations","create"]},{"actionId":"teams.invitations.revoke","path":["teams","invitations","revoke"],"visibility":"canonical","pattern":["teams","invitations","revoke"]},{"actionId":"teams.invitations.reissue","path":["teams","invitations","reissue"],"visibility":"canonical","pattern":["teams","invitations","reissue"]},{"actionId":"teams.invitations.preview","path":["teams","invitations","preview"],"visibility":"canonical","pattern":["teams","invitations","preview"]},{"actionId":"teams.invitations.accept","path":["teams","invitations","accept"],"visibility":"canonical","pattern":["teams","invitations","accept"]},{"actionId":"teams.identity.connections.list","path":["teams","identity","connections","list"],"visibility":"canonical","pattern":["teams","identity","connections","list"]},{"actionId":"teams.identity.connections.create","path":["teams","identity","connections","create"],"visibility":"canonical","pattern":["teams","identity","connections","create"]},{"actionId":"teams.identity.connections.settings.update","path":["teams","identity","connections","settings","update"],"visibility":"canonical","pattern":["teams","identity","connections","settings","update"]},{"actionId":"teams.identity.connections.enable","path":["teams","identity","connections","enable"],"visibility":"canonical","pattern":["teams","identity","connections","enable"]},{"actionId":"teams.identity.connections.disable","path":["teams","identity","connections","disable"],"visibility":"canonical","pattern":["teams","identity","connections","disable"]},{"actionId":"teams.identity.connections.remove.preview","path":["teams","identity","connections","remove","preview"],"visibility":"canonical","pattern":["teams","identity","connections","remove","preview"]},{"actionId":"teams.identity.connections.remove","path":["teams","identity","connections","remove"],"visibility":"canonical","pattern":["teams","identity","connections","remove"]},{"actionId":"teams.identity.connections.test.start","path":["teams","identity","connections","test","start"],"visibility":"canonical","pattern":["teams","identity","connections","test","start"]},{"actionId":"teams.identity.connections.test.consume","path":["teams","identity","connections","test","consume"],"visibility":"canonical","pattern":["teams","identity","connections","test","consume"]},{"actionId":"teams.identity.workos.connection.create","path":["teams","identity","workos","connection","create"],"visibility":"canonical","pattern":["teams","identity","workos","connection","create"]},{"actionId":"teams.identity.workos.adminPortalLink.create","path":["teams","identity","workos","admin-portal-link","create"],"visibility":"canonical","pattern":["teams","identity","workos","admin-portal-link","create"]},{"actionId":"teams.identity.workos.reconcile","path":["teams","identity","workos","reconcile"],"visibility":"canonical","pattern":["teams","identity","workos","reconcile"]},{"actionId":"teams.identity.workos.connection.set","path":["teams","identity","workos","connection","set"],"visibility":"canonical","pattern":["teams","identity","workos","connection","set"]},{"actionId":"teams.externalGroupBindings.list","path":["teams","external-group-bindings","list"],"visibility":"canonical","pattern":["teams","external-group-bindings","list"]},{"actionId":"teams.externalGroupBindings.set","path":["teams","external-group-bindings","set"],"visibility":"canonical","pattern":["teams","external-group-bindings","set"]},{"actionId":"teams.externalGroupBindings.remove","path":["teams","external-group-bindings","remove"],"visibility":"canonical","pattern":["teams","external-group-bindings","remove"]},{"actionId":"teams.directory.sourceSetup.list","path":["teams","directory","source-setup","list"],"visibility":"canonical","pattern":["teams","directory","source-setup","list"]},{"actionId":"teams.directory.sources.list","path":["teams","directory","sources","list"],"visibility":"canonical","pattern":["teams","directory","sources","list"]},{"actionId":"teams.directory.sources.get","path":["teams","directory","sources","get"],"visibility":"canonical","pattern":["teams","directory","sources","get"]},{"actionId":"teams.directory.people.list","path":["teams","directory","people","list"],"visibility":"canonical","pattern":["teams","directory","people","list"]},{"actionId":"teams.directory.groups.list","path":["teams","directory","groups","list"],"visibility":"canonical","pattern":["teams","directory","groups","list"]},{"actionId":"teams.directory.sources.create","path":["teams","directory","sources","create"],"visibility":"canonical","pattern":["teams","directory","sources","create"]},{"actionId":"teams.directory.sources.sync","path":["teams","directory","sources","sync"],"visibility":"canonical","pattern":["teams","directory","sources","sync"]},{"actionId":"teams.directory.sources.pause","path":["teams","directory","sources","pause"],"visibility":"canonical","pattern":["teams","directory","sources","pause"]},{"actionId":"teams.directory.sources.resume","path":["teams","directory","sources","resume"],"visibility":"canonical","pattern":["teams","directory","sources","resume"]},{"actionId":"teams.directory.sources.remove.preview","path":["teams","directory","sources","remove","preview"],"visibility":"canonical","pattern":["teams","directory","sources","remove","preview"]},{"actionId":"teams.directory.sources.remove","path":["teams","directory","sources","remove"],"visibility":"canonical","pattern":["teams","directory","sources","remove"]},{"actionId":"secrets.shared.list","path":["secrets","shared","list"],"visibility":"canonical","pattern":["secrets","shared","list"]},{"actionId":"secrets.shared.create","path":["secrets","shared","create"],"visibility":"canonical","pattern":["secrets","shared","create"]},{"actionId":"secrets.shared.promote","path":["secrets","shared","promote"],"visibility":"canonical","pattern":["secrets","shared","promote"]},{"actionId":"secrets.shared.grants.set","path":["secrets","shared","grants","set"],"visibility":"canonical","pattern":["secrets","shared","grants","set"]},{"actionId":"secrets.shared.update","path":["secrets","shared","update"],"visibility":"canonical","pattern":["secrets","shared","update"]},{"actionId":"secrets.shared.delete","path":["secrets","shared","delete"],"visibility":"canonical","pattern":["secrets","shared","delete"]},{"actionId":"connectedServices.accounts.revoke","path":["mcp","servers","sign-out"],"visibility":"canonical","pattern":["mcp","servers","sign-out"]},{"actionId":"launch_profiles.read","path":["launch_profiles","read"],"visibility":"canonical","pattern":["launch_profiles","read"]},{"actionId":"launch_profiles.search","path":["launch_profiles","search"],"visibility":"canonical","pattern":["launch_profiles","search"]},{"actionId":"launch_profiles.select","path":["launch_profiles","select"],"visibility":"canonical","pattern":["launch_profiles","select"]},{"actionId":"launch_profiles.create","path":["launch_profiles","create"],"visibility":"canonical","pattern":["launch_profiles","create"]},{"actionId":"launch_profiles.save","path":["launch_profiles","save"],"visibility":"canonical","pattern":["launch_profiles","save"]},{"actionId":"launch_profiles.duplicate","path":["launch_profiles","duplicate"],"visibility":"canonical","pattern":["launch_profiles","duplicate"]},{"actionId":"launch_profiles.enabled.set","path":["launch_profiles","enabled","set"],"visibility":"canonical","pattern":["launch_profiles","enabled","set"]},{"actionId":"launch_profiles.favorite.set","path":["launch_profiles","favorite","set"],"visibility":"canonical","pattern":["launch_profiles","favorite","set"]},{"actionId":"launch_profiles.delete","path":["launch_profiles","delete"],"visibility":"canonical","pattern":["launch_profiles","delete"]},{"actionId":"launch_profiles.prompt_stack.update","path":["launch_profiles","prompt_stack","update"],"visibility":"canonical","pattern":["launch_profiles","prompt_stack","update"]},{"actionId":"launch_profiles.secrets.select","path":["launch_profiles","secrets","select"],"visibility":"canonical","pattern":["launch_profiles","secrets","select"]},{"actionId":"launch_profiles.legacy.preview","path":["launch_profiles","legacy","preview"],"visibility":"canonical","pattern":["launch_profiles","legacy","preview"]},{"actionId":"launch_profiles.legacy.convert","path":["launch_profiles","legacy","convert"],"visibility":"canonical","pattern":["launch_profiles","legacy","convert"]},{"actionId":"launch_profiles.legacy.resolve_conflict","path":["launch_profiles","legacy","resolve_conflict"],"visibility":"canonical","pattern":["launch_profiles","legacy","resolve_conflict"]},{"actionId":"mcp.servers.signIn.start","path":["mcp","servers","sign-in"],"visibility":"canonical","pattern":["mcp","servers","sign-in"]},{"actionId":"mcp.servers.list","path":["mcp","servers","list"],"visibility":"canonical","pattern":["mcp","servers","list"]},{"actionId":"mcp.servers.read","path":["mcp","servers","read"],"visibility":"canonical","pattern":["mcp","servers","read"]},{"actionId":"mcp.servers.tools.list","path":["mcp","servers","tools"],"visibility":"canonical","pattern":["mcp","servers","tools"]},{"actionId":"mcp.servers.tools.list","path":["mcp","servers","tools","list"],"visibility":"alias","pattern":["mcp","servers","tools","list"]},{"actionId":"mcp.servers.tools.set","path":["mcp","servers","tools","set"],"visibility":"canonical","pattern":["mcp","servers","tools","set"]},{"actionId":"mcp.servers.create","path":["mcp","servers","add"],"visibility":"canonical","pattern":["mcp","servers","add"]},{"actionId":"mcp.servers.update","path":["mcp","servers","update"],"visibility":"canonical","pattern":["mcp","servers","update"]},{"actionId":"mcp.servers.duplicate","path":["mcp","servers","duplicate"],"visibility":"canonical","pattern":["mcp","servers","duplicate"]},{"actionId":"mcp.servers.delete","path":["mcp","servers","delete"],"visibility":"canonical","pattern":["mcp","servers","delete"]},{"actionId":"mcp.servers.test","path":["mcp","servers","test"],"visibility":"canonical","pattern":["mcp","servers","test"]},{"actionId":"mcp.servers.import","path":["mcp","servers","import"],"visibility":"canonical","pattern":["mcp","servers","import"]},{"actionId":"mcp.found.adopt","path":["mcp","found","adopt"],"visibility":"canonical","pattern":["mcp","found","adopt"]},{"actionId":"mcp.found.list","path":["mcp","found"],"visibility":"canonical","pattern":["mcp","found"]},{"actionId":"mcp.found.list","path":["mcp","servers","detect"],"visibility":"alias","pattern":["mcp","servers","detect"]},{"actionId":"registries.updates.check","path":["registries","updates","check"],"visibility":"canonical","pattern":["registries","updates","check"]},{"actionId":"registries.updates.check","path":["skills","updates","check"],"visibility":"alias","pattern":["skills","updates","check"]},{"actionId":"registries.updates.check","path":["mcp","servers","updates","check"],"visibility":"alias","pattern":["mcp","servers","updates","check"]},{"actionId":"registries.updates.check","path":["agents","updates","check"],"visibility":"alias","pattern":["agents","updates","check"]},{"actionId":"registries.sources.list","path":["registries","sources","list"],"visibility":"canonical","pattern":["registries","sources","list"]},{"actionId":"registries.sources.list","path":["registries","list"],"visibility":"alias","pattern":["registries","list"]},{"actionId":"registries.sources.list","path":["plugins","marketplace","sources","list"],"visibility":"alias","pattern":["plugins","marketplace","sources","list"]},{"actionId":"registries.sources.detect","path":["registries","sources","detect"],"visibility":"canonical","pattern":["registries","sources","detect"]},{"actionId":"registries.sources.detect","path":["registries","detect"],"visibility":"alias","pattern":["registries","detect"]},{"actionId":"registries.sources.create","path":["registries","sources","create"],"visibility":"canonical","pattern":["registries","sources","create"]},{"actionId":"registries.sources.create","path":["registries","add"],"visibility":"alias","pattern":["registries","add"]},{"actionId":"registries.sources.create","path":["plugins","marketplace","sources","add"],"visibility":"alias","pattern":["plugins","marketplace","sources","add"]},{"actionId":"registries.sources.update","path":["registries","sources","update"],"visibility":"canonical","pattern":["registries","sources","update"]},{"actionId":"registries.sources.update","path":["registries","rename"],"visibility":"alias","pattern":["registries","rename"]},{"actionId":"registries.sources.update","path":["registries","enable"],"visibility":"alias","pattern":["registries","enable"]},{"actionId":"registries.sources.update","path":["registries","disable"],"visibility":"alias","pattern":["registries","disable"]},{"actionId":"registries.sources.update","path":["plugins","marketplace","sources","enable"],"visibility":"alias","pattern":["plugins","marketplace","sources","enable"]},{"actionId":"registries.sources.update","path":["plugins","marketplace","sources","disable"],"visibility":"alias","pattern":["plugins","marketplace","sources","disable"]},{"actionId":"registries.sources.token.set","path":["registries","sources","token","set"],"visibility":"canonical","pattern":["registries","sources","token","set"]},{"actionId":"registries.sources.token.set","path":["registries","token"],"visibility":"alias","pattern":["registries","token"]},{"actionId":"registries.sources.delete","path":["registries","sources","delete"],"visibility":"canonical","pattern":["registries","sources","delete"]},{"actionId":"registries.sources.delete","path":["registries","remove"],"visibility":"alias","pattern":["registries","remove"]},{"actionId":"registries.sources.delete","path":["plugins","marketplace","sources","remove"],"visibility":"alias","pattern":["plugins","marketplace","sources","remove"]},{"actionId":"registries.items.list","path":["registries","items","list"],"visibility":"canonical","pattern":["registries","items","list"]},{"actionId":"registries.items.list","path":["registries","search"],"visibility":"alias","pattern":["registries","search"]},{"actionId":"registries.items.list","path":["registries","browse"],"visibility":"alias","pattern":["registries","browse"]},{"actionId":"registries.items.list","path":["plugins","marketplace","list"],"visibility":"alias","pattern":["plugins","marketplace","list"]},{"actionId":"registries.items.list","path":["agents","browse"],"visibility":"alias","pattern":["agents","browse"]},{"actionId":"registries.items.read","path":["registries","items","read"],"visibility":"canonical","pattern":["registries","items","read"]},{"actionId":"registries.items.read","path":["registries","show"],"visibility":"alias","pattern":["registries","show"]},{"actionId":"registries.items.read","path":["plugins","marketplace","show"],"visibility":"alias","pattern":["plugins","marketplace","show"]},{"actionId":"registries.items.read","path":["agents","show"],"visibility":"alias","pattern":["agents","show"]},{"actionId":"secrets.list","path":["secrets","list"],"visibility":"canonical","pattern":["secrets","list"]},{"actionId":"secrets.create","path":["secrets","create"],"visibility":"canonical","pattern":["secrets","create"]},{"actionId":"secrets.update","path":["secrets","update"],"visibility":"canonical","pattern":["secrets","update"]},{"actionId":"secrets.delete","path":["secrets","delete"],"visibility":"canonical","pattern":["secrets","delete"]},{"actionId":"mcp.rules.set","path":["mcp","rules","set"],"visibility":"canonical","pattern":["mcp","rules","set"]},{"actionId":"mcp.rules.set","path":["mcp","on"],"visibility":"canonical","pattern":["mcp","on"]},{"actionId":"mcp.rules.set","path":["mcp","off"],"visibility":"canonical","pattern":["mcp","off"]},{"actionId":"mcp.rules.set","path":["mcp","inherit"],"visibility":"canonical","pattern":["mcp","inherit"]},{"actionId":"mcp.rules.set","path":["mcp","rules"],"visibility":"canonical","pattern":["mcp","rules"]},{"actionId":"mcp.rules.set","path":["mcp","servers","bind"],"visibility":"alias","pattern":["mcp","servers","bind"]},{"actionId":"mcp.rules.set","path":["mcp","servers","unbind"],"visibility":"alias","pattern":["mcp","servers","unbind"]},{"actionId":"skills.rules.set","path":["skills","rules","set"],"visibility":"canonical","pattern":["skills","rules","set"]},{"actionId":"skills.rules.set","path":["skills","on"],"visibility":"canonical","pattern":["skills","on"]},{"actionId":"skills.rules.set","path":["skills","off"],"visibility":"canonical","pattern":["skills","off"]},{"actionId":"skills.rules.set","path":["skills","inherit"],"visibility":"canonical","pattern":["skills","inherit"]},{"actionId":"skills.rules.set","path":["skills","rules"],"visibility":"canonical","pattern":["skills","rules"]},{"actionId":"sessions.spawn.capabilities.preview","path":["session","preview"],"visibility":"canonical","pattern":["session","preview"]},{"actionId":"session.capabilities.get","path":["session","capabilities"],"visibility":"canonical","pattern":["session","capabilities"]},{"actionId":"session.capabilities.get","path":["session","capabilities","list"],"visibility":"canonical","pattern":["session","capabilities",{"path":"sessionId","flag":"--session-id","aliases":[],"kind":"string","required":true,"title":"Session","description":null,"choices":null,"optionsSourceId":null,"listSeparator":null,"maxSelections":null,"visibleWhen":null,"requiredWhen":null,"disabledWhen":null,"minimum":null,"maximum":null,"exclusiveMinimum":null,"exclusiveMaximum":null},"list"]},{"actionId":"session.capabilities.set","path":["session","capabilities","add"],"visibility":"canonical","pattern":["session","capabilities",{"path":"sessionId","flag":"--session-id","aliases":[],"kind":"string","required":true,"title":"Session","description":null,"choices":null,"optionsSourceId":null,"listSeparator":null,"maxSelections":null,"visibleWhen":null,"requiredWhen":null,"disabledWhen":null,"minimum":null,"maximum":null,"exclusiveMinimum":null,"exclusiveMaximum":null},"add"]},{"actionId":"session.capabilities.set","path":["session","capabilities","remove"],"visibility":"canonical","pattern":["session","capabilities",{"path":"sessionId","flag":"--session-id","aliases":[],"kind":"string","required":true,"title":"Session","description":null,"choices":null,"optionsSourceId":null,"listSeparator":null,"maxSelections":null,"visibleWhen":null,"requiredWhen":null,"disabledWhen":null,"minimum":null,"maximum":null,"exclusiveMinimum":null,"exclusiveMaximum":null},"remove"]},{"actionId":"session.capabilities.set","path":["session","capabilities","reset"],"visibility":"canonical","pattern":["session","capabilities",{"path":"sessionId","flag":"--session-id","aliases":[],"kind":"string","required":true,"title":"Session","description":null,"choices":null,"optionsSourceId":null,"listSeparator":null,"maxSelections":null,"visibleWhen":null,"requiredWhen":null,"disabledWhen":null,"minimum":null,"maximum":null,"exclusiveMinimum":null,"exclusiveMaximum":null},"reset"]},{"actionId":"session.access.candidates.inspect","path":["session","access","candidates","inspect"],"visibility":"canonical","pattern":["session","access","candidates","inspect"]},{"actionId":"session.access.principals.resolve","path":["session","access","principals","resolve"],"visibility":"canonical","pattern":["session","access","principals","resolve"]},{"actionId":"session.access.accounts.search","path":["session","access","accounts","search"],"visibility":"canonical","pattern":["session","access","accounts","search"]},{"actionId":"skills.found.list","path":["skills","found","list"],"visibility":"canonical","pattern":["skills","found","list"]},{"actionId":"skills.found.read","path":["skills","found","show"],"visibility":"canonical","pattern":["skills","found","show"]},{"actionId":"skills.found.adopt","path":["skills","adopt"],"visibility":"canonical","pattern":["skills","adopt"]},{"actionId":"skills.machine.install","path":["skills","machine-install"],"visibility":"canonical","pattern":["skills","machine-install"]},{"actionId":"skills.machine.uninstall","path":["skills","machine-uninstall"],"visibility":"canonical","pattern":["skills","machine-uninstall"]},{"actionId":"skills.list","path":["skills","list"],"visibility":"canonical","pattern":["skills","list"]},{"actionId":"skills.read","path":["skills","show"],"visibility":"canonical","pattern":["skills","show"]},{"actionId":"skills.read","path":["skills","read"],"visibility":"alias","pattern":["skills","read"]},{"actionId":"skills.create","path":["skills","create"],"visibility":"canonical","pattern":["skills","create"]},{"actionId":"skills.update","path":["skills","update"],"visibility":"canonical","pattern":["skills","update"]},{"actionId":"skills.update","path":["skills","edit"],"visibility":"canonical","pattern":["skills","edit"]},{"actionId":"skills.update","path":["skills","auto"],"visibility":"canonical","pattern":["skills","auto"]},{"actionId":"skills.update","path":["skills","pin"],"visibility":"canonical","pattern":["skills","pin"]},{"actionId":"skills.update","path":["skills","unpin"],"visibility":"canonical","pattern":["skills","unpin"]},{"actionId":"skills.duplicate","path":["skills","duplicate"],"visibility":"canonical","pattern":["skills","duplicate"]},{"actionId":"skills.delete","path":["skills","delete"],"visibility":"canonical","pattern":["skills","delete"]},{"actionId":"skills.install","path":["skills","install"],"visibility":"canonical","pattern":["skills","install"]},{"actionId":"skills.export","path":["skills","export"],"visibility":"canonical","pattern":["skills","export"]},{"actionId":"skills.updates.diff","path":["skills","updates","diff"],"visibility":"canonical","pattern":["skills","updates","diff"]},{"actionId":"skills.updates.apply","path":["skills","updates","apply"],"visibility":"canonical","pattern":["skills","updates","apply"]},{"actionId":"providers.gateways.choose","path":["providers","gateways","choose"],"visibility":"canonical","pattern":["providers","gateways","choose"]},{"actionId":"providers.connections.describe","path":["providers","connections","describe"],"visibility":"canonical","pattern":["providers","connections","describe"]},{"actionId":"providers.connections.create_contribution","path":["providers","connections","create_contribution"],"visibility":"canonical","pattern":["providers","connections","create_contribution"]},{"actionId":"providers.connections.create_custom","path":["providers","connections","create_custom"],"visibility":"canonical","pattern":["providers","connections","create_custom"]},{"actionId":"providers.connections.enable_detected","path":["providers","connections","enable_detected"],"visibility":"canonical","pattern":["providers","connections","enable_detected"]},{"actionId":"providers.connections.start_local","path":["providers","connections","start_local"],"visibility":"canonical","pattern":["providers","connections","start_local"]},{"actionId":"providers.connections.update","path":["providers","connections","update"],"visibility":"canonical","pattern":["providers","connections","update"]},{"actionId":"providers.connections.endpoint.set","path":["providers","connections","endpoint","set"],"visibility":"canonical","pattern":["providers","connections","endpoint","set"]},{"actionId":"providers.connections.duplicate","path":["providers","connections","duplicate"],"visibility":"canonical","pattern":["providers","connections","duplicate"]},{"actionId":"providers.connections.delete","path":["providers","connections","delete"],"visibility":"canonical","pattern":["providers","connections","delete"]},{"actionId":"providers.connections.enabled.set","path":["providers","connections","enabled","set"],"visibility":"canonical","pattern":["providers","connections","enabled","set"]},{"actionId":"providers.connections.secrets.bind","path":["providers","connections","secrets","bind"],"visibility":"canonical","pattern":["providers","connections","secrets","bind"]},{"actionId":"providers.models.list","path":["providers","models","list"],"visibility":"canonical","pattern":["providers","models","list"]},{"actionId":"providers.models.projection","path":["providers","models","projection"],"visibility":"canonical","pattern":["providers","models","projection"]},{"actionId":"providers.models.refresh","path":["providers","models","refresh"],"visibility":"canonical","pattern":["providers","models","refresh"]},{"actionId":"providers.models.manual.add","path":["providers","models","manual","add"],"visibility":"canonical","pattern":["providers","models","manual","add"]},{"actionId":"providers.models.manual.remove","path":["providers","models","manual","remove"],"visibility":"canonical","pattern":["providers","models","manual","remove"]},{"actionId":"providers.models.visibility.set","path":["providers","models","visibility","set"],"visibility":"canonical","pattern":["providers","models","visibility","set"]},{"actionId":"providers.models.source_visibility.set","path":["providers","models","source_visibility","set"],"visibility":"canonical","pattern":["providers","models","source_visibility","set"]},{"actionId":"providers.models.visibility.reset","path":["providers","models","visibility","reset"],"visibility":"canonical","pattern":["providers","models","visibility","reset"]},{"actionId":"providers.models.visibility.bulk","path":["providers","models","visibility","bulk"],"visibility":"canonical","pattern":["providers","models","visibility","bulk"]},{"actionId":"providers.models.experimental.confirm","path":["providers","models","experimental","confirm"],"visibility":"canonical","pattern":["providers","models","experimental","confirm"]},{"actionId":"providers.models.load","path":["providers","models","load"],"visibility":"canonical","pattern":["providers","models","load"]},{"actionId":"providers.models.cancel_load","path":["providers","models","cancel_load"],"visibility":"canonical","pattern":["providers","models","cancel_load"]},{"actionId":"providers.probe","path":["providers","probe"],"visibility":"canonical","pattern":["providers","probe"]},{"actionId":"providers.binding.status","path":["providers","binding","status"],"visibility":"canonical","pattern":["providers","binding","status"]},{"actionId":"providers.legacy.prepare","path":["providers","legacy","prepare"],"visibility":"canonical","pattern":["providers","legacy","prepare"]},{"actionId":"providers.defaults.set","path":["providers","defaults","set"],"visibility":"canonical","pattern":["providers","defaults","set"]},{"actionId":"remote_hosts.list","path":["remote-hosts","list"],"visibility":"canonical","pattern":["remote-hosts","list"]},{"actionId":"remote_hosts.read","path":["remote-hosts","read"],"visibility":"canonical","pattern":["remote-hosts","read"]},{"actionId":"remote_hosts.save","path":["remote-hosts","save"],"visibility":"canonical","pattern":["remote-hosts","save"]},{"actionId":"remote_hosts.duplicate","path":["remote-hosts","duplicate"],"visibility":"canonical","pattern":["remote-hosts","duplicate"]},{"actionId":"remote_hosts.delete","path":["remote-hosts","delete"],"visibility":"canonical","pattern":["remote-hosts","delete"]},{"actionId":"remote_hosts.credential.change","path":["remote-hosts","credential","change"],"visibility":"canonical","pattern":["remote-hosts","credential","change"]},{"actionId":"home.runtime.restart","path":["home","runtime","restart"],"visibility":"canonical","pattern":["home","runtime","restart"]},{"actionId":"artifact.folders.list","path":["artifact","folders","list"],"visibility":"canonical","pattern":["artifact","folders","list"]},{"actionId":"artifact.folders.read","path":["artifact","folders","read"],"visibility":"canonical","pattern":["artifact","folders","read"]},{"actionId":"artifact.folders.create","path":["artifact","folders","create"],"visibility":"canonical","pattern":["artifact","folders","create"]},{"actionId":"artifact.folders.rename","path":["artifact","folders","rename"],"visibility":"canonical","pattern":["artifact","folders","rename"]},{"actionId":"artifact.folders.move","path":["artifact","folders","move"],"visibility":"canonical","pattern":["artifact","folders","move"]},{"actionId":"artifact.folders.delete","path":["artifact","folders","delete"],"visibility":"canonical","pattern":["artifact","folders","delete"]},{"actionId":"artifact.folder.set","path":["artifact","folder","set"],"visibility":"canonical","pattern":["artifact","folder","set"]},{"actionId":"identity.providers.list","path":["identity","providers","list"],"visibility":"canonical","pattern":["identity","providers","list"]},{"actionId":"identity.providers.create","path":["identity","providers","create"],"visibility":"canonical","pattern":["identity","providers","create"]},{"actionId":"identity.providers.update","path":["identity","providers","update"],"visibility":"canonical","pattern":["identity","providers","update"]},{"actionId":"identity.providers.secret.replace","path":["identity","providers","secret","replace"],"visibility":"canonical","pattern":["identity","providers","secret","replace"]},{"actionId":"identity.providers.validate","path":["identity","providers","validate"],"visibility":"canonical","pattern":["identity","providers","validate"]},{"actionId":"identity.providers.test.start","path":["identity","providers","test","start"],"visibility":"canonical","pattern":["identity","providers","test","start"]},{"actionId":"identity.providers.test.consume","path":["identity","providers","test","consume"],"visibility":"canonical","pattern":["identity","providers","test","consume"]},{"actionId":"identity.providers.enable","path":["identity","providers","enable"],"visibility":"canonical","pattern":["identity","providers","enable"]},{"actionId":"identity.providers.disable","path":["identity","providers","disable"],"visibility":"canonical","pattern":["identity","providers","disable"]},{"actionId":"identity.providers.remove.preview","path":["identity","providers","remove","preview"],"visibility":"canonical","pattern":["identity","providers","remove","preview"]},{"actionId":"identity.providers.remove","path":["identity","providers","remove"],"visibility":"canonical","pattern":["identity","providers","remove"]},{"actionId":"identity.githubApps.list","path":["identity","github-apps","list"],"visibility":"canonical","pattern":["identity","github-apps","list"]},{"actionId":"identity.githubApps.create","path":["identity","github-apps","create"],"visibility":"canonical","pattern":["identity","github-apps","create"]},{"actionId":"identity.githubApps.manifestSetup.start","path":["identity","github-apps","manifest-setup","start"],"visibility":"canonical","pattern":["identity","github-apps","manifest-setup","start"]},{"actionId":"identity.githubApps.update","path":["identity","github-apps","update"],"visibility":"canonical","pattern":["identity","github-apps","update"]},{"actionId":"identity.githubApps.verifyInstallation","path":["identity","github-apps","verify-installation"],"visibility":"canonical","pattern":["identity","github-apps","verify-installation"]},{"actionId":"identity.githubApps.remove","path":["identity","github-apps","remove"],"visibility":"canonical","pattern":["identity","github-apps","remove"]},{"actionId":"workflow.validate","path":["workflow","validate"],"visibility":"canonical","pattern":["workflow","validate"]},{"actionId":"workflow.run.start","path":["workflow","run","start"],"visibility":"canonical","pattern":["workflow","run","start"]},{"actionId":"workflow.run.list","path":["workflow","run","list"],"visibility":"canonical","pattern":["workflow","run","list"]},{"actionId":"workflow.run.summaries","path":["workflow","run","summaries"],"visibility":"canonical","pattern":["workflow","run","summaries"]},{"actionId":"workflow.run.get","path":["workflow","run","get"],"visibility":"canonical","pattern":["workflow","run","get"]},{"actionId":"workflow.run.wait","path":["workflow","run","wait"],"visibility":"canonical","pattern":["workflow","run","wait"]},{"actionId":"workflow.run.pause","path":["workflow","run","pause"],"visibility":"canonical","pattern":["workflow","run","pause"]},{"actionId":"workflow.run.resume","path":["workflow","run","resume"],"visibility":"canonical","pattern":["workflow","run","resume"]},{"actionId":"workflow.run.cancel","path":["workflow","run","cancel"],"visibility":"canonical","pattern":["workflow","run","cancel"]},{"actionId":"workflow.run.invocations.list","path":["workflow","run","invocations","list"],"visibility":"canonical","pattern":["workflow","run","invocations","list"]},{"actionId":"workflow.run.invocations.get","path":["workflow","run","invocations","get"],"visibility":"canonical","pattern":["workflow","run","invocations","get"]},{"actionId":"workflow.run.invocations.retry","path":["workflow","run","invocations","retry"],"visibility":"canonical","pattern":["workflow","run","invocations","retry"]},{"actionId":"workflow.run.delete","path":["workflow","run","delete"],"visibility":"canonical","pattern":["workflow","run","delete"]},{"actionId":"workflow.run.invocations.publish_draft","path":["workflow","run","invocations","publish_draft"],"visibility":"canonical","pattern":["workflow","run","invocations","publish_draft"]},{"actionId":"workflow.run.invocations.complete_review","path":["workflow","run","invocations","complete_review"],"visibility":"canonical","pattern":["workflow","run","invocations","complete_review"]},{"actionId":"workflow.definition.list","path":["workflow","definition","list"],"visibility":"canonical","pattern":["workflow","definition","list"]},{"actionId":"workflow.definition.get","path":["workflow","definition","get"],"visibility":"canonical","pattern":["workflow","definition","get"]},{"actionId":"workflow.definition.create","path":["workflow","definition","create"],"visibility":"canonical","pattern":["workflow","definition","create"]},{"actionId":"workflow.definition.update","path":["workflow","definition","update"],"visibility":"canonical","pattern":["workflow","definition","update"]},{"actionId":"workflow.definition.edit","path":["workflow","definition","edit"],"visibility":"canonical","pattern":["workflow","definition","edit"]},{"actionId":"workflow.definition.delete","path":["workflow","definition","delete"],"visibility":"canonical","pattern":["workflow","definition","delete"]},{"actionId":"workflow.definition.import","path":["workflow","definition","import"],"visibility":"canonical","pattern":["workflow","definition","import"]},{"actionId":"workflow.definition.export","path":["workflow","definition","export"],"visibility":"canonical","pattern":["workflow","definition","export"]},{"actionId":"workflow.definition.capture","path":["workflow","definition","capture"],"visibility":"canonical","pattern":["workflow","definition","capture"]},{"actionId":"workflow.trigger.list","path":["workflow","trigger","list"],"visibility":"canonical","pattern":["workflow","trigger","list"]},{"actionId":"workflow.trigger.add","path":["workflow","trigger","add"],"visibility":"canonical","pattern":["workflow","trigger","add"]},{"actionId":"workflow.trigger.update","path":["workflow","trigger","update"],"visibility":"canonical","pattern":["workflow","trigger","update"]},{"actionId":"workflow.trigger.remove","path":["workflow","trigger","remove"],"visibility":"canonical","pattern":["workflow","trigger","remove"]},{"actionId":"workflow.trigger.run_now","path":["workflow","trigger","run_now"],"visibility":"canonical","pattern":["workflow","trigger","run_now"]},{"actionId":"session.trigger.list","path":["session","trigger","list"],"visibility":"canonical","pattern":["session","trigger","list"]},{"actionId":"session.trigger.add","path":["session","trigger","add"],"visibility":"canonical","pattern":["session","trigger","add"]},{"actionId":"session.trigger.update","path":["session","trigger","update"],"visibility":"canonical","pattern":["session","trigger","update"]},{"actionId":"session.trigger.remove","path":["session","trigger","remove"],"visibility":"canonical","pattern":["session","trigger","remove"]},{"actionId":"workflow.events.list","path":["workflow","events","list"],"visibility":"canonical","pattern":["workflow","events","list"]},{"actionId":"machines.presets.list","path":["machines","presets","list"],"visibility":"canonical","pattern":["machines","presets","list"]},{"actionId":"machines.presets.get","path":["machines","presets","get"],"visibility":"canonical","pattern":["machines","presets","get"]},{"actionId":"machines.presets.create","path":["machines","presets","create"],"visibility":"canonical","pattern":["machines","presets","create"]},{"actionId":"machines.presets.update","path":["machines","presets","update"],"visibility":"canonical","pattern":["machines","presets","update"]},{"actionId":"machines.presets.archive","path":["machines","presets","archive"],"visibility":"canonical","pattern":["machines","presets","archive"]},{"actionId":"machines.presets.restore","path":["machines","presets","restore"],"visibility":"canonical","pattern":["machines","presets","restore"]},{"actionId":"machines.provisioners.list","path":["machines","provisioners","list"],"visibility":"canonical","pattern":["machines","provisioners","list"]},{"actionId":"machines.provisioners.check","path":["machines","provisioners","check"],"visibility":"canonical","pattern":["machines","provisioners","check"]},{"actionId":"machines.provisioners.options","path":["machines","provisioners","options"],"visibility":"canonical","pattern":["machines","provisioners","options"]},{"actionId":"machines.managed.acquire","path":["machines","managed","acquire"],"visibility":"canonical","pattern":["machines","managed","acquire"]},{"actionId":"machines.managed.list","path":["machines","managed","list"],"visibility":"canonical","pattern":["machines","managed","list"]},{"actionId":"machines.managed.get","path":["machines","managed","get"],"visibility":"canonical","pattern":["machines","managed","get"]},{"actionId":"machines.managed.references.get","path":["machines","managed","references","get"],"visibility":"canonical","pattern":["machines","managed","references","get"]},{"actionId":"machines.managed.inspect","path":["machines","managed","inspect"],"visibility":"canonical","pattern":["machines","managed","inspect"]},{"actionId":"machines.managed.bootstrap.retry","path":["machines","managed","bootstrap","retry"],"visibility":"canonical","pattern":["machines","managed","bootstrap","retry"]},{"actionId":"machines.managed.cancel","path":["machines","managed","cancel"],"visibility":"canonical","pattern":["machines","managed","cancel"]},{"actionId":"machines.managed.setup.skip","path":["machines","managed","setup","skip"],"visibility":"canonical","pattern":["machines","managed","setup","skip"]},{"actionId":"machines.environment.apply","path":["machines","environment","apply"],"visibility":"canonical","pattern":["machines","environment","apply"]},{"actionId":"machines.managed.power.set","path":["machines","managed","power","set"],"visibility":"canonical","pattern":["machines","managed","power","set"]},{"actionId":"machines.managed.rebuild","path":["machines","managed","rebuild"],"visibility":"canonical","pattern":["machines","managed","rebuild"]},{"actionId":"machines.managed.retention.update","path":["machines","managed","retention","update"],"visibility":"canonical","pattern":["machines","managed","retention","update"]},{"actionId":"machines.managed.delete","path":["machines","managed","delete"],"visibility":"canonical","pattern":["machines","managed","delete"]},{"actionId":"machines.managed.controller.update","path":["machines","managed","controller","update"],"visibility":"canonical","pattern":["machines","managed","controller","update"]},{"actionId":"machines.managed.retire","path":["machines","managed","retire"],"visibility":"canonical","pattern":["machines","managed","retire"]},{"actionId":"projects.service.placement.get","path":["projects","service","placement","get"],"visibility":"canonical","pattern":["projects","service","placement","get"]},{"actionId":"projects.service.placement.set","path":["projects","service","placement","set"],"visibility":"canonical","pattern":["projects","service","placement","set"]},{"actionId":"projects.worker.preferences.get","path":["projects","worker","preferences","get"],"visibility":"canonical","pattern":["projects","worker","preferences","get"]},{"actionId":"projects.worker.preferences.set","path":["projects","worker","preferences","set"],"visibility":"canonical","pattern":["projects","worker","preferences","set"]},{"actionId":"projects.worker.preferences.reset","path":["projects","worker","preferences","reset"],"visibility":"canonical","pattern":["projects","worker","preferences","reset"]},{"actionId":"machines.worker.policy.get","path":["machines","worker","policy","get"],"visibility":"canonical","pattern":["machines","worker","policy","get"]},{"actionId":"machines.worker.policy.set","path":["machines","worker","policy","set"],"visibility":"canonical","pattern":["machines","worker","policy","set"]},{"actionId":"projects.worker.status","path":["projects","worker","status"],"visibility":"canonical","pattern":["projects","worker","status"]},{"actionId":"projects.worker.copy.inspect","path":["projects","worker","copy","inspect"],"visibility":"canonical","pattern":["projects","worker","copy","inspect"]},{"actionId":"projects.worker.copy.retire","path":["projects","worker","copy","retire"],"visibility":"canonical","pattern":["projects","worker","copy","retire"]},{"actionId":"action.operations.list","path":["action","operations","list"],"visibility":"canonical","pattern":["action","operations","list"]},{"actionId":"action.operations.get","path":["action","operations","get"],"visibility":"canonical","pattern":["action","operations","get"]},{"actionId":"action.operations.cancel","path":["action","operations","cancel"],"visibility":"canonical","pattern":["action","operations","cancel"]},{"actionId":"projects.execution.output.read","path":["projects","execution","output","read"],"visibility":"canonical","pattern":["projects","execution","output","read"]},{"actionId":"projects.execution.output.open","path":["projects","execution","output","open"],"visibility":"canonical","pattern":["projects","execution","output","open"]},{"actionId":"projects.execution.output.copy","path":["projects","execution","output","copy"],"visibility":"canonical","pattern":["projects","execution","output","copy"]},{"actionId":"machines.pools.list","path":["machines","pools","list"],"visibility":"canonical","pattern":["machines","pools","list"]},{"actionId":"machines.pools.get","path":["machines","pools","get"],"visibility":"canonical","pattern":["machines","pools","get"]},{"actionId":"machines.pools.create","path":["machines","pools","create"],"visibility":"canonical","pattern":["machines","pools","create"]},{"actionId":"machines.pools.update","path":["machines","pools","update"],"visibility":"canonical","pattern":["machines","pools","update"]},{"actionId":"machines.pools.delete","path":["machines","pools","delete"],"visibility":"canonical","pattern":["machines","pools","delete"]},{"actionId":"machines.pools.resolve","path":["machines","pools","resolve"],"visibility":"canonical","pattern":["machines","pools","resolve"]},{"actionId":"action.spec.search","path":["actions","search"],"visibility":"canonical","pattern":["actions","search"]},{"actionId":"action.spec.get","path":["actions","get"],"visibility":"canonical","pattern":["actions","get"]},{"actionId":"wait","path":["wait"],"visibility":"canonical","pattern":["wait"]},{"actionId":"wait","path":["watch"],"visibility":"canonical","pattern":["watch"]},{"actionId":"notifications.notify_me","path":["notify"],"visibility":"canonical","pattern":["notify"]},{"actionId":"review.walkthrough","path":["review","walkthrough"],"visibility":"canonical","pattern":["review","walkthrough"]},{"actionId":"review.explain_findings","path":["review","explain-findings"],"visibility":"canonical","pattern":["review","explain-findings"]},{"actionId":"execution.run.start","path":["session","run","start"],"visibility":"canonical","pattern":["session","run","start"]},{"actionId":"execution.run.list","path":["session","run","list"],"visibility":"canonical","pattern":["session","run","list"]},{"actionId":"execution.run.get","path":["session","run","get"],"visibility":"canonical","pattern":["session","run","get"]},{"actionId":"execution.run.ensure","path":["session","run","ensure"],"visibility":"canonical","pattern":["session","run","ensure"]},{"actionId":"execution.run.stream.start","path":["session","run","stream-start"],"visibility":"canonical","pattern":["session","run","stream-start"]},{"actionId":"execution.run.stream.read","path":["session","run","stream-read"],"visibility":"canonical","pattern":["session","run","stream-read"]},{"actionId":"execution.run.stream.cancel","path":["session","run","stream-cancel"],"visibility":"canonical","pattern":["session","run","stream-cancel"]},{"actionId":"execution.run.stop","path":["session","run","stop"],"visibility":"canonical","pattern":["session","run","stop"]},{"actionId":"execution.run.wait","path":["session","run","wait"],"visibility":"canonical","pattern":["session","run","wait"]},{"actionId":"session.open","path":["session","open"],"visibility":"canonical","pattern":["session","open"]},{"actionId":"session.fork","path":["session","fork"],"visibility":"canonical","pattern":["session","fork"]},{"actionId":"session.authoring.open","path":["session","authoring","open"],"visibility":"canonical","pattern":["session","authoring","open"]},{"actionId":"projects.context.update","path":["projects","context","update"],"visibility":"canonical","pattern":["projects","context","update"]},{"actionId":"projects.visibility.set","path":["projects","visibility","set"],"visibility":"canonical","pattern":["projects","visibility","set"]},{"actionId":"projects.workspace.update","path":["projects","workspace","update"],"visibility":"canonical","pattern":["projects","workspace","update"]},{"actionId":"projects.workspace.forget","path":["projects","workspace","forget"],"visibility":"canonical","pattern":["projects","workspace","forget"]},{"actionId":"projects.list","path":["projects","list"],"visibility":"canonical","pattern":["projects","list"]},{"actionId":"projects.open","path":["projects","open"],"visibility":"canonical","pattern":["projects","open"]},{"actionId":"machines.list","path":["machines","list"],"visibility":"canonical","pattern":["machines","list"]},{"actionId":"review.engines.list","path":["review","engines"],"visibility":"canonical","pattern":["review","engines"]},{"actionId":"agents.backends.list","path":["agents","backends","list"],"visibility":"canonical","pattern":["agents","backends","list"]},{"actionId":"machines.agents.list","path":["machines","agents","list"],"visibility":"canonical","pattern":["machines","agents","list"]},{"actionId":"machines.agents.install","path":["agents","install"],"visibility":"canonical","pattern":["agents","install"]},{"actionId":"machines.agents.install","path":["agents","update"],"visibility":"alias","pattern":["agents","update"]},{"actionId":"machines.agents.install","path":["install","provider"],"visibility":"alias","pattern":["install","provider"]},{"actionId":"machines.agents.uninstall","path":["agents","remove"],"visibility":"canonical","pattern":["agents","remove"]},{"actionId":"machines.agents.install.status","path":["agents","install","status"],"visibility":"canonical","pattern":["agents","install","status"]},{"actionId":"machines.agents.install.cancel","path":["agents","install","cancel"],"visibility":"canonical","pattern":["agents","install","cancel"]},{"actionId":"session.message.send","path":["session","send"],"visibility":"canonical","pattern":["session","send"]},{"actionId":"session.message.send","path":["send"],"visibility":"alias","pattern":["send"]},{"actionId":"session.message.send","path":["session","run","send"],"visibility":"alias","pattern":["session","run","send"]},{"actionId":"discussion.pass","path":["discussions","pass"],"visibility":"canonical","pattern":["discussions","pass"]},{"actionId":"session.exchange.control","path":["session","exchange","control"],"visibility":"canonical","pattern":["session","exchange","control"]},{"actionId":"session.turn.cancel","path":["session","turn","cancel"],"visibility":"canonical","pattern":["session","turn","cancel"]},{"actionId":"session.stop","path":["session","stop"],"visibility":"canonical","pattern":["session","stop"]},{"actionId":"session.stop","path":["stop"],"visibility":"alias","pattern":["stop"]},{"actionId":"session.pending.action.set","path":["session","pending","action","set"],"visibility":"canonical","pattern":["session","pending","action","set"]},{"actionId":"session.pending.markHandled","path":["session","pending","mark-handled"],"visibility":"canonical","pattern":["session","pending","mark-handled"]},{"actionId":"session.pending.dismiss","path":["session","pending","dismiss"],"visibility":"canonical","pattern":["session","pending","dismiss"]},{"actionId":"session.pending.sendAsNew","path":["session","pending","send-as-new"],"visibility":"canonical","pattern":["session","pending","send-as-new"]},{"actionId":"session.pending.withdraw","path":["session","pending","withdraw"],"visibility":"canonical","pattern":["session","pending","withdraw"]},{"actionId":"session.presentation.apply","path":["session","presentation","apply"],"visibility":"canonical","pattern":["session","presentation","apply"]},{"actionId":"session.board.get","path":["session","board","show"],"visibility":"canonical","pattern":["session","board","show"]},{"actionId":"session.board.item.upsert","path":["session","board","item","set"],"visibility":"canonical","pattern":["session","board","item","set"]},{"actionId":"session.board.item.remove","path":["session","board","item","remove"],"visibility":"canonical","pattern":["session","board","item","remove"]},{"actionId":"session.board.layout.update","path":["session","board","layout","update"],"visibility":"canonical","pattern":["session","board","layout","update"]},{"actionId":"discussion.second_opinion.start","path":["discussions","second-opinion","start"],"visibility":"canonical","pattern":["discussions","second-opinion","start"]},{"actionId":"discussion.list","path":["discussions","list"],"visibility":"canonical","pattern":["discussions","list"]},{"actionId":"discussion.get","path":["discussions","show"],"visibility":"canonical","pattern":["discussions","show"]},{"actionId":"discussion.read","path":["discussions","read"],"visibility":"canonical","pattern":["discussions","read"]},{"actionId":"discussion.attachment.read","path":["discussions","attachments","read"],"visibility":"canonical","pattern":["discussions","attachments","read"]},{"actionId":"discussion.create","path":["discussions","create"],"visibility":"canonical","pattern":["discussions","create"]},{"actionId":"discussion.post","path":["discussions","post"],"visibility":"canonical","pattern":["discussions","post"]},{"actionId":"discussion.rename","path":["discussions","rename"],"visibility":"canonical","pattern":["discussions","rename"]},{"actionId":"discussion.archive","path":["discussions","archive"],"visibility":"canonical","pattern":["discussions","archive"]},{"actionId":"discussion.restore","path":["discussions","restore"],"visibility":"canonical","pattern":["discussions","restore"]},{"actionId":"discussion.read_state.set","path":["discussions","read-state"],"visibility":"canonical","pattern":["discussions","read-state"]},{"actionId":"discussion.reply","path":["discussions","reply"],"visibility":"canonical","pattern":["discussions","reply"]},{"actionId":"discussion.participants.list","path":["discussions","participants","list"],"visibility":"canonical","pattern":["discussions","participants","list"]},{"actionId":"discussion.candidates.list","path":["discussions","candidates","list"],"visibility":"canonical","pattern":["discussions","candidates","list"]},{"actionId":"discussion.settings.get","path":["discussions","settings","get"],"visibility":"canonical","pattern":["discussions","settings","get"]},{"actionId":"discussion.settings.set","path":["discussions","settings","set"],"visibility":"canonical","pattern":["discussions","settings","set"]},{"actionId":"discussion.invite","path":["discussions","invite"],"visibility":"canonical","pattern":["discussions","invite"]},{"actionId":"discussion.participant.policy.set","path":["discussions","participants","policy","set"],"visibility":"canonical","pattern":["discussions","participants","policy","set"]},{"actionId":"discussion.participant.remove","path":["discussions","participants","remove"],"visibility":"canonical","pattern":["discussions","participants","remove"]},{"actionId":"discussion.leave","path":["discussions","leave"],"visibility":"canonical","pattern":["discussions","leave"]},{"actionId":"discussion.owner.transfer","path":["discussions","owner","transfer"],"visibility":"canonical","pattern":["discussions","owner","transfer"]},{"actionId":"discussion.access.grants.list","path":["discussions","access","grants","list"],"visibility":"canonical","pattern":["discussions","access","grants","list"]},{"actionId":"discussion.access.grants.set","path":["discussions","access","grants","set"],"visibility":"canonical","pattern":["discussions","access","grants","set"]},{"actionId":"discussion.access.grants.remove","path":["discussions","access","grants","remove"],"visibility":"canonical","pattern":["discussions","access","grants","remove"]},{"actionId":"session.coordinator.enable","path":["session","coordinator","enable"],"visibility":"canonical","pattern":["session","coordinator","enable"]},{"actionId":"session.status.set_reason","path":["session","set-status-reason"],"visibility":"canonical","pattern":["session","set-status-reason"]},{"actionId":"session.title.set","path":["session","set-title"],"visibility":"canonical","pattern":["session","set-title"]},{"actionId":"session.bot.set","path":["session","bot","set"],"visibility":"canonical","pattern":["session","bot","set"]},{"actionId":"session.memory.set","path":["session","memory","set"],"visibility":"canonical","pattern":["session","memory","set"]},{"actionId":"session.voice.preference.set","path":["session","voice","preference","set"],"visibility":"canonical","pattern":["session","voice","preference","set"]},{"actionId":"session.context.update","path":["session","context","update"],"visibility":"canonical","pattern":["session","context","update"]},{"actionId":"session.instructions.set","path":["session","instructions","set"],"visibility":"canonical","pattern":["session","instructions","set"]},{"actionId":"session.view.toolCalls.set","path":["session","view","tools","set"],"visibility":"canonical","pattern":["session","view","tools","set"]},{"actionId":"session.permission_mode.set","path":["session","set-permission-mode"],"visibility":"canonical","pattern":["session","set-permission-mode"]},{"actionId":"session.model.set","path":["session","set-model"],"visibility":"canonical","pattern":["session","set-model"]},{"actionId":"session.archive","path":["session","archive"],"visibility":"canonical","pattern":["session","archive"]},{"actionId":"session.delete","path":["session","delete"],"visibility":"canonical","pattern":["session","delete"]},{"actionId":"session.tags.set","path":["session","tags","set"],"visibility":"canonical","pattern":["session","tags","set"]},{"actionId":"session.unarchive","path":["session","unarchive"],"visibility":"canonical","pattern":["session","unarchive"]},{"actionId":"session.targets.resolve","path":["session","targets","resolve"],"visibility":"canonical","pattern":["session","targets","resolve"]},{"actionId":"session.status.get","path":["session","status"],"visibility":"canonical","pattern":["session","status"]},{"actionId":"session.access.grants.list","path":["session","access","grants","list"],"visibility":"canonical","pattern":["session","access","grants","list"]},{"actionId":"session.access.grant.set","path":["session","access","grant","set"],"visibility":"canonical","pattern":["session","access","grant","set"]},{"actionId":"session.access.grant.remove","path":["session","access","grant","remove"],"visibility":"canonical","pattern":["session","access","grant","remove"]},{"actionId":"session.access.encryption.prepare","path":["session","access","encryption","prepare"],"visibility":"canonical","pattern":["session","access","encryption","prepare"]},{"actionId":"session.access.encryption.reprepare","path":["session","access","encryption","reprepare"],"visibility":"canonical","pattern":["session","access","encryption","reprepare"]},{"actionId":"session.access.layout.update","path":["session","access","layout","update"],"visibility":"canonical","pattern":["session","access","layout","update"]},{"actionId":"session.access.context.set","path":["session","access","context","set"],"visibility":"canonical","pattern":["session","access","context","set"]},{"actionId":"session.manager.set","path":["session","manager","set"],"visibility":"canonical","pattern":["session","manager","set"]},{"actionId":"session.responsibility.set","path":["session","responsibility","set"],"visibility":"canonical","pattern":["session","responsibility","set"]},{"actionId":"session.responsibility.candidates.list","path":["session","responsibility","candidates","list"],"visibility":"canonical","pattern":["session","responsibility","candidates","list"]},{"actionId":"session.public_link.get","path":["session","public-link","get"],"visibility":"canonical","pattern":["session","public-link","get"]},{"actionId":"session.public_link.create","path":["session","public-link","create"],"visibility":"canonical","pattern":["session","public-link","create"]},{"actionId":"session.public_link.remove","path":["session","public-link","remove"],"visibility":"canonical","pattern":["session","public-link","remove"]},{"actionId":"follow.get","path":["follow","get"],"visibility":"canonical","pattern":["follow","get"]},{"actionId":"follow.set","path":["follow","set"],"visibility":"canonical","pattern":["follow","set"]},{"actionId":"follow.remove","path":["follow","remove"],"visibility":"canonical","pattern":["follow","remove"]},{"actionId":"follow.preferences.get","path":["follow","preferences","get"],"visibility":"canonical","pattern":["follow","preferences","get"]},{"actionId":"follow.preferences.set","path":["follow","preferences","set"],"visibility":"canonical","pattern":["follow","preferences","set"]},{"actionId":"follow.list","path":["follow","list"],"visibility":"canonical","pattern":["follow","list"]},{"actionId":"follow.preview","path":["follow","preview"],"visibility":"canonical","pattern":["follow","preview"]},{"actionId":"session.delivery.mute.set","path":["session","delivery","mute","set"],"visibility":"canonical","pattern":["session","delivery","mute","set"]},{"actionId":"session.delivery.mute.remove","path":["session","delivery","mute","remove"],"visibility":"canonical","pattern":["session","delivery","mute","remove"]},{"actionId":"session.delivery.mute.list","path":["session","delivery","mute","list"],"visibility":"canonical","pattern":["session","delivery","mute","list"]},{"actionId":"session.read_state.set","path":["session","read"],"visibility":"canonical","pattern":["session","read"]},{"actionId":"session.wait.idle","path":["session","wait"],"visibility":"canonical","pattern":["session","wait"]},{"actionId":"session.list","path":["session","list"],"visibility":"canonical","pattern":["session","list"]},{"actionId":"session.list","path":["list"],"visibility":"alias","pattern":["list"]},{"actionId":"session.list","path":["ls"],"visibility":"alias","pattern":["ls"]},{"actionId":"ui.current_context.read","path":["ui","current-context","read"],"visibility":"canonical","pattern":["ui","current-context","read"]},{"actionId":"ui.current_context.command.invoke","path":["ui","current-context","command","invoke"],"visibility":"canonical","pattern":["ui","current-context","command","invoke"]},{"actionId":"agents.acp.backends.installFromRegistry","path":["agents","acp","backends","install-from-registry"],"visibility":"canonical","pattern":["agents","acp","backends","install-from-registry"]},{"actionId":"agents.acp.backends.installFromRegistry","path":["agents","add"],"visibility":"alias","pattern":["agents","add"]},{"actionId":"agents.acp.backends.get","path":["agents","acp","backends","get"],"visibility":"canonical","pattern":["agents","acp","backends","get"]},{"actionId":"agents.acp.backends.upsert","path":["agents","acp","backends","upsert"],"visibility":"canonical","pattern":["agents","acp","backends","upsert"]},{"actionId":"agents.acp.backends.delete","path":["agents","delete"],"visibility":"canonical","pattern":["agents","delete"]},{"actionId":"agents.acp.backends.delete","path":["agents","acp","backends","delete"],"visibility":"alias","pattern":["agents","acp","backends","delete"]},{"actionId":"models.favorite.set","path":["models","favorite","set"],"visibility":"canonical","pattern":["models","favorite","set"]},{"actionId":"session.model.unarm","path":["session","model","unarm"],"visibility":"canonical","pattern":["session","model","unarm"]},{"actionId":"prompts.stack.update","path":["prompts","stack","update"],"visibility":"canonical","pattern":["prompts","stack","update"]},{"actionId":"sessions.external.candidates.list","path":["sessions","external","candidates","list"],"visibility":"canonical","pattern":["sessions","external","candidates","list"]},{"actionId":"scm.commit.resolveOutcome","path":["scm","commit","resolve-outcome"],"visibility":"canonical","pattern":["scm","commit","resolve-outcome"]},{"actionId":"scm.hostingRepository.resolveAddress","path":["scm","hosting-repository","resolve-address"],"visibility":"canonical","pattern":["scm","hosting-repository","resolve-address"]},{"actionId":"scm.hostingRepository.get","path":["scm","hosting-repository","get"],"visibility":"canonical","pattern":["scm","hosting-repository","get"]},{"actionId":"scm.diffSummary.capture","path":["scm","diff-summary","capture"],"visibility":"canonical","pattern":["scm","diff-summary","capture"]},{"actionId":"scm.diffSummary.draftPullRequest","path":["scm","diff-summary","draft-pull-request"],"visibility":"canonical","pattern":["scm","diff-summary","draft-pull-request"]},{"actionId":"scm.diffSummary.generate","path":["scm","diff-summary","generate"],"visibility":"canonical","pattern":["scm","diff-summary","generate"]},{"actionId":"scm.diffSummary.commitPlan.accept","path":["scm","diff-summary","commit-plan","accept"],"visibility":"canonical","pattern":["scm","diff-summary","commit-plan","accept"]},{"actionId":"scm.diffSummary.commitPlan.stop","path":["scm","diff-summary","commit-plan","stop"],"visibility":"canonical","pattern":["scm","diff-summary","commit-plan","stop"]},{"actionId":"scm.diffSummary.commitPlan.includeHookChanges","path":["scm","diff-summary","commit-plan","include-hook-changes"],"visibility":"canonical","pattern":["scm","diff-summary","commit-plan","include-hook-changes"]},{"actionId":"scm.diffSummary.commitPlan.cancel","path":["scm","diff-summary","commit-plan","cancel"],"visibility":"canonical","pattern":["scm","diff-summary","commit-plan","cancel"]},{"actionId":"scm.diffSummary.commitPlan.recover","path":["scm","diff-summary","commit-plan","recover"],"visibility":"canonical","pattern":["scm","diff-summary","commit-plan","recover"]},{"actionId":"scm.diffSummary.reviewed.mark","path":["scm","diff-summary","reviewed","mark"],"visibility":"canonical","pattern":["scm","diff-summary","reviewed","mark"]},{"actionId":"scm.diffSummary.reviewed.unmark","path":["scm","diff-summary","reviewed","unmark"],"visibility":"canonical","pattern":["scm","diff-summary","reviewed","unmark"]},{"actionId":"scm.diffSummary.result.read","path":["scm","diff-summary","result","read"],"visibility":"canonical","pattern":["scm","diff-summary","result","read"]},{"actionId":"scm.diffSummary.result.edit","path":["scm","diff-summary","result","edit"],"visibility":"canonical","pattern":["scm","diff-summary","result","edit"]},{"actionId":"scm.diffSummary.result.undo","path":["scm","diff-summary","result","undo"],"visibility":"canonical","pattern":["scm","diff-summary","result","undo"]},{"actionId":"scm.diffSummary.result.delete","path":["scm","diff-summary","result","delete"],"visibility":"canonical","pattern":["scm","diff-summary","result","delete"]},{"actionId":"scm.diffSummary.refine","path":["scm","diff-summary","refine"],"visibility":"canonical","pattern":["scm","diff-summary","refine"]},{"actionId":"scm.diffSummary.addOutputs","path":["scm","diff-summary","add-outputs"],"visibility":"canonical","pattern":["scm","diff-summary","add-outputs"]},{"actionId":"scm.diffSummary.discuss","path":["scm","diff-summary","discuss"],"visibility":"canonical","pattern":["scm","diff-summary","discuss"]},{"actionId":"ui.command_palette.list","path":["ui","command-palette","list"],"visibility":"canonical","pattern":["ui","command-palette","list"]},{"actionId":"ui.command_palette.invoke","path":["ui","command-palette","invoke"],"visibility":"canonical","pattern":["ui","command-palette","invoke"]}]);
