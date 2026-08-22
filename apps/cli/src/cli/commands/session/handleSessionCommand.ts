import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { hasFlag } from '@/cli/commands/shared/argvFlags';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import {
  SESSION_NESTED_SUBCOMMAND_HELP_LINES,
  SESSION_SUBCOMMAND_HELP_LINES,
  SESSION_TOP_LEVEL_HELP_LINES,
} from './shared/sessionCommandUsage';

function inferSessionKind(argv: readonly string[]): string {
  const sub = String(argv[0] ?? '').trim();
  if (!sub) return 'session_unknown';
  if (sub === 'list') return 'session_list';
  if (sub === 'status') return 'session_status';
  if (sub === 'create') return 'session_create';
  if (sub === 'set-title') return 'session_set_title';
  if (sub === 'set-permission-mode') return 'session_set_permission_mode';
  if (sub === 'set-model') return 'session_set_model';
  if (sub === 'send') return 'session_send';
  if (sub === 'wait') return 'session_wait';
  if (sub === 'stop') return 'session_stop';
  if (sub === 'archive') return 'session_archive';
  if (sub === 'unarchive') return 'session_unarchive';
  if (sub === 'history') return 'session_history';
  if (sub === 'actions') {
    const actionSub = String(argv[1] ?? '').trim();
    if (actionSub === 'list') return 'session_actions_list';
    if (actionSub === 'describe') return 'session_actions_describe';
    if (actionSub === 'execute') return 'session_actions_execute';
    return 'session_actions_unknown';
  }
  if (sub === 'run') {
    const runSub = String(argv[1] ?? '').trim();
    if (runSub === 'start') return 'session_run_start';
    if (runSub === 'list') return 'session_run_list';
    if (runSub === 'get') return 'session_run_get';
    if (runSub === 'send') return 'session_run_send';
    if (runSub === 'stop') return 'session_run_stop';
    if (runSub === 'action') return 'session_run_action';
    if (runSub === 'wait') return 'session_run_wait';
    if (runSub === 'stream-start') return 'session_run_stream_start';
    if (runSub === 'stream-read') return 'session_run_stream_read';
    if (runSub === 'stream-cancel') return 'session_run_stream_cancel';
    return 'session_run_unknown';
  }
  if (sub === 'review') return 'session_review_start';
  if (sub === 'plan') return 'session_plan_start';
  if (sub === 'delegate') return 'session_delegate_start';
  if (sub === 'voice-agent' || sub === 'voice_agent') return 'session_voice_agent_start';
  return `session_${sub}`;
}

