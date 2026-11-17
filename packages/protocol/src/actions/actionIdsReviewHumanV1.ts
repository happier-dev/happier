export const REVIEW_HUMAN_ACTION_IDS_V1 = Object.freeze({
  get: 'review.human.get', setReviewers: 'review.reviewers.set', submitVerdict: 'review.verdict.submit',
} as const);
export type ReviewHumanActionIdV1 = typeof REVIEW_HUMAN_ACTION_IDS_V1[keyof typeof REVIEW_HUMAN_ACTION_IDS_V1];
export function isReviewHumanActionIdV1(actionId: string): actionId is ReviewHumanActionIdV1 {
  return Object.values(REVIEW_HUMAN_ACTION_IDS_V1).some(id => id === actionId);
}
