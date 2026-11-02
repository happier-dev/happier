// @ts-check
import { isDeepStrictEqual } from 'node:util';

/** @param {unknown} value
 * @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @typedef {Record<string, unknown> & {
 * hostedDispatch: Record<string, unknown> & { inputs: Record<string, unknown> },
 * publicSdkApproval?: Record<string, unknown>
 * }} ApprovedReleaseIntent */

/** Parse the approved grant once before replaying its inputs.
 * @param {unknown} value
 * @returns {ApprovedReleaseIntent} */
export function readApprovedReleaseIntent(value) {
  if (!object(value) || value.kind !== 'happier.release-dispatch-plan.v3' || value.schemaVersion !== 3
      || !object(value.hostedDispatch) || !object(value.hostedDispatch.inputs)
      || (value.publicSdkApproval !== undefined && !object(value.publicSdkApproval))) {
    throw new Error('An approved release intent with canonical hosted transport is required.');
  }
  // The external JSON boundary is narrowed by the checks above.
  return /** @type {ApprovedReleaseIntent} */ (value);
}

/** Compare the whole materializer-rebound grant, preserving the existing resume authority.
 * @param {unknown} current
 * @param {ApprovedReleaseIntent} approved
 * @param {string} ciRunId
 * @param {{resumeRunId: string, attemptId: string, workflowControlSha: string}} [resumeBindings] */
export function assertApprovedReleaseIntent(current, approved, ciRunId, resumeBindings) {
  const previousAttempt = /^attempt_([1-9][0-9]*)$/u.exec(String(approved.hostedDispatch.inputs.hmaint_attempt_id ?? ''));
  const nextResume = resumeBindings && previousAttempt
    && resumeBindings.attemptId === `attempt_${BigInt(previousAttempt[1]) + 1n}`
    ? resumeBindings
    : undefined;
  const expected = {
    ...approved,
    ...(nextResume ? { resumeRunId: nextResume.resumeRunId } : {}),
    hostedDispatch: {
      ...approved.hostedDispatch,
      inputs: {
        ...approved.hostedDispatch.inputs,
        ci_run_id: ciRunId,
        ...(nextResume ? {
          resume_run_id: nextResume.resumeRunId,
          hmaint_attempt_id: nextResume.attemptId,
          workflow_control_sha: nextResume.workflowControlSha,
        } : {}),
      },
    },
  };
  if (!isDeepStrictEqual(current, expected)) {
    throw new Error('Final release plan differs from the approved release intent.');
  }
}
