import type { GithubFeedbackReviewV1 } from '../feedback.js';

/** Latest dated review per author, independent of independently loaded page order. */
export function readLatestGithubReviewsV1<T extends Pick<GithubFeedbackReviewV1, 'author' | 'submittedAtMs'>>(
  historical: readonly T[],
): ReadonlyMap<string, T> {
  const latestByAuthor = new Map<string, T>();
  for (const review of historical) {
    if (review.author === null) continue;
    const previous = latestByAuthor.get(review.author);
    // Missing/equal timestamps keep the first-seen record: they provide no
    // chronology with which to replace an already observed review.
    if (previous === undefined
      || (review.submittedAtMs !== null
        && (previous.submittedAtMs === null || review.submittedAtMs > previous.submittedAtMs))) {
      latestByAuthor.set(review.author, review);
    }
  }
  return latestByAuthor;
}
