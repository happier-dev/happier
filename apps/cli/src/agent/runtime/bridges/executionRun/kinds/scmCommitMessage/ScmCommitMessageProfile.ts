import { ExecutionRunScmCommitMessageInputV1Schema } from '@happier-dev/protocol';
import type { ExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { buildCommitMessagePrompt } from './buildCommitMessagePrompt';
import { loadScmCommitMessageContext } from './loadScmCommitMessageContext';
import { parseCommitMessageModelOutput } from './parseCommitMessageModelOutput';

export const ScmCommitMessageProfile: ExecutionRunIntentProfile = {
  intent: 'scm_commit_message',
  transcriptMaterialization: 'none',
  prepareStartParams: async ({ request, cwd }) => {
    const input = ExecutionRunScmCommitMessageInputV1Schema.parse(request.intentInput ?? {});
    const context = await loadScmCommitMessageContext({
      workingDirectory: cwd,
      maxFiles: typeof input.maxFiles === 'number' ? input.maxFiles : 20,
      maxTotalDiffChars: typeof input.maxTotalDiffChars === 'number' ? input.maxTotalDiffChars : 60_000,
      scope: input.scope,
    });

    if (!context.ok) {
      throw Object.assign(new Error(context.error), { code: context.errorCode });
    }

    return {
      instructions: buildCommitMessagePrompt({
        snapshot: context.snapshot,
        diffsByPath: context.diffsByPath,
        instructions: input.instructions,
      }),
      intentInput: input,
    };
  },
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: ({ rawText }) => {
    const parsed = parseCommitMessageModelOutput(rawText);
    if (!parsed) {
      return {
        status: 'failed',
        summary: 'Commit message generation failed.',
        toolResultOutput: {
          error: { code: 'invalid_output', message: 'Empty output' },
        },
        structuredMeta: {
          kind: 'scm_commit_message.v1',
          payload: {
            errorCode: 'invalid_output',
          },
        },
      };
    }

    const result = {
      title: parsed.title,
      body: typeof parsed.body === 'string' ? parsed.body : '',
      message: parsed.message ?? parsed.title,
      ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
    };

    return {
      status: 'succeeded',
      summary: 'Commit message generated.',
      toolResultOutput: result,
      structuredMeta: {
        kind: 'scm_commit_message.v1',
        payload: result,
      },
    };
  },
};
