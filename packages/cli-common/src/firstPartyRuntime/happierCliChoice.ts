import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveFirstPartyInstallHomeDir } from './installLayout.js';

/**
 * Which Happier CLI this computer runs (plan R12): the one this app installs and keeps first on
 * PATH (`managed`), or a `happier` the user installed themselves (`own`, with the path of that CLI).
 *
 * One answer per Happier home, recorded beside the managed layout's other records
 * (`current.version`, `default-cli-release-channel.json`), so every Happier app on this computer and
 * every bootstrap task resolves the same CLI. No record means nobody was asked: a computer with no
 * other `happier` keeps the managed default without a question.
 */
export type HappierCliChoice =
  | Readonly<{ mode: 'managed' }>
  | Readonly<{ mode: 'own'; command: string }>;

export function resolveHappierCliChoiceStatePath(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
}> = {}): string {
  return joinPathForPathShape(resolveFirstPartyInstallHomeDir(params.processEnv ?? process.env), 'cli-choice.json');
}

function parseHappierCliChoice(raw: string): HappierCliChoice | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.mode === 'managed') return { mode: 'managed' };
  const command = typeof record.command === 'string' ? record.command.trim() : '';
  return record.mode === 'own' && command ? { mode: 'own', command } : null;
}

/** The recorded choice; `null` when none was recorded or the record cannot be read as one. */
export function readHappierCliChoiceSync(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
}> = {}): HappierCliChoice | null {
  try {
    return parseHappierCliChoice(readFileSync(resolveHappierCliChoiceStatePath(params), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeHappierCliChoice(params: Readonly<{
  choice: HappierCliChoice;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  const statePath = resolveHappierCliChoiceStatePath(params);
  const payload = params.choice.mode === 'own'
    ? { mode: 'own', command: params.choice.command }
    : { mode: 'managed' };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(payload)}\n`, 'utf8');
}
