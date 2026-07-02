import { normalizePiThinkingLevel } from '../../../protocol/thinking.js';
import { buildPiToolsForPermissionMode } from './permissions.js';
import type { PiPermissionMode } from './types.js';

export function buildPiRpcArgs(opts?: Readonly<{
  permissionMode?: PiPermissionMode;
  thinkingLevel?: string | null;
  resumeSessionId?: string | null;
}>): readonly string[] {
  const args: string[] = [
    '--mode',
    'rpc',
    '--tools',
    buildPiToolsForPermissionMode(opts?.permissionMode).join(','),
  ];
  const thinking = normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  const resumeSessionId = typeof opts?.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
  if (resumeSessionId) args.push('--session', resumeSessionId);
  return args;
}
