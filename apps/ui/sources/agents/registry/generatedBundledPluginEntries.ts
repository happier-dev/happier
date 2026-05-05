/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled plugins/extensions.
 * It is the single fan-out import surface; UI registries must derive from here to avoid handwritten
 * provider-specific truth in `registryCore/registryUi/registryUiBehavior`.
 *
 * In the fully packetized state, this file is emitted by:
 * - `scripts/migrations/plugins/generateBundledPluginEntries.ts`
 *
 * Until that generator lane lands in this checkout, this file is maintained in-place so Lane D can
 * enforce the *consumption* contract without widening scope beyond `apps/ui/sources/agents/registry/**`.
 */

import type { AgentCoreConfig, CanonicalAgentId } from './registryCore';
import type { AgentUiConfig } from './registryUi';

import { CLAUDE_CORE } from '@/agents/providers/claude/core';
import { CODEX_CORE } from '@/agents/providers/codex/core';
import { OPENCODE_CORE } from '@/agents/providers/opencode/core';
import { GEMINI_CORE } from '@/agents/providers/gemini/core';
import { AUGGIE_CORE } from '@/agents/providers/auggie/core';
import { QWEN_CORE } from '@/agents/providers/qwen/core';
import { KIMI_CORE } from '@/agents/providers/kimi/core';
import { KILO_CORE } from '@/agents/providers/kilo/core';
import { KIRO_CORE } from '@/agents/providers/kiro/core';
import { PI_CORE } from '@/agents/providers/pi/core';
import { OH_MY_PI_CORE } from '@/agents/providers/ohMyPi/core';
import { COPILOT_CORE } from '@/agents/providers/copilot/core';

import { CLAUDE_UI } from '@/agents/providers/claude/ui';
import { CODEX_UI } from '@/agents/providers/codex/ui';
import { OPENCODE_UI } from '@/agents/providers/opencode/ui';
import { GEMINI_UI } from '@/agents/providers/gemini/ui';
import { AUGGIE_UI } from '@/agents/providers/auggie/ui';
import { QWEN_UI } from '@/agents/providers/qwen/ui';
import { KIMI_UI } from '@/agents/providers/kimi/ui';
import { KILO_UI } from '@/agents/providers/kilo/ui';
import { KIRO_UI } from '@/agents/providers/kiro/ui';
import { PI_UI } from '@/agents/providers/pi/ui';
import { OH_MY_PI_UI } from '@/agents/providers/ohMyPi/ui';
import { COPILOT_UI } from '@/agents/providers/copilot/ui';

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-opencode"
]);

export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({
    claude: CLAUDE_CORE,
    codex: CODEX_CORE,
    opencode: OPENCODE_CORE,
    gemini: GEMINI_CORE,
    auggie: AUGGIE_CORE,
    qwen: QWEN_CORE,
    kimi: KIMI_CORE,
    kilo: KILO_CORE,
    kiro: KIRO_CORE,
    pi: PI_CORE,
    ohMyPi: OH_MY_PI_CORE,
    copilot: COPILOT_CORE,
} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);

export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({
    claude: CLAUDE_UI,
    codex: CODEX_UI,
    opencode: OPENCODE_UI,
    gemini: GEMINI_UI,
    auggie: AUGGIE_UI,
    qwen: QWEN_UI,
    kimi: KIMI_UI,
    kilo: KILO_UI,
    kiro: KIRO_UI,
    pi: PI_UI,
    ohMyPi: OH_MY_PI_UI,
    copilot: COPILOT_UI,
} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);
