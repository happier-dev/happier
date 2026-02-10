export async function runReviewersSafe({ reviewers, runReviewer, onError }) {
  const list = Array.isArray(reviewers) ? reviewers : [];
  const run = typeof runReviewer === 'function' ? runReviewer : async () => null;
  const handleError = typeof onError === 'function' ? onError : (_reviewer, error) => ({ ok: false, error });

  const settled = await Promise.allSettled(list.map((r) => run(r)));
  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return handleError(list[i], s.reason);
  });
}

