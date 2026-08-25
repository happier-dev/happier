/** GENERATED executable bindings for bundled first-party plugins. */
import { createPluginContributionIdentity, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAgentRuntimeCatalogEntryHooks } from '../agentCatalogEntryHooks';
import { ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-antigravity/agent/contributions/catalog';
import { AUGGIE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-auggie/agent/contributions/catalog';
import { CLAUDE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-claude/agent/contributions/catalog';
import { CODEX_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/catalog';
import { CURSOR_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-cursor/agent/contributions/catalog';
import { GEMINI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-gemini/agent/contributions/catalog';
import { GROK_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-grok/agent/contributions/catalog';
import { KILO_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kilo/agent/contributions/catalog';
import { KIMI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kimi/agent/contributions/catalog';
import { KIRO_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-kiro/agent/contributions/catalog';
import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-ohmypi/agent/contributions/catalog';
import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-opencode/agent/contributions/catalog';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/catalog';

export type BundledFirstPartyImplementationBinding = Readonly<{
  identity: PluginContributionIdentityV1;
  implementationOwnerId: string;
  registrationFamily: string;
  implementation: unknown;
}>;

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
      systemTools: [{"executableNames":["agy"],"id":"antigravity-cli","title":"Antigravity CLI"}],
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
      systemTools: [{"executableNames":["auggie"],"id":"auggie-cli","title":"Auggie CLI"}],
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
      systemTools: [{"executableNames":["claude"],"id":"claude-cli","title":"Claude Code CLI"},{"executableNames":["security"],"id":"macos-security","title":"macOS Keychain security"}],
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
      systemTools: [{"executableNames":["codex"],"id":"codex-cli","title":"OpenAI Codex CLI"}],
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
      systemTools: [{"executableNames":["cursor-agent","agent"],"id":"cursor-agent","title":"Cursor Agent CLI"},{"executableNames":["cursor-agent"],"id":"cursor-agent-no-fallback","title":"Cursor Agent CLI without legacy agent fallback"}],
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
      systemTools: [{"executableNames":["gemini"],"id":"gemini-cli","title":"Google Gemini CLI"}],
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
      systemTools: [{"executableNames":["grok"],"id":"grok-cli","title":"Grok Build CLI"}],
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
      systemTools: [{"executableNames":["kilo"],"id":"kilo-cli","title":"Kilo CLI"}],
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
      systemTools: [{"executableNames":["kimi","kimi-cli"],"id":"kimi-cli","title":"Kimi CLI"}],
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
      systemTools: [{"executableNames":["kiro-cli"],"id":"kiro-cli","title":"Kiro CLI"}],
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
      systemTools: [{"executableNames":["omp"],"id":"ohmypi-cli","title":"Oh My Pi CLI"}],
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
      systemTools: [{"executableNames":["opencode"],"id":"opencode-cli","title":"OpenCode CLI"}],
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
      systemTools: [{"executableNames":["pi"],"id":"pi-cli","title":"Pi coding-agent CLI"}],
    }),
  }),
]);
