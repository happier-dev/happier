import { evaluateCodexConnectedServiceHotApplyEligibility } from './authApplication/eligibility';
import { applyCodexDirectLiveAppServerAuth } from './authApplication/liveAppServerApply';
import type {
  CodexDirectLiveAuthApplyInput,
  CodexDirectLiveAuthApplyResult,
  CodexHotApplyEligibility,
} from './authApplication/types';

export {
  evaluateCodexConnectedServiceHotApplyEligibility,
  type CodexHotApplyEligibility,
};

export async function applyCodexConnectedServiceAuthGeneration(
  params: CodexDirectLiveAuthApplyInput,
): Promise<CodexDirectLiveAuthApplyResult> {
  return await applyCodexDirectLiveAppServerAuth(params);
}
