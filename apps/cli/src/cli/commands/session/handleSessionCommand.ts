import { readCredentials, type Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { hasFlag } from '@/cli/commands/shared/argvFlags';

import { cmdSessionList } from './list';
import { cmdSessionHistory } from './history';
import { cmdSessionStatus } from './status';
import { cmdSessionCreate } from './create';
import { SESSION_CREATE_USAGE } from './create/parseSessionCreateSpawnOptions';
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

const SESSION_HELP_BY_COMMAND = {
  list: 'happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]',
  status: 'happier session status <session-id-or-prefix> [--live] [--json]',
  create: SESSION_CREATE_USAGE,
  send: 'happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]',
  wait: 'happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]',
  stop: 'happier session stop <session-id-or-prefix> [--json]',
  history: 'happier session history <session-id-or-prefix> [--limit N] [--format compact|raw] [--include-meta] [--include-structured-payload] [--json]',
  'set-title': 'happier session set-title <session-id-or-prefix> <title> [--json]',
  'set-permission-mode': 'happier session set-permission-mode <session-id-or-prefix> <mode> [--json]',
  'set-model': 'happier session set-model <session-id-or-prefix> <model-id> [--json]',
  archive: 'happier session archive <session-id-or-prefix> [--json]',
  unarchive: 'happier session unarchive <session-id-or-prefix> [--json]',
  'review start': 'happier session review start <session-id> --engines <id1,id2> [--instructions <text>] [--json]',
  'plan start': 'happier session plan start <session-id> --backends <id1,id2> --instructions <text> [--json]',
  'delegate start': 'happier session delegate start <session-id> --backends <id1,id2> --instructions <text> [--json]',
  'voice-agent start': 'happier session voice-agent start <session-id> --backends <id1,id2> --instructions <text> [--json]',
  'actions list': 'happier session actions list [--json]',
  'actions describe': 'happier session actions describe <action-id> [--json]',
  'actions execute': 'happier session actions execute <session-id> <action-id> [--input-json <json>] [--action-request-id <id>] [--resume-action-request] [--json]',
  'run start': 'happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]',
  'run list': 'happier session run list <session-id> [--json]',
  'run get': 'happier session run get <session-id> <run-id> [--include-structured] [--json]',
  'run send': 'happier session run send <session-id> <run-id> <message> [--resume] [--json]',
  'run stop': 'happier session run stop <session-id> <run-id> [--json]',
  'run action': 'happier session run action <session-id> <run-id> <action-id> [--input-json <json>] [--json]',
  'run wait': 'happier session run wait <session-id> <run-id> [--timeout <seconds>] [--json]',
  'run stream-start': 'happier session run stream-start <session-id> <run-id> <message> [--resume] [--json]',
  'run stream-read': 'happier session run stream-read <session-id> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]',
  'run stream-cancel': 'happier session run stream-cancel <session-id> <run-id> <stream-id> [--json]',
} as const;

const SESSION_HELP_GROUPS: Readonly<Record<string, readonly (keyof typeof SESSION_HELP_BY_COMMAND)[]>> = {
  review: ['review start'],
  plan: ['plan start'],
  delegate: ['delegate start'],
  'voice-agent': ['voice-agent start'],
  actions: ['actions list', 'actions describe', 'actions execute'],
  run: [
    'run start',
    'run list',
    'run get',
    'run send',
    'run stop',
    'run action',
    'run wait',
    'run stream-start',
    'run stream-read',
    'run stream-cancel',
  ],
};

function printSessionHelp(argv: readonly string[]): boolean {
  const rawSubcommand = String(argv[0] ?? '').trim();
  const subcommand = rawSubcommand === 'voice_agent' ? 'voice-agent' : rawSubcommand;
  const isTopLevelHelp = !subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h';
  if (isTopLevelHelp) {
    for (const usage of Object.values(SESSION_HELP_BY_COMMAND)) console.log(usage);
    return true;
  }

  if (!hasFlag(argv, '--help') && !hasFlag(argv, '-h')) return false;

  const nested = String(argv[1] ?? '').trim();
  const groupedCommands = SESSION_HELP_GROUPS[subcommand];
  if (groupedCommands) {
    const command = nested && nested !== '--help' && nested !== '-h'
      ? `${subcommand} ${nested}`
      : null;
    const commands = command && command in SESSION_HELP_BY_COMMAND
      ? [command as keyof typeof SESSION_HELP_BY_COMMAND]
      : groupedCommands;
    for (const key of commands) console.log(SESSION_HELP_BY_COMMAND[key]);
    return true;
  }

  if (subcommand in SESSION_HELP_BY_COMMAND) {
    console.log(SESSION_HELP_BY_COMMAND[subcommand as keyof typeof SESSION_HELP_BY_COMMAND]);
    return true;
  }

  return false;
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

  try {
    if (printSessionHelp(argv)) return;

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
