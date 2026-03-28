import { readCredentials, type Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { hasFlag } from '@/cli/commands/shared/argvFlags';

import { cmdSessionList } from './list';
import { cmdSessionHistory } from './history';
import { cmdSessionStatus } from './status';
import { cmdSessionCreate } from './create';
import { cmdSessionSend } from './send';
import { cmdSessionWait } from './wait';
import { cmdSessionStop } from './stop';
import { cmdSessionArchive } from './archive';
import { cmdSessionUnarchive } from './unarchive';
import { cmdSessionSetTitle } from './setTitle';
import { cmdSessionSetPermissionMode } from './setPermissionMode';
import { cmdSessionSetModel } from './setModel';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { cmdSessionRunGet } from './run/get';
import { cmdSessionRunList } from './run/list';
import { cmdSessionRunStart } from './run/start';
import { cmdSessionRunSend } from './run/send';
import { cmdSessionRunStop } from './run/stop';
import { cmdSessionRunAction } from './run/action';
import { cmdSessionRunWait } from './run/wait';
import { cmdSessionRunStreamStart } from './run/streamStart';
import { cmdSessionRunStreamRead } from './run/streamRead';
import { cmdSessionRunStreamCancel } from './run/streamCancel';
import { cmdSessionReviewStart } from './review/start';
import { cmdSessionPlanStart } from './plan/start';
import { cmdSessionDelegateStart } from './delegate/start';
import { cmdSessionVoiceAgentStart } from './voiceAgent/start';
import { cmdSessionActionsList } from './actions/list';
import { cmdSessionActionsDescribe } from './actions/describe';
import { cmdSessionActionsExecute } from './actions/execute';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';

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

function printSessionSubcommandHelp(subcommand: string): boolean {
  switch (subcommand) {
    case 'list':
      console.log('happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
      return true;
    case 'status':
      console.log('happier session status <session-id-or-prefix> [--live] [--json]');
      return true;
    case 'create':
      console.log('happier session create [--path <path>] [--backend <backend-target>] [--title <title>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]');
      return true;
    case 'send':
      console.log('happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      return true;
    case 'set-title':
      console.log('happier session set-title <session-id-or-prefix> <title> [--json]');
      return true;
    case 'set-permission-mode':
      console.log('happier session set-permission-mode <session-id-or-prefix> <mode> [--json]');
      return true;
    case 'set-model':
      console.log('happier session set-model <session-id-or-prefix> <model-id> [--json]');
      return true;
    default:
      return false;
  }
}

export async function handleSessionCommand(
  argv: string[],
  deps?: Readonly<{
    readCredentialsFn?: () => Promise<Credentials | null>;
  }>,
): Promise<void> {
  const json = wantsJson(argv);
  const kind = inferSessionKind(argv);
  const subcommand = String(argv[0] ?? '').trim();
  const hasHelpFlag = hasFlag(argv, '--help') || hasFlag(argv, '-h');

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      console.log('happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
      console.log('happier session status <session-id-or-prefix> [--live] [--json]');
      console.log('happier session create [--path <path>] [--backend <backend-target>] [--tag <tag>] [--title <title>] [--prompt <text>|--message <text>] [--json]');
      console.log('happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      console.log('happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
      console.log('happier session stop <session-id-or-prefix> [--json]');
      console.log('happier session history <session-id-or-prefix> [--limit N] [--format compact|raw] [--include-meta] [--include-structured-payload] [--json]');
      console.log('happier session set-title <session-id-or-prefix> <title> [--json]');
      console.log('happier session set-permission-mode <session-id-or-prefix> <mode> [--json]');
      console.log('happier session set-model <session-id-or-prefix> <model-id> [--json]');
      console.log('happier session archive <session-id-or-prefix> [--json]');
      console.log('happier session unarchive <session-id-or-prefix> [--json]');
      console.log('happier session review start <session-id> --engines <id1,id2> --instructions <text> [--json]');
      console.log('happier session plan start <session-id> --backends <id1,id2> --instructions <text> [--json]');
      console.log('happier session delegate start <session-id> --backends <id1,id2> --instructions <text> [--json]');
      console.log('happier session voice-agent start <session-id> --backends <id1,id2> --instructions <text> [--json]');
      console.log('happier session actions list [--json]');
      console.log('happier session actions describe <action-id> [--json]');
      console.log('happier session actions execute <session-id> <action-id> [--input-json <json>] [--json]');
      console.log('happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
      console.log('happier session run list <session-id> [--json]');
      console.log('happier session run get <session-id> <run-id> [--include-structured] [--json]');
      console.log('happier session run send <session-id> <run-id> <message> [--resume] [--json]');
      console.log('happier session run stop <session-id> <run-id> [--json]');
      console.log('happier session run action <session-id> <run-id> <action-id> [--input-json <json>] [--json]');
      console.log('happier session run wait <session-id> <run-id> [--timeout <seconds>] [--json]');
      console.log('happier session run stream-start <session-id> <run-id> <message> [--resume] [--json]');
      console.log('happier session run stream-read <session-id> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]');
      console.log('happier session run stream-cancel <session-id> <run-id> <stream-id> [--json]');
      return;
    }

    if (hasHelpFlag && printSessionSubcommandHelp(subcommand)) {
      return;
    }

    const baseReadCredentialsFn = deps?.readCredentialsFn ?? (async () => await readCredentials());
    const readCredentialsFn = async () => {
      const credentials = await baseReadCredentialsFn();
      if (!credentials) return credentials;

      try {
        await bootstrapAccountSettingsContext({
          credentials,
          mode: 'blocking',
          refresh: 'force',
        });
      } catch {
        // Best-effort: session control commands should still work when
        // account settings are unavailable (offline / older servers).
      }

      return credentials;
    };

    switch (subcommand) {
      case 'list':
        await cmdSessionList(argv, { readCredentialsFn });
        return;
      case 'status':
        await cmdSessionStatus(argv, { readCredentialsFn });
        return;
      case 'create':
        await cmdSessionCreate(argv, { readCredentialsFn });
        return;
      case 'set-title':
        await cmdSessionSetTitle(argv, { readCredentialsFn });
        return;
      case 'set-permission-mode':
        await cmdSessionSetPermissionMode(argv, { readCredentialsFn });
        return;
      case 'set-model':
        await cmdSessionSetModel(argv, { readCredentialsFn });
        return;
      case 'send':
        await cmdSessionSend(argv, { readCredentialsFn });
        return;
      case 'wait':
        await cmdSessionWait(argv, { readCredentialsFn });
        return;
      case 'stop':
        await cmdSessionStop(argv, { readCredentialsFn });
        return;
      case 'archive':
        await cmdSessionArchive(argv, { readCredentialsFn });
        return;
      case 'unarchive':
        await cmdSessionUnarchive(argv, { readCredentialsFn });
        return;
      case 'history':
        await cmdSessionHistory(argv, { readCredentialsFn });
        return;
      case 'run': {
        const runSub = String(argv[1] ?? '').trim();
        if (!runSub) throw new Error('Usage: happier session run <subcommand> ...');
        if (runSub === 'get') {
          await cmdSessionRunGet(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'list') {
          await cmdSessionRunList(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'start') {
          await cmdSessionRunStart(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'send') {
          await cmdSessionRunSend(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stop') {
          await cmdSessionRunStop(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'action') {
          await cmdSessionRunAction(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'wait') {
          await cmdSessionRunWait(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-start') {
          await cmdSessionRunStreamStart(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-read') {
          await cmdSessionRunStreamRead(argv, { readCredentialsFn });
          return;
        }
        if (runSub === 'stream-cancel') {
          await cmdSessionRunStreamCancel(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session run subcommand: ${runSub}`);
      }
      case 'review': {
        const reviewSub = String(argv[1] ?? '').trim();
        if (!reviewSub) throw new Error('Usage: happier session review <subcommand> ...');
        if (reviewSub === 'start') {
          await cmdSessionReviewStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session review subcommand: ${reviewSub}`);
      }
      case 'plan': {
        const planSub = String(argv[1] ?? '').trim();
        if (!planSub) throw new Error('Usage: happier session plan <subcommand> ...');
        if (planSub === 'start') {
          await cmdSessionPlanStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session plan subcommand: ${planSub}`);
      }
      case 'delegate': {
        const delSub = String(argv[1] ?? '').trim();
        if (!delSub) throw new Error('Usage: happier session delegate <subcommand> ...');
        if (delSub === 'start') {
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
          await cmdSessionVoiceAgentStart(argv, { readCredentialsFn });
          return;
        }
        throw new Error(`Unknown session voice-agent subcommand: ${voiceSub}`);
      }
      case 'actions': {
        const actionSub = String(argv[1] ?? '').trim();
        if (!actionSub) throw new Error('Usage: happier session actions <subcommand> ...');
        if (actionSub === 'list') {
          await cmdSessionActionsList(argv);
          return;
        }
        if (actionSub === 'describe') {
          await cmdSessionActionsDescribe(argv);
          return;
        }
        if (actionSub === 'execute') {
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
    printJsonEnvelope(
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
