import { readCredentials, type Credentials } from '@/persistence';

import { cmdSessionList } from './list';
import { cmdSessionHistory } from './history';
import { cmdSessionStatus } from './status';
import { cmdSessionCreate } from './create';
import { cmdSessionSend } from './send';
import { cmdSessionWait } from './wait';
import { cmdSessionStop } from './stop';
import { cmdSessionRunGet } from './run/get';
import { cmdSessionRunList } from './run/list';
import { cmdSessionRunStart } from './run/start';
import { cmdSessionRunSend } from './run/send';
import { cmdSessionRunStop } from './run/stop';
import { cmdSessionRunAction } from './run/action';
import { cmdSessionRunWait } from './run/wait';
import { cmdSessionReviewStart } from './review/start';
import { cmdSessionPlanStart } from './plan/start';
import { cmdSessionDelegateStart } from './delegate/start';
import { cmdSessionVoiceAgentStart } from './voiceAgent/start';
import { cmdSessionActionsList } from './actions/list';
import { cmdSessionActionsDescribe } from './actions/describe';

export async function handleSessionCommand(
  argv: string[],
  deps?: Readonly<{
    readCredentialsFn?: () => Promise<Credentials | null>;
  }>,
): Promise<void> {
  const subcommand = String(argv[0] ?? '').trim();
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log('happier session list [--active] [--limit N] [--cursor C] [--json]');
    console.log('happier session history <session-id> [--limit N] [--format compact|raw] [--include-meta] [--include-structured-payload] [--json]');
    console.log('happier session review start <session-id> --engines <id1,id2> --instructions <text> [--json]');
    console.log('happier session plan start <session-id> --backends <id1,id2> --instructions <text> [--json]');
    console.log('happier session delegate start <session-id> --backends <id1,id2> --instructions <text> [--json]');
    console.log('happier session voice-agent start <session-id> --backends <id1,id2> --instructions <text> [--json]');
    console.log('happier session actions list [--json]');
    console.log('happier session actions describe <action-id> [--json]');
    console.log('happier session run list <session-id> [--json]');
    console.log('happier session run get <session-id> <run-id> [--include-structured] [--json]');
    return;
  }

  const readCredentialsFn = deps?.readCredentialsFn ?? (async () => await readCredentials());

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
    case 'send':
      await cmdSessionSend(argv, { readCredentialsFn });
      return;
    case 'wait':
      await cmdSessionWait(argv, { readCredentialsFn });
      return;
    case 'stop':
      await cmdSessionStop(argv, { readCredentialsFn });
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
      throw new Error(`Unknown session actions subcommand: ${actionSub}`);
    }
    default:
      throw new Error(`Unknown session subcommand: ${subcommand}`);
  }
}
