export const OPEN_CODE_RESUME_REACHABILITY_UNSUPPORTED = Object.freeze({
  ok: false,
  reason: 'opencode_state_not_shared',
} as const);

export function resolveOpenCodeResumeReachabilityUnsupported(): typeof OPEN_CODE_RESUME_REACHABILITY_UNSUPPORTED {
  return OPEN_CODE_RESUME_REACHABILITY_UNSUPPORTED;
}