function printSessionHelpLines(lines: readonly string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function normalizeHelpSubcommand(value: string): string {
  return value === 'voice_agent' ? 'voice-agent' : value;
}

function isHelpToken(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

function printSessionSubcommandHelp(argv: readonly string[]): boolean {
  const subcommand = normalizeHelpSubcommand(String(argv[0] ?? '').trim());
  if (!subcommand) return false;

  const nestedSubcommand = normalizeHelpSubcommand(String(argv[1] ?? '').trim());
  if (nestedSubcommand && !isHelpToken(nestedSubcommand)) {
    const nestedHelp = SESSION_NESTED_SUBCOMMAND_HELP_LINES[`${subcommand} ${nestedSubcommand}`];
    if (nestedHelp) {
      console.log(nestedHelp);
      return true;
    }
  }

  const lines = SESSION_SUBCOMMAND_HELP_LINES[subcommand];
  if (!lines) return false;
  printSessionHelpLines(lines);
  return true;
}

export async function handleSessionCommand(
  argv: string[],
  deps?: Readonly<{
    readCredentialsFn?: () => Promise<StoredCredentials | null>;
  }>,
): Promise<void> {
  const json = wantsJson(argv);
  const kind = inferSessionKind(argv);
  const subcommand = String(argv[0] ?? '').trim();
  const hasHelpFlag = hasFlag(argv, '--help') || hasFlag(argv, '-h');

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      printSessionHelpLines(SESSION_TOP_LEVEL_HELP_LINES);
      return;
    }

    if (hasHelpFlag && printSessionSubcommandHelp(argv)) {
      return;
    }

    const readCredentialsFn = deps?.readCredentialsFn ?? (async () => await readStoredCredentials());

    switch (subcommand) {
      case 'list': {
        const { cmdSessionList } = await import('./list');
        await cmdSessionList(argv, { readCredentialsFn });
        return;
      }
      case 'status': {
        const { cmdSessionStatus } = await import('./status');
        await cmdSessionStatus(argv, { readCredentialsFn });
        return;
      }
      case 'create': {
        const { cmdSessionCreate } = await import('./create');
        await cmdSessionCreate(argv, { readCredentialsFn });
        return;
      }
      case 'set-title': {
        const { cmdSessionSetTitle } = await import('./setTitle');
        await cmdSessionSetTitle(argv, { readCredentialsFn });
        return;
      }
      case 'set-permission-mode': {
        const { cmdSessionSetPermissionMode } = await import('./setPermissionMode');
        await cmdSessionSetPermissionMode(argv, { readCredentialsFn });
        return;
      }
      case 'set-model': {
        const { cmdSessionSetModel } = await import('./setModel');
        await cmdSessionSetModel(argv, { readCredentialsFn });
        return;
      }
      case 'send': {
        const { cmdSessionSend } = await import('./send');
        await cmdSessionSend(argv, { readCredentialsFn });
        return;
      }
      case 'wait': {
        const { cmdSessionWait } = await import('./wait');
        await cmdSessionWait(argv, { readCredentialsFn });
        return;
      }
      case 'stop': {
        const { cmdSessionStop } = await import('./stop');
        await cmdSessionStop(argv, { readCredentialsFn });
        return;
      }
      case 'archive': {
        const { cmdSessionArchive } = await import('./archive');
        await cmdSessionArchive(argv, { readCredentialsFn });
        return;
      }
      case 'unarchive': {
        const { cmdSessionUnarchive } = await import('./unarchive');
        await cmdSessionUnarchive(argv, { readCredentialsFn });
        return;
      }
      case 'history': {
        const { cmdSessionHistory } = await import('./history');
        await cmdSessionHistory(argv, { readCredentialsFn });
        return;
      }
      case 'run': {
        const runSub = String(argv[1] ?? '').trim();
        if (!runSub) throw new Error('Usage: happier session run <subcommand> ...');
        if (runSub === 'get') {
          const { cmdSessionRunGet } = await import('./run/get');
          await cmdSessionRunGet(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'list') {
          const { cmdSessionRunList } = await import('./run/list');
          await cmdSessionRunList(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'start') {
          const { cmdSessionRunStart } = await import('./run/start');
          await cmdSessionRunStart(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'send') {
          const { cmdSessionRunSend } = await import('./run/send');
          await cmdSessionRunSend(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stop') {
          const { cmdSessionRunStop } = await import('./run/stop');
          await cmdSessionRunStop(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'action') {
          const { cmdSessionRunAction } = await import('./run/action');
          await cmdSessionRunAction(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'wait') {
          const { cmdSessionRunWait } = await import('./run/wait');
          await cmdSessionRunWait(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-start') {
          const { cmdSessionRunStreamStart } = await import('./run/streamStart');
          await cmdSessionRunStreamStart(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-read') {
          const { cmdSessionRunStreamRead } = await import('./run/streamRead');
          await cmdSessionRunStreamRead(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-cancel') {
          const { cmdSessionRunStreamCancel } = await import('./run/streamCancel');
          await cmdSessionRunStreamCancel(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session run subcommand: ${runSub}`);
      }
      case 'review': {
        const reviewSub = String(argv[1] ?? '').trim();
        if (!reviewSub) throw new Error('Usage: happier session review <subcommand> ...');
        if (reviewSub === 'start') {
          const { cmdSessionReviewStart } = await import('./review/start');
          await cmdSessionReviewStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session review subcommand: ${reviewSub}`);
      }
      case 'plan': {
        const planSub = String(argv[1] ?? '').trim();
        if (!planSub) throw new Error('Usage: happier session plan <subcommand> ...');
        if (planSub === 'start') {
          const { cmdSessionPlanStart } = await import('./plan/start');
          await cmdSessionPlanStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session plan subcommand: ${planSub}`);
      }
      case 'delegate': {
        const delSub = String(argv[1] ?? '').trim();
        if (!delSub) throw new Error('Usage: happier session delegate <subcommand> ...');
        if (delSub === 'start') {
          const { cmdSessionDelegateStart } = await import('./delegate/start');
          await cmdSessionDelegateStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session delegate subcommand: ${delSub}`);
      }
      case 'voice-agent':
      case 'voice_agent': {
        const voiceSub = String(argv[1] ?? '').trim();
        if (!voiceSub) throw new Error('Usage: happier session voice-agent <subcommand> ...');
        if (voiceSub === 'start') {
          const { cmdSessionVoiceAgentStart } = await import('./voiceAgent/start');
          await cmdSessionVoiceAgentStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session voice-agent subcommand: ${voiceSub}`);
      }
      case 'actions': {
        const actionSub = String(argv[1] ?? '').trim();
        if (!actionSub) throw new Error('Usage: happier session actions <subcommand> ...');
        if (actionSub === 'list') {
          const { cmdSessionActionsList } = await import('./actions/list');
          await cmdSessionActionsList(argv, { readCredentialsFn });
          return;
        }
        if (actionSub === 'describe') {
          const { cmdSessionActionsDescribe } = await import('./actions/describe');
          await cmdSessionActionsDescribe(argv, { readCredentialsFn });
          return;
        }
        if (actionSub === 'execute') {
          const { cmdSessionActionsExecute } = await import('./actions/execute');
          await cmdSessionActionsExecute(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session actions subcommand: ${actionSub}`);
      }
      default:
        throw new Error(`Unknown session subcommand: ${subcommand}`);
    }
  } catch (error) {
    if (!json) throw error;
    const mapped = mapUnknownErrorToControlError(error);
    await printJsonEnvelope(
      {
        ok: false,
        kind,
        error: {
          code: mapped.code,
          ...(mapped.message ? { message: mapped.message } : {}),
        },
      },
      { exitCode: mapped.unexpected ? 2 : 1 },
    );
  }
}
