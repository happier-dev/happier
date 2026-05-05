/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled
 * agent UI behavior overrides.
 *
 * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles
 * between agent UI behavior graphs and the core registry maps.
 *
 * In the fully packetized state, this file is emitted by:
 * - `scripts/migrations/plugins/generateBundledPluginEntries.ts`
 */

import type { CanonicalAgentId } from './registryCore';
import type { AgentUiBehavior } from './registryUiBehavior';

import { CLAUDE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/claude/uiBehavior';
import { CODEX_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/codex/uiBehavior';
import { OPENCODE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/opencode/uiBehavior';
import { AUGGIE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/auggie/uiBehavior';
import { PI_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/pi/uiBehavior';
import { OH_MY_PI_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/ohMyPi/uiBehavior';

export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Readonly<
    Partial<Record<CanonicalAgentId, AgentUiBehavior>>
> = Object.freeze({
    claude: CLAUDE_UI_BEHAVIOR_OVERRIDE,
    codex: CODEX_UI_BEHAVIOR_OVERRIDE,
    opencode: OPENCODE_UI_BEHAVIOR_OVERRIDE,
    auggie: AUGGIE_UI_BEHAVIOR_OVERRIDE,
    pi: PI_UI_BEHAVIOR_OVERRIDE,
    ohMyPi: OH_MY_PI_UI_BEHAVIOR_OVERRIDE,
});
