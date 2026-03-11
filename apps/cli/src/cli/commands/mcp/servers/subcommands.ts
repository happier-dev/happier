import type { McpCommandDeps } from '../deps';

import { cmdMcpServersAdd } from './add';
import { cmdMcpServersBind } from './bind';
import { cmdMcpServersDetect } from './detect';
import { cmdMcpServersList } from './list';
import { cmdMcpServersTest } from './test';
import { cmdMcpServersUnbind } from './unbind';

export async function runMcpServersSubcommand(
  subcommand: string,
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<boolean> {
  const trimmed = String(subcommand ?? '').trim();
  if (!trimmed) return false;

  if (trimmed === 'list') {
    await cmdMcpServersList(argv, deps, opts);
    return true;
  }
  if (trimmed === 'add') {
    await cmdMcpServersAdd(argv, deps, opts);
    return true;
  }
  if (trimmed === 'bind') {
    await cmdMcpServersBind(argv, deps, opts);
    return true;
  }
  if (trimmed === 'unbind') {
    await cmdMcpServersUnbind(argv, deps, opts);
    return true;
  }
  if (trimmed === 'detect') {
    await cmdMcpServersDetect(argv, deps, opts);
    return true;
  }
  if (trimmed === 'test') {
    await cmdMcpServersTest(argv, deps, opts);
    return true;
  }

  return false;
}

