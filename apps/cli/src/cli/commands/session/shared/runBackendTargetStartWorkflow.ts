import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { parseWorkflowActionCliInput } from '@/cli/actions/workflowActionInput';
import { invalidCommandArguments } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';

import {
  hasBackendTargetSelectionFromCsv,
  resolveBackendTargetKeysFromCsv,
} from './normalizeBackendTargetKeys';
import { normalizeSessionStartActionResults } from './sessionStartActionResults';
import { formatCliActionFailureText, projectCliActionFailure } from './normalizeActionExecuteResult';

/**
 * The one retained "start runs for selected Agent targets" workflow behind
 * `session delegate|plan|voice-agent start`. The workflow owns only what an
 * Action cannot: the Session selector, the exact Machine route, and resolving
 * the typed `--backends` list against the live option catalog. Every Action
 * field — instructions, run shape, model, Team credential, overlays — is parsed
 * by the shared compiled field parser and validated by the Action's own schema.
 */
export type BackendTargetStartWorkflow = Readonly<{
  actionId: 'subagents.delegate.start' | 'subagents.plan.start' | 'voice_agent.start';
  kind: string;
  usageLine: string;
  startedLabel: string;
  /** `--agent` as a spelling of `--backends`, and the instructions positional. */
  delegateSpellings?: boolean;
}>;

const BACKEND_FLAGS = ['--backends', '--backend'] as const;
const MACHINE_ID_FLAG = '--machine-id';

export async function runBackendTargetStartWorkflow(
  workflow: BackendTargetStartWorkflow,
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const usage = `Usage: ${workflow.usageLine}`;
  const backendFlags: readonly string[] = workflow.delegateSpellings
    ? [...BACKEND_FLAGS, '--agent']
    : BACKEND_FLAGS;
  const args = parseWorkflowActionCliInput(argv, {
    actionId: workflow.actionId,
    usage,
    startIndex: 2,
    maxPositionals: workflow.delegateSpellings ? 2 : 1,
    workflowValueFlags: [...backendFlags, MACHINE_ID_FLAG],
    // The established spelling of the retention field (plan §13.3).
    fieldAliases: [{ path: 'retentionPolicy', aliases: ['--retention'] }],
    workflowOwnedFields: ['sessionId', 'backendTargetKeys'],
  });
  const json = wantsJson(argv);
  const [idOrPrefix = '', positionalInstructions] = args.positionals;
  if (!idOrPrefix.trim()) throw invalidCommandArguments(usage, 'Missing Session.');
  if (positionalInstructions !== undefined && args.supplies('instructions')) {
    throw invalidCommandArguments(usage, 'Provide instructions either as an argument or with --instructions, not both.');
  }
  const backendsRaw = backendFlags.map((flag) => args.readWorkflowValue(flag)).find((value) => value !== null) ?? null;
  const selectsBackends = hasBackendTargetSelectionFromCsv(backendsRaw);
  if (!selectsBackends && !args.supplies('backendTargetKeys')) throw invalidCommandArguments(usage, 'Missing --backends.');
  if (!positionalInstructions?.trim() && !args.supplies('instructions')) {
    throw invalidCommandArguments(usage, 'Missing instructions.');
  }
  const machineId = args.readWorkflowValue(MACHINE_ID_FLAG);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: workflow.kind, error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: workflow.kind,
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const composed = args.compose({
    ...(selectsBackends
      ? {
          backendTargetKeys: await resolveBackendTargetKeysFromCsv({
            value: backendsRaw,
            actionId: workflow.actionId,
            sessionId,
            executor,
          }),
        }
      : {}),
    ...(positionalInstructions !== undefined ? { instructions: positionalInstructions } : {}),
  });
  if (!composed.ok) throw invalidCommandArguments(usage, composed.message);
  const started = await executor.execute(workflow.actionId, composed.input, {
    defaultSessionId: sessionId,
  });
  const normalized = normalizeSessionStartActionResults(started);

  if (!normalized.ok) {
    const failure = projectCliActionFailure(normalized);
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: workflow.kind,
        error: failure,
      });
      return;
    }
    console.error(chalk.red('Error:'), formatCliActionFailureText(undefined, normalized));
    process.exit(1);
  }

  const results = normalized.results;
  if (json) {
    await printJsonEnvelope({ ok: true, kind: workflow.kind, data: { sessionId, results } });
    return;
  }

  console.log(chalk.green('✓'), workflow.startedLabel);
  await writeJsonStdout({ sessionId, results }, { pretty: true });
}
