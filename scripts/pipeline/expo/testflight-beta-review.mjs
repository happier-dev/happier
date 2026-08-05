// @ts-check

const ANOTHER_BUILD_IN_REVIEW_CODE = 'ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW';

function hasAscErrorCode(error, code) {
  if (typeof error !== 'object' || error === null || !('body' in error)) return false;
  const body = error.body;
  if (typeof body !== 'object' || body === null || !('errors' in body) || !Array.isArray(body.errors)) return false;
  return body.errors.some((entry) => (
    typeof entry === 'object'
    && entry !== null
    && 'code' in entry
    && String(entry.code ?? '').trim() === code
  ));
}

/**
 * @param {{
 *   build: any;
 *   submitBetaReview: 'auto' | 'true' | 'false';
 *   request: (input: { method: string; url: string; body: unknown }) => Promise<unknown>;
 *   buildAscBaseUrl?: (pathname: string) => string;
 *   log?: (message: string) => void;
 * }} input
 */
export async function ensureBetaReviewSubmission(input) {
  if (input.submitBetaReview === 'false') return;
  const buildId = String(input.build?.id ?? '').trim();
  const existingSubmissionId = String(input.build?.relationships?.betaAppReviewSubmission?.data?.id ?? '').trim();
  const log = input.log ?? console.log;
  if (existingSubmissionId) {
    log(`[pipeline] beta review submission already exists for build ${buildId}: ${existingSubmissionId}`);
    return;
  }

  const buildAscBaseUrl = input.buildAscBaseUrl ?? ((pathname) => (
    new URL(pathname, 'https://api.appstoreconnect.apple.com').toString()
  ));
  try {
    await input.request({
      method: 'POST',
      url: buildAscBaseUrl('/v1/betaAppReviewSubmissions'),
      body: {
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: {
            build: {
              data: {
                type: 'builds',
                id: buildId,
              },
            },
          },
        },
      },
    });
  } catch (error) {
    if (input.submitBetaReview === 'auto' && hasAscErrorCode(error, ANOTHER_BUILD_IN_REVIEW_CODE)) {
      log(`[pipeline] deferred beta review submission for build ${buildId} because another build in the train is already under review`);
      return;
    }
    throw error;
  }
  log(`[pipeline] submitted build ${buildId} for TestFlight Beta App Review`);
}
