import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';

export async function verifyResumeReachableGemini(
  _input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  return {
    ok: false,
    reason: 'gemini_state_not_shared',
  };
}
