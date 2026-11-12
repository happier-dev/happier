/** Official documentation's 200 example, retrieved 2026-11-12 (not tenant traffic).
 * https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/subresources/logs/methods/get/
 * The generated example contains numeric cells in both positions. The schema permits
 * number (Unix timestamp) or string (message) cells; retain both rather than guessing
 * that every row is a fixed timestamp/message tuple. Mixed-message cases in tests
 * are separately labelled schema-derived mutations.
 */
export const workersBuildLogsResponse = {
  errors: [{ message: 'Not found', code: 12000 }],
  messages: ['string'],
  result: {
    cursor: 'eyJsaW5lIjoxMDAsInRpbWVzdGFtcCI6MTYzNjQ3MjQwMH0',
    lines: [[1636472400, 1636472400]],
    truncated: false,
  },
  success: true,
  result_info: { count: 25, page: 1, per_page: 50, total_count: 150, total_pages: 3 },
} as const;
