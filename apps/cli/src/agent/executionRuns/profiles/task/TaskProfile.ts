import { ExecutionRunTaskIntentInputV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
} from '../ExecutionRunIntentProfile';
import { buildExecutionRunResultContractPrompt, decodeExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';

function readTaskIntentInput(value: unknown) {
  return ExecutionRunTaskIntentInputV1Schema.parse(value ?? {});
}

function buildTaskPrompt(params: Parameters<ExecutionRunIntentProfile['buildPrompt']>[0]): string {
  const input = readTaskIntentInput(params.intentInput);
  const blocks = [params.instructions.trim()];
  if (input.input !== undefined) {
    blocks.push(`Task input (strict JSON):\n${JSON.stringify(input.input)}`);
  }
  if (input.resultSchema) {
    blocks.push(buildExecutionRunResultContractPrompt({ kind: 'json', schema: input.resultSchema })!);
  }
  return blocks.filter(Boolean).join('\n\n');
}

function invalidStructuredTaskOutput(): ExecutionRunProfileBoundedCompleteResult {
  return {
    status: 'failed',
    summary: 'Task output did not match the required strict JSON result schema.',
    toolResultOutput: { error: { code: 'invalid_output' } },
  };
}

export const TaskProfile: ExecutionRunIntentProfile = {
  intent: 'task',
  transcriptMaterialization: 'none',
  supportsDetached: true,
  prepareStartParams: ({ request }) => {
    const input = readTaskIntentInput(request.intentInput);
    return {
      intentInput: {
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.resultSchema ? { resultSchema: normalizePluginJsonSchema(input.resultSchema) } : {}),
      },
    };
  },
  buildPrompt: buildTaskPrompt,
  onBoundedComplete: ({ start, rawText }) => {
    const input = readTaskIntentInput(start.intentInput);
    if (!input.resultSchema) {
      return {
        status: 'succeeded',
        summary: 'Task completed.',
        toolResultOutput: rawText,
      };
    }

    const decoded = decodeExecutionRunProfileResult(rawText, { kind: 'json', schema: input.resultSchema });
    if (!decoded.ok) return invalidStructuredTaskOutput();

    return {
      status: 'succeeded',
      summary: 'Task completed.',
      toolResultOutput: decoded.value,
    };
  },
};
