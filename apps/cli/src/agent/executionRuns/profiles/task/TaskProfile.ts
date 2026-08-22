import {
  compilePluginJsonSchema,
  ExecutionRunTaskIntentInputV1Schema,
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  StrictJsonValueSchema,
} from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
} from '../ExecutionRunIntentProfile';

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
    blocks.push([
      'Return only one strict JSON value that satisfies this required result schema:',
      JSON.stringify(input.resultSchema),
    ].join('\n'));
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

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText.trim());
    } catch {
      return invalidStructuredTaskOutput();
    }
    const strictJson = StrictJsonValueSchema.safeParse(parsedJson);
    if (!strictJson.success) return invalidStructuredTaskOutput();

    try {
      const validates = compilePluginJsonSchema(input.resultSchema);
      if (!isValidPluginJsonSchemaValue(validates, strictJson.data)) {
        return invalidStructuredTaskOutput();
      }
    } catch {
      return invalidStructuredTaskOutput();
    }

    return {
      status: 'succeeded',
      summary: 'Task completed.',
      toolResultOutput: strictJson.data,
    };
  },
};
