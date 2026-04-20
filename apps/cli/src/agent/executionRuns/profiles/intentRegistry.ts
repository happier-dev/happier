import type { ExecutionRunIntent } from '@happier-dev/protocol';

import type { ExecutionRunIntentProfile } from './ExecutionRunIntentProfile';
import { ReviewProfile } from './review/ReviewProfile';
import { PlanProfile } from './plan/PlanProfile';
import { DelegateProfile } from './delegate/DelegateProfile';
import { VoiceAgentProfile } from './voiceAgent/VoiceAgentProfile';
import { MemoryHintsProfile } from './memoryHints/MemoryHintsProfile';

const PROFILES: Record<ExecutionRunIntent, ExecutionRunIntentProfile> = {
  review: ReviewProfile,
  plan: PlanProfile,
  delegate: DelegateProfile,
  voice_agent: VoiceAgentProfile,
  memory_hints: MemoryHintsProfile,
};

export const EXECUTION_RUN_INTENT_PROFILE_REGISTRY: Readonly<Record<ExecutionRunIntent, ExecutionRunIntentProfile>> = Object.freeze(PROFILES);

export function listExecutionRunSupportedIntents(): readonly ExecutionRunIntent[] {
  return Object.keys(EXECUTION_RUN_INTENT_PROFILE_REGISTRY) as ExecutionRunIntent[];
}

export function resolveExecutionRunIntentProfile(intent: ExecutionRunIntent): ExecutionRunIntentProfile {
  return EXECUTION_RUN_INTENT_PROFILE_REGISTRY[intent];
}
