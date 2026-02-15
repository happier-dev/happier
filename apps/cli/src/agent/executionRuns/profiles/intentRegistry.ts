import type { ExecutionRunIntent } from '@happier-dev/protocol';

import type { ExecutionRunIntentProfile } from './ExecutionRunIntentProfile';
import { ReviewProfile } from './review/ReviewProfile';
import { PlanProfile } from './plan/PlanProfile';
import { DelegateProfile } from './delegate/DelegateProfile';
import { VoiceAgentProfile } from './voiceAgent/VoiceAgentProfile';

const PROFILES: Record<ExecutionRunIntent, ExecutionRunIntentProfile> = {
  review: ReviewProfile,
  plan: PlanProfile,
  delegate: DelegateProfile,
  voice_agent: VoiceAgentProfile,
};

export function resolveExecutionRunIntentProfile(intent: ExecutionRunIntent): ExecutionRunIntentProfile {
  return PROFILES[intent];
}

