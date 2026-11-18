import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeFactory,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createFiniteExecutionRunHostRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { REVIEW_SCM_SCOPE_INPUT_KEY } from '@happier-dev/plugin-sdk/reviews';

import { createCodeRabbitAgentOutput } from './agentOutput.js';
import { preflightCodeRabbitReviewScope, readCodeRabbitReviewScopeFacts, resolveCodeRabbitBaseRef } from './scopePreflight.js';
import { normalizeCodeRabbitReviewStartInput } from './startInput.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './systemTool.js';

function createRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  context: AgentRuntimeContext,
): AgentExecutionRunRuntime {
  return createFiniteExecutionRunHostRuntime({
    request,
    signal: context.signal,
    unsupportedSendDiagnostic: {
      code: 'coderabbit_follow_up_unsupported', severity: 'error', message: 'CodeRabbit execution runs are single-shot',
    },
    mapFailure: (error) => ({
      // Process exceptions can contain host paths or authentication output; native typed events carry safe review causes below.
      code: isPluginError(error) ? error.code : 'action_failed', severity: 'error', message: 'CodeRabbit could not execute. Check the CLI installation and authentication on this machine.',
    }),
    async execute({ signal, emit }) {
      if (context.services.availability('exec').status !== 'available') {
        throw new Error('CodeRabbit execution requires the host process service');
      }
      const reviewInput = normalizeCodeRabbitReviewStartInput({
        intentInput: request.input.structuredInput ?? {}, fallbackInstructions: request.input.text,
      });
      const scopeFacts = readCodeRabbitReviewScopeFacts(reviewInput[REVIEW_SCM_SCOPE_INPUT_KEY]);
      const preflight = await preflightCodeRabbitReviewScope({
        cwd: request.cwd, intentInput: request.input.structuredInput ?? {}, scope: scopeFacts,
      });
      if (!preflight.ok) {
        return { status: 'failed', diagnostic: { code: 'coderabbit_scope_unsupported', severity: 'error', message: preflight.error } };
      }
      const engineConfig = reviewInput.engines?.coderabbit;
      const args = ['review', '--agent', '--dir', request.cwd];
      if (reviewInput.changeType === 'committed') args.push('--committed');
      if (reviewInput.changeType === 'uncommitted') args.push('--uncommitted');
      const resolvedBaseRef = resolveCodeRabbitBaseRef({ reviewInput, scope: scopeFacts });
      if (reviewInput.base.kind === 'commit' && resolvedBaseRef) args.push('--base-commit', resolvedBaseRef);
      else if (resolvedBaseRef) args.push('--base', resolvedBaseRef);
      if (typeof engineConfig?.gate === 'string') args.push('--gate', engineConfig.gate);
      if (Array.isArray(engineConfig?.configFiles)) {
        const configFiles = engineConfig.configFiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        if (configFiles.length > 0) args.push('--config', ...configFiles);
      }

      const output = createCodeRabbitAgentOutput();
      const child = await context.services.exec.spawn({
        executable: { kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID }, args,
        cwd: { root: 'workspace', relativePath: '' },
      }, { signal });
      const subscription = child.onOutput(chunk => {
        if (chunk.stream === 'stdout') output.write(chunk.data);
      });
      try {
        const result = await child.wait();
        if (signal.aborted) return { status: 'cancelled' };
        const observed = result.termination.observed;
        const folded = output.finish(observed.kind === 'exit' ? observed.exitCode : null);
        emit({ kind: 'output-delta', channel: 'assistant', text: folded.output });
        if (observed.kind === 'failed') return { status: 'failed', diagnostic: {
          code: observed.diagnostic.code, severity: 'error', message: 'The CodeRabbit process could not finish.',
        } };
        return folded.completed ? { status: 'complete' } : {
          status: 'failed', diagnostic: { code: folded.code, severity: 'error', message: folded.message },
        };
      } finally {
        subscription.dispose();
        await child.dispose();
      }
    },
  });
}

export function createCodeRabbitExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  const factory: AgentExecutionRunRuntimeFactory = {
    open(request: AgentExecutionRunOpenRequest, context: AgentRuntimeContext) {
      if (request.kind !== 'create') throw new Error('CodeRabbit execution runs support create only');
      return createRuntime(request, context);
    },
  };
  return Object.freeze(factory);
}
