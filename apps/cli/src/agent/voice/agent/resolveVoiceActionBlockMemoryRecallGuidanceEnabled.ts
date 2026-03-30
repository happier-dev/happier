import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/promptLibrary/resolveCliMemoryRecallGuidanceEnabled';

export async function resolveVoiceActionBlockMemoryRecallGuidanceEnabled(args?: Readonly<{
  deps?: Readonly<{
    resolveCliMemoryRecallGuidanceEnabled?: typeof resolveCliMemoryRecallGuidanceEnabled;
  }>;
}>): Promise<boolean> {
  const resolveMemoryRecallGuidanceEnabled =
    args?.deps?.resolveCliMemoryRecallGuidanceEnabled ?? resolveCliMemoryRecallGuidanceEnabled;
  return await resolveMemoryRecallGuidanceEnabled({
    surfaces: ['voice_action_block'],
  });
}
