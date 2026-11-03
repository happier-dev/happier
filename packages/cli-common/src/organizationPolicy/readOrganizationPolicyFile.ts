import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { parseOrganizationPolicyV1, type OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { resolveWindowsProgramFiles } from './windowsProgramFiles.js';

export function resolveOrganizationPolicyFilePath(platform: NodeJS.Platform, resolveProgramFiles: () => string = resolveWindowsProgramFiles): string {
  switch (platform) {
    case 'darwin': return '/Library/Application Support/Happier/policy.json';
    case 'linux': return '/etc/happier/policy.json';
    case 'win32': return win32.join(resolveProgramFiles(), 'Happier', 'policy.json');
    default: throw new Error('policy_platform_unavailable');
  }
}

/** One read, no preliminary stat: ENOENT is the only unmanaged file outcome. */
export function loadOrganizationPolicy(deps: Readonly<{
  platform: NodeJS.Platform;
  readFile: (path: string) => Uint8Array;
  resolveProgramFiles: () => string;
}> = { platform: process.platform, readFile: readFileSync, resolveProgramFiles: resolveWindowsProgramFiles }): OrganizationPolicyLoadResult {
  let path: string;
  try { path = resolveOrganizationPolicyFilePath(deps.platform, deps.resolveProgramFiles); }
  catch { return { status: 'invalid', error: { path: '$', code: 'path_unavailable' } }; }
  let bytes: Uint8Array;
  try { bytes = deps.readFile(path); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', error: { path, code: 'file_unreadable' } };
  }
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { status: 'invalid', error: { path, code: 'invalid_utf8' } }; }
  return parseOrganizationPolicyV1(raw);
}
