import { DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
  DeploySuggestionCatalogV1Schema,
  DeploySuggestionCheckResultV1Schema,
  type DeploySuggestionCatalogV1,
  type DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { ToolCall } from '@happier-dev/session-core/messages';

import {
  createHappierActionToolNameIndex,
  isRecord,
  readHappierActionCallInput,
  readHappierActionExecuteActionId,
  readHappierActionId,
  readHappierActionToolResultCandidates,
} from './happierActionToolResult';

type CheckActionId = typeof DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1;
const CHECK = createHappierActionToolNameIndex<CheckActionId>([
  DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
]);
const isCheck = (id: string): id is CheckActionId =>
  id === DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1;

/** A Session agent's checked setup suggestion: the validator's admitted recommendations and the catalog they were checked against. */
export type TranscriptDeploySuggestionCheck = Readonly<{
  description: string | null;
  recommendations: readonly DeploySuggestionRecommendationV1[];
  catalog: DeploySuggestionCatalogV1;
}>;

/**
 * The one projection from a transcript tool call to setup cards (deploy auto-mode U10, F7): a completed
 * `deployments.suggestions.check` whose result admitted at least one recommendation. Cards come only from the
 * validator's result, never from the call's untrusted `suggestion` input; a result that admitted none renders
 * as the ordinary tool row.
 */
export function readTranscriptDeploySuggestionCheck(
  tool: Pick<ToolCall, 'name' | 'input' | 'state' | 'result'>,
): TranscriptDeploySuggestionCheck | null {
  const actionId =
    readHappierActionId(tool.name, CHECK) ??
    readHappierActionExecuteActionId(tool.name, tool.input, isCheck);
  if (!actionId || tool.state !== 'completed') return null;
  const input = readHappierActionCallInput(tool.name, tool.input);
  const description = isRecord(input) && typeof input.description === 'string' ? input.description : null;
  const catalog = DeploySuggestionCatalogV1Schema.safeParse(
    isRecord(input) ? input.catalog : undefined,
  );
  if (!catalog.success) return null;
  for (const candidate of readHappierActionToolResultCandidates(
    tool.result,
    tool.input,
  )) {
    // `action_execute` answers in its `{ ok, result }` envelope; a direct binding answers with the result itself.
    const value = isRecord(candidate) && candidate.ok === true ? candidate.result : candidate;
    const parsed = DeploySuggestionCheckResultV1Schema.safeParse(value);
    if (parsed.success) {
      return parsed.data.recommendations.length > 0
        ? {
            description,
            recommendations: parsed.data.recommendations,
            catalog: catalog.data,
          }
        : null;
    }
  }
  return null;
}
