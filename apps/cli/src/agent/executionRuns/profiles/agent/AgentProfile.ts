import { ExecutionRunAgentIntentInputV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunResultContractV1Schema } from '@happier-dev/protocol/execution/runs/resultContractV1';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
} from '../ExecutionRunIntentProfile';
import { buildExecutionRunResultContractPrompt, decodeExecutionRunProfileResult, normalizeExecutionRunProfileResultContract } from '@happier-dev/protocol/execution/runs/resultContract';
import type { ExecutionRunProfileResultContract } from '@happier-dev/protocol';

function readAgentIntentInput(value: unknown) {
  return ExecutionRunAgentIntentInputV1Schema.parse(value ?? {});
}

function readResultContract(
  value: unknown,
  explicit?: ExecutionRunProfileResultContract,
): ExecutionRunProfileResultContract | undefined {
  if (explicit) return explicit;
  const input = readAgentIntentInput(value);
  if (input.resultContract) return ExecutionRunResultContractV1Schema.parse(input.resultContract);
  return input.resultSchema ? { kind: 'json', schema: input.resultSchema } : undefined;
}

function invalidAgentOutput(): ExecutionRunProfileBoundedCompleteResult {
  return {
    status: 'failed',
    summary: 'Agent output did not match the required result contract.',
    toolResultOutput: { error: { code: 'invalid_output' } },
  };
}

export const AgentProfile: ExecutionRunIntentProfile = {
  intent: 'agent',
  supportsDetached: true,
  transcriptMaterialization: 'none',
  prepareStartParams: ({ request }) => {
    const input = readAgentIntentInput(request.intentInput);
    const resultContract = normalizeExecutionRunProfileResultContract(
      readResultContract(
        input,
        request.resultContract
          ? ExecutionRunResultContractV1Schema.parse(request.resultContract)
          : undefined,
      ),
    );
    return {
      intentInput: {
        ...(input.input !== undefined ? { input: input.input } : {}),
      },
      ...(resultContract ? { resultContract } : {}),
    };
  },
  buildPrompt: (params) => {
    const input = readAgentIntentInput(params.intentInput);
    const blocks = [params.instructions.trim()];
    if (input.input !== undefined) {
      blocks.push(`Task input (strict JSON):\n${JSON.stringify(input.input)}`);
    }
    const resultPrompt = buildExecutionRunResultContractPrompt(readResultContract(input, params.resultContract));
    if (resultPrompt) blocks.push(resultPrompt);
    return blocks.filter(Boolean).join('\n\n');
  },
  onBoundedComplete: ({ start, rawText }) => {
    const decoded = decodeExecutionRunProfileResult(
      rawText,
      readResultContract(start.intentInput, start.resultContract),
    );
    if (!decoded.ok) return invalidAgentOutput();
    return {
      status: 'succeeded',
      summary: typeof decoded.value === 'string' ? decoded.value : JSON.stringify(decoded.value),
      toolResultOutput: decoded.value,
    };
  },
};
