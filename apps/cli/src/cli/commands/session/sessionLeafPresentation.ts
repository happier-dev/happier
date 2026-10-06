import chalk from 'chalk';
import { ok } from '@happier-dev/cli-common/output';
import { SessionStatusResultSchema, SessionStopResultSchema, SessionWaitResultSchema } from '@happier-dev/protocol/sessions/control/contract';

import type { ActionCliPresentation } from '@/cli/actions/commandPresentation';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';

/**
 * Released presentation for the migrated one-shot Session leaves.
 *
 * Only their input grammar moved to the compiled Action descriptor. The JSON
 * envelope kind, the envelope data and the human line each command has always
 * printed are preserved here, over an already executed canonical result. A root
 * alias such as `happier stop` keeps the nested command's released kind, which
 * the derived `<path>` spelling alone would not produce.
 */

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readSessionId(payload: unknown, input: Readonly<Record<string, unknown>>): string {
  const fromResult = readRecord(payload).sessionId;
  if (typeof fromResult === 'string' && fromResult.length > 0) return fromResult;
  const fromInput = input.sessionId;
  return typeof fromInput === 'string' ? fromInput : '';
}

/** A fixed released envelope kind, whichever friendly spelling was invoked. */
function fixedEnvelopeKind(kind: string): NonNullable<ActionCliPresentation['envelopeKind']> {
  return () => kind;
}

export const SESSION_STATUS_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_status'),
  presentSuccess: async (payload, context) => {
    // Presentation validation is downstream of a completed Action. Let the
    // compiled dispatcher catch a stale presenter and emit the canonical
    // success payload; a presenter must not relabel an accomplished effect as
    // failure and encourage an unsafe retry.
    const parsed = SessionStatusResultSchema.parse(payload);
    const data = {
      session: parsed.session,
      ...(parsed.agentState ? { agentState: parsed.agentState } : {}),
      ...(parsed.awareness ? { awareness: parsed.awareness } : {}),
    };
    if (context.json) {
      await printJsonEnvelope({ ok: true, kind: 'session_status', data });
      return true;
    }
    console.log(chalk.green('✓'), 'status fetched');
    await writeJsonStdout(data, { pretty: true });
    return true;
  },
};

export const SESSION_SET_TITLE_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_set_title'),
  presentSuccess: async (payload, context) => {
    const sessionId = readSessionId(payload, context.input);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_set_title',
        data: { sessionId, title: context.input.title },
      });
      return true;
    }
    console.log(ok(`Title set for ${sessionId}`));
    return true;
  },
};

export const SESSION_SET_PERMISSION_MODE_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_set_permission_mode'),
  presentSuccess: async (payload, context) => {
    const result = readRecord(payload);
    const sessionId = readSessionId(payload, context.input);
    const permissionMode = result.permissionMode ?? context.input.permissionMode;
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_set_permission_mode',
        data: { sessionId, permissionMode, updatedAt: result.updatedAt ?? null },
      });
      return true;
    }
    console.log(chalk.green('✓'), `permission mode set for ${sessionId}: ${String(permissionMode)}`);
    return true;
  },
};

export const SESSION_SET_MODEL_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_set_model'),
  presentSuccess: async (payload, context) => {
    const result = readRecord(payload);
    const selection = readRecord(result.activeSelection ?? result.selection);
    const modelId = typeof selection.modelId === 'string' ? selection.modelId : context.input.modelId;
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_set_model',
        data: { ...result, modelId, updatedAt: result.updatedAt ?? null },
      });
      return true;
    }
    console.log(
      chalk.green('✓'),
      `model ${String(result.status ?? 'updated')} for ${readSessionId(payload, context.input)}: ${String(modelId)}`,
    );
    return true;
  },
};

function archivePresentation(kind: string, verb: string): ActionCliPresentation {
  return {
    envelopeKind: fixedEnvelopeKind(kind),
    presentSuccess: async (payload, context) => {
      const result = readRecord(payload);
      const sessionId = readSessionId(payload, context.input);
      if (context.json) {
        await printJsonEnvelope({
          ok: true,
          kind,
          data: { sessionId, archivedAt: result.archivedAt ?? null },
        });
        return true;
      }
      console.log(chalk.green('✓'), `${verb} ${sessionId}`);
      return true;
    },
  };
}

export const SESSION_ARCHIVE_PRESENTATION = archivePresentation('session_archive', 'archived');
export const SESSION_UNARCHIVE_PRESENTATION = archivePresentation('session_unarchive', 'unarchived');

export const SESSION_STOP_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_stop'),
  presentSuccess: async (payload, context) => {
    const result = SessionStopResultSchema.parse(payload);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_stop',
        data: {
          sessionId: result.sessionId,
          stopped: result.stopped,
          ...(result.stopOutcome ? { stopOutcome: result.stopOutcome } : {}),
        },
      });
      return true;
    }
    if (result.stopped) {
      console.log(chalk.green('✓'), 'session stopped');
      return true;
    }
    // A confirmed stop with nothing to signal. Before the stop owner could name
    // this state it fell through to "stop could not be confirmed", which told
    // the user an already-stopped Session was indeterminate.
    if (result.stopOutcome?.status === 'already_stopped') {
      console.log(chalk.green('✓'), 'session already stopped');
      return true;
    }
    if (result.stopOutcome?.status === 'stopped_projection_unconfirmed') {
      console.log(chalk.yellow('!'), 'session stopped; status update not yet observed');
      return true;
    }
    if (result.stopOutcome?.status === 'stopped_cleanup_incomplete') {
      console.log(chalk.yellow('!'), 'session stopped; local cleanup could not be completed');
      return true;
    }
    console.log(chalk.yellow('!'), 'stop could not be confirmed');
    return true;
  },
};

export const SESSION_WAIT_PRESENTATION: ActionCliPresentation = {
  envelopeKind: fixedEnvelopeKind('session_wait'),
  presentSuccess: async (payload, context) => {
    const result = SessionWaitResultSchema.parse(payload);
    if (context.json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'session_wait',
        data: { sessionId: result.sessionId, idle: true, observedAt: result.observedAt },
      });
      return true;
    }
    console.log(ok('Session idle'));
    return true;
  },
};
