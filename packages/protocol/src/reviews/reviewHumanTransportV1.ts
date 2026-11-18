import { getActionSpec } from '../actions/actionSpecs.js';
import { REVIEW_HUMAN_ACTION_IDS_V1, type ReviewHumanActionIdV1 } from '../actions/actionIdsReviewHumanV1.js';
import { bindHomeDomainHttpRequestV1 } from '../actions/homeDomainHttpBinding.js';
import type { StoredJsonContentEnvelope } from '../storage/storedJsonContentEnvelope.js';
import {
  ReviewHumanGetInputV1Schema, ReviewHumanStateV1Schema, ReviewReviewersSetInputV1Schema,
  ReviewVerdictActionInputV1Schema, ReviewVerdictSubmitInputV1Schema,
  openReviewVerdictContentV1, prepareReviewVerdictTransportInputV1,
  type ReviewHumanActionStateV1,
} from './reviewHumanV1.js';

export type ReviewHumanResourceV1 = Readonly<{
  mode: 'plain' | 'e2ee';
  seal: (value: unknown) => Promise<StoredJsonContentEnvelope>;
  open: (content: StoredJsonContentEnvelope) => Promise<unknown>;
}>;

/** Domain adapter beneath the Action front door; the server remains the admission authority. */
export function createReviewHumanActionExecutorV1(context: Readonly<{
  accountId: string;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  resolveResource: (reviewId: string) => Promise<ReviewHumanResourceV1>;
}>): (actionId: ReviewHumanActionIdV1, input: unknown) => Promise<ReviewHumanActionStateV1> {
  return async (actionId, input) => {
    // Capture the Artifact codec lazily, once for both authoring and opening all returned history.
    let resource: Promise<ReviewHumanResourceV1> | undefined;
    const parsed = getActionSpec(actionId).inputSchema.parse(input);
    const { reviewId } = ReviewHumanGetInputV1Schema.parse({ reviewId: parsed.reviewId });
    const readResource = () => resource ??= context.resolveResource(reviewId);
    const send = async (id: ReviewHumanActionIdV1, value: unknown, wireVerdict = false) => {
      const spec = getActionSpec(id);
      const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!,
        inputSchema: wireVerdict ? ReviewVerdictSubmitInputV1Schema : spec.inputSchema, input: value });
      return ReviewHumanStateV1Schema.parse(await context.request(request.method, request.path, request.body));
    };
    let state;
    if (actionId === REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict) {
      const verdict = ReviewVerdictActionInputV1Schema.parse(input);
      const { body, ...withoutBody } = verdict;
      // Revision is needed only when prose is bound to ciphertext; prose-free verdicts need no read.
      const transport = body === undefined ? withoutBody
        : await prepareReviewVerdictTransportInputV1(verdict, { accountId: context.accountId,
          state: await send(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId }),
          seal: async value => (await readResource()).seal(value) });
      state = await send(actionId, transport, true);
    } else {
      state = await send(actionId, actionId === REVIEW_HUMAN_ACTION_IDS_V1.setReviewers
        ? ReviewReviewersSetInputV1Schema.parse(input) : { reviewId });
    }
    const verdicts = await Promise.all(state.verdicts.map(async row => {
      const { content, ...verdict } = row;
      if (!content) return verdict;
      const opened = await openReviewVerdictContentV1({ content,
        expected: { reviewId: state.reviewId, roundOrdinal: row.roundOrdinal, accountId: row.accountId, revision: row.revision },
        open: async value => (await readResource()).open(value) });
      return { ...verdict, body: opened.body };
    }));
    return { ...state, verdicts };
  };
}
