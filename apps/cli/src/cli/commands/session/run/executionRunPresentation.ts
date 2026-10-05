import chalk from 'chalk';
import {
  ExecutionRunGetResponseSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunWaitResultSchema,
} from '@happier-dev/protocol';

import type { ActionCliPresentation } from '@/cli/actions/commandPresentation';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readInputString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function fixedEnvelopeKind(kind: string): NonNullable<ActionCliPresentation['envelopeKind']> {
  return () => kind;
}

export const EXECUTION_RUN_LIST_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_run_list'),
  presentSuccess: async (payload, context) => {
    const result = ExecutionRunListResponseSchema.parse(payload);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_run_list',
        data: { sessionId: readInputString(context.input, 'sessionId'), ...result },
      });
      return true;
    }
    console.log(chalk.green('✓'), 'execution runs listed');
    await writeJsonStdout(result, { pretty: true });
    return true;
  },
};

export const EXECUTION_RUN_GET_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_run_get'),
  presentSuccess: async (payload, context) => {
    const result = ExecutionRunGetResponseSchema.parse(payload);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_run_get',
        data: { sessionId: readInputString(context.input, 'sessionId'), ...result },
      });
      return true;
    }
    console.log(chalk.green('✓'), 'execution run fetched');
    await writeJsonStdout(result, { pretty: true });
    return true;
  },
};

export const EXECUTION_RUN_START_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_run_start'),
  presentSuccess: async (payload, context) => {
    const result = ExecutionRunStartResponseSchema.parse(payload);
    const backendTarget = readRecord(context.input.backendTarget);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_run_start',
        data: {
          sessionId: readInputString(context.input, 'sessionId'),
          ...result,
          intent: context.input.intent,
          backendId: backendTarget.backendId,
          backendTarget: context.input.backendTarget,
        },
      });
      return true;
    }
    console.log(chalk.green('✓'), 'execution run started');
    await writeJsonStdout(result, { pretty: true });
    return true;
  },
};

export const EXECUTION_RUN_STOP_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_run_stop'),
  presentSuccess: async (payload, context) => {
    ExecutionRunStopResponseSchema.parse({ ok: true, ...readRecord(payload) });
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_run_stop',
        data: {
          sessionId: readInputString(context.input, 'sessionId'),
          runId: readInputString(context.input, 'runId'),
          stopped: true,
        },
      });
      return true;
    }
    console.log(chalk.green('✓'), 'stopped run');
    return true;
  },
};

export const EXECUTION_RUN_WAIT_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_run_wait'),
  presentSuccess: async (payload, context) => {
    const result = ExecutionRunWaitResultSchema.parse({ ok: true, ...readRecord(payload) });
    if (!result.ok) throw new Error(`execution_run_wait_${result.code}`);
    const sessionId = readInputString(context.input, 'sessionId');
    if ('disposition' in result && result.disposition === 'observation_timeout') {
      if (context.json) {
        await printJsonEnvelope({
          ok: true,
          kind: 'session_run_wait',
          data: {
            sessionId,
            runId: result.runId,
            status: result.status,
            disposition: result.disposition,
            timeoutMs: result.timeoutMs,
            observedAtMs: result.observedAtMs,
            deadlineAtMs: result.deadlineAtMs,
            ...('result' in result ? { result: result.result } : {}),
          },
        });
        return true;
      }
      console.log(chalk.yellow('!'), `observation ended after ${result.timeoutMs}ms: run ${result.runId} is ${result.status === 'running' ? 'still running' : result.status}`);
      return true;
    }
    if ('disposition' in result && (result.disposition === 'needs_attention' || result.disposition === 'snapshot')) {
      if (context.json) {
        await printJsonEnvelope({ ok: true, kind: 'session_run_wait', data: {
          sessionId, runId: result.result.run.runId, status: result.status,
          disposition: result.disposition, result: result.result,
        } });
        return true;
      }
      console.log(chalk.yellow('!'), result.disposition === 'needs_attention'
        ? `run ${result.result.run.runId} needs attention`
        : `run ${result.result.run.runId}: ${result.status}`);
      return true;
    }
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_run_wait',
        data: { sessionId, runId: readInputString(context.input, 'runId'), status: result.status },
      });
      return true;
    }
    console.log(chalk.green('✓'), `run finished: ${result.status}`);
    return true;
  },
};

function streamPresentation(params: Readonly<{
  kind: string;
  human: string;
  includePayload: boolean;
  fixed?: Readonly<Record<string, unknown>>;
  parsePayload: (payload: unknown) => Readonly<Record<string, unknown>>;
}>): ActionCliPresentation {
  return {
    envelopeKind: fixedEnvelopeKind(params.kind),
    presentSuccess: async (payload, context) => {
      const parsedPayload = params.parsePayload(payload);
      const data = {
        sessionId: readInputString(context.input, 'sessionId'),
        runId: readInputString(context.input, 'runId'),
        ...(typeof context.input.streamId === 'string' ? { streamId: context.input.streamId } : {}),
        ...(params.includePayload ? parsedPayload : {}),
        ...(params.fixed ?? {}),
      };
      if (context.json) {
        await printJsonEnvelope({ ok: true, kind: params.kind, data });
        return true;
      }
      console.log(chalk.green('✓'), params.human);
      if (params.includePayload) await writeJsonStdout(parsedPayload, { pretty: true });
      return true;
    },
  };
}

export const EXECUTION_RUN_STREAM_START_PRESENTATION = streamPresentation({
  kind: 'session_run_stream_start',
  human: 'run stream started',
  includePayload: true,
  parsePayload: (payload) => ExecutionRunTurnStreamStartResponseSchema.parse(payload),
});

export const EXECUTION_RUN_STREAM_READ_PRESENTATION = streamPresentation({
  kind: 'session_run_stream_read',
  human: 'run stream read',
  includePayload: true,
  parsePayload: (payload) => ExecutionRunTurnStreamReadResponseSchema.parse(payload),
});

export const EXECUTION_RUN_STREAM_CANCEL_PRESENTATION = streamPresentation({
  kind: 'session_run_stream_cancel',
  human: 'run stream cancelled',
  includePayload: false,
  fixed: { cancelled: true },
  parsePayload: (payload) => ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true, ...readRecord(payload) }),
});
