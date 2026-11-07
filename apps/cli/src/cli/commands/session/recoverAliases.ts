import { readFile } from 'node:fs/promises';
import { AGENT_IDS } from '@happier-dev/agents';
import type { Credentials } from '@/persistence';
import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { readNativeSessionAliasSnapshot } from '@/session/services/recoverNativeSessionAliases';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

export const SESSION_RECOVER_ALIASES_USAGE = 'happier session recover-aliases --provider <id> --snapshot <file> --observed-at <epoch-ms> [--machine-id <id>] [--dry-run] [--json]';

export async function cmdSessionRecoverAliases(argv: string[], deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>): Promise<void> {
  const valueFlags = new Set(['--provider', '--snapshot', '--observed-at', '--machine-id']);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run' || argv[index] === '--json') continue;
    if (!valueFlags.has(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(SESSION_RECOVER_ALIASES_USAGE);
    index += 1;
  }
  const providerId = readFlagValue(argv, '--provider') ?? '';
  const snapshotPath = readFlagValue(argv, '--snapshot');
  const observedAt = Number(readFlagValue(argv, '--observed-at'));
  const machineId = readFlagValue(argv, '--machine-id');
  if (!(AGENT_IDS as readonly string[]).includes(providerId) || !snapshotPath || !Number.isSafeInteger(observedAt) || observedAt <= 0 || (hasFlag(argv, '--machine-id') && !machineId)) {
    throw new Error(SESSION_RECOVER_ALIASES_USAGE);
  }
  const json = wantsJson(argv);
  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) { await printJsonEnvelope({ ok: false, kind: 'session_aliases_recover', error: { code: 'not_authenticated' } }); return; }
    throw new Error('Not signed in. Run happier auth login first.');
  }
  const snapshot: unknown = JSON.parse(await readFile(expandHomeDirPath(snapshotPath), 'utf8'));
  const assignments = readNativeSessionAliasSnapshot(snapshot, providerId, observedAt);
  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionResult = await executor.execute('session.aliases.recover', {
    assignments, ...(machineId ? { machineId } : {}), dryRun: hasFlag(argv, '--dry-run'),
  }, { surface: 'cli', defaultSessionId: null });
  const result = normalizeActionExecuteResult(actionResult);
  if (!result.ok) {
    if (json) { await printJsonEnvelope({ ok: false, kind: 'session_aliases_recover', error: { code: result.errorCode, ...(result.errorMessage ? { message: result.errorMessage } : {}) } }); return; }
    throw new Error(result.errorMessage ?? result.errorCode);
  }
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_aliases_recover', json, result: result.data })) return;
  if (json) { await printJsonEnvelope({ ok: true, kind: 'session_aliases_recover', data: result.data }); return; }
  console.log(JSON.stringify(result.data, null, 2));
}
