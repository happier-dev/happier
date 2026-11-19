import { normalizeHelpSubcommand, isHelpToken, buildSessionTopLevelHelpLines, readCompiledSessionSubcommandHelp, readSessionSubcommandHelp } from './help';
import { inferSessionKind, emitSessionHelp } from './shared/sessionHelpOutput';
export { inferSessionKind, emitSessionHelp } from './shared/sessionHelpOutput';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { hasFlag, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { resolveAdmittedActionCliCommand } from '@/cli/commandRegistry';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { normalizeCliActionThrownError, projectCliActionFailure } from './shared/normalizeActionExecuteResult';
import {
  SESSION_HELP_LINES,
  SESSION_NESTED_SUBCOMMAND_HELP_LINES,
  SESSION_SUBCOMMAND_HELP_LINES,
  SESSION_TOP_LEVEL_HELP_LINES,
} from './shared/sessionCommandUsage';


/**
 * Emits usage for one invocation.
 *
 * `--json` is a machine-output contract: stdout carries the versioned envelope
 * and nothing else. Help is a RESULT of the invocation, so in JSON mode it
 * travels inside that envelope rather than being printed beside it — otherwise
 * the first thing a script probes with is the one shape its parser rejects.
 */



/**
 * The `happier session` index: dedicated workflow rows from the usage table plus
 * one generated row for every compiled Action command under this root. A leaf
 * that migrated to the compiler is documented from that same descriptor, so the
 * table cannot restate a grammar the parser no longer accepts, and a dispatchable
 * path is never missing from help.
 */

/** The compiled rows nested under `happier session <subcommand> …`. */

/** The usage this argv asks for, or `null` when no subcommand owns one. */

export async function handleSessionCommand(
  argv: string[],
  deps?: Readonly<{
    readCredentialsFn?: () => Promise<StoredCredentials | null>;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  const json = wantsJson(argv);
  const structuredOutput = json || hasFlag(argv, '--jsonl');
  const kind = inferSessionKind(argv);
  const subcommand = String(argv[0] ?? '').trim();
  const hasHelpFlag = hasFlag(argv, '--help') || hasFlag(argv, '-h');

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      await emitSessionHelp({ help: await buildSessionTopLevelHelpLines(), json, kind: 'session_help' });
      return;
    }

    const readCredentialsFn = deps?.readCredentialsFn ?? (async () => await readStoredCredentials());

    // Root dispatch already resolves a migrated leaf before this handler runs.
    // Nested callers reach the same compiled owner here, so a migrated command
    // has exactly one parser, one binder, one help page and one Action
    // invocation regardless of which entry point named it. There is no
    // per-command branch and no fallback: an unmigrated spelling simply is not a
    // compiled path.
    const compiledArgv = ['session', ...argv];
    // History is deliberately a retained multi-step workflow (snapshot/follow/
    // release), not an Action-owned one-shot command. Do not make its argument
    // validation or help wait for the dynamic Action/plugin catalog only to
    // discover that the dedicated path is excluded there.
    const compiledCommand = subcommand === 'history'
      ? null
      : await resolveAdmittedActionCliCommand(compiledArgv);
    if (compiledCommand) {
      const { runCompiledActionCliCommand } = await import('@/cli/actions/executeCommand');
      await runCompiledActionCliCommand({
        command: compiledCommand,
        argv: compiledArgv,
        deps: { readCredentialsFn },
        ...(deps?.signal ? { signal: deps.signal } : {}),
      });
      return;
    }

    if (hasHelpFlag) {
      const dedicatedHelp = readSessionSubcommandHelp(argv);
      const compiledHelp = await readCompiledSessionSubcommandHelp(normalizeHelpSubcommand(subcommand));
      const dedicatedRows = dedicatedHelp === null
        ? []
        : typeof dedicatedHelp === 'string' ? [dedicatedHelp] : [...dedicatedHelp];
      const subcommandHelp = [...dedicatedRows, ...(compiledHelp ?? [])];
      if (subcommandHelp.length > 0) {
        await emitSessionHelp({ help: subcommandHelp, json, kind });
        return;
      }
    }

    switch (subcommand) {
      case 'create': {
        const { cmdSessionCreate } = await import('./create');
        await cmdSessionCreate(argv, { readCredentialsFn, ...(deps?.signal ? { signal: deps.signal } : {}) });
        return;
      }
      case 'history': {
        // Reject the required selector before loading the comparatively broad
        // transcript/follow implementation. This keeps malformed invocations
        // local and guarantees they cannot reach credential or runtime setup.
        const historyPositionals = readCommandPositionals(argv, {
          startIndex: 1,
          valueFlags: ['--tail', '--limit', '--format', '--machine-id'],
        });
        if (!historyPositionals[0]) {
          throw Object.assign(new Error(`Usage: ${SESSION_HELP_LINES.history}`), {
            code: 'invalid_arguments',
            expectedFailure: true,
          });
        }
        const { cmdSessionHistory } = await import('./history');
        await cmdSessionHistory(argv, { readCredentialsFn, ...(deps?.signal ? { signal: deps.signal } : {}) });
        return;
      }
      case 'run': {
        const runSub = String(argv[1] ?? '').trim();
        if (!runSub) throw new Error('Usage: happier session run <subcommand> ...');
        if (runSub === 'action') {
          const { cmdSessionRunAction } = await import('./run/action');
          await cmdSessionRunAction(argv, { readCredentialsFn });
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
    if (!structuredOutput) throw error;
    const { failure, unexpected } = normalizeCliActionThrownError(error);
    await printJsonEnvelope(
      {
        ok: false,
        kind,
        error: projectCliActionFailure(failure),
      },
      { exitCode: unexpected ? 2 : 1 },
    );
  }
}
