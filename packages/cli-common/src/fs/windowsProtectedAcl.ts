import { execFile, spawnSync } from 'node:child_process';

export type WindowsProtectedPathKind = 'directory' | 'file';

export type WindowsProtectedAclCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type WindowsProtectedAclCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<WindowsProtectedAclCommandResult>;

export type WindowsProtectedAclCommandRunnerSync = (
  command: string,
  args: readonly string[],
) => WindowsProtectedAclCommandResult;

export type WindowsProtectedAclBoundary = Readonly<{
  applyAndVerify(input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>): Promise<void>;
  verify(input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>): Promise<void>;
}>;

export type WindowsProtectedAclBoundarySync = Readonly<{
  applyAndVerify(input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>): void;
  verify(input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>): void;
}>;

type WindowsAclSnapshot = Readonly<{
  ownerSid: string;
  protected: boolean;
  reparsePoint: boolean;
  rules: readonly Readonly<{
    sid: string;
    type: string;
    inherited: boolean;
    rights: string;
  }>[];
}>;

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_SID_PATTERN = /^S-\d(?:-\d+)+$/u;
const WINDOWS_ACL_INSPECTION_SCRIPT = [
  '& {',
  'param([string]$Path)',
  '$acl = Get-Acl -LiteralPath $Path -ErrorAction Stop',
  '$attributes = [System.IO.File]::GetAttributes($Path)',
  '$rules = @($acl.Access | ForEach-Object {',
  '  [pscustomobject]@{',
  '    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
  '    type = $_.AccessControlType.ToString()',
  '    inherited = $_.IsInherited',
  '    rights = $_.FileSystemRights.ToString()',
  '  }',
  '})',
  '[pscustomobject]@{',
  '  ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
  '  protected = $acl.AreAccessRulesProtected',
  '  reparsePoint = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)',
  '  rules = $rules',
  '} | ConvertTo-Json -Depth 5 -Compress',
  '} ',
].join('\n');

function defaultRunCommand(command: string, args: readonly string[]): Promise<WindowsProtectedAclCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(`Windows protected ACL command could not start: ${command}`));
        return;
      }
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function defaultRunCommandSync(command: string, args: readonly string[]): WindowsProtectedAclCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Windows protected ACL command could not start: ${command}`);
  }
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function parseCurrentUserSid(stdout: string): string {
  const match = stdout.match(/S-\d(?:-\d+)+/u);
  if (!match || !WINDOWS_SID_PATTERN.test(match[0])) {
    throw new Error('Unable to resolve the current Windows user SID');
  }
  return match[0];
}

function parseWindowsAclSnapshot(stdout: string): WindowsAclSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Windows protected ACL verification returned invalid JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Windows protected ACL verification returned an invalid snapshot');
  }
  const candidate = value as Partial<WindowsAclSnapshot>;
  if (
    typeof candidate.ownerSid !== 'string'
    || typeof candidate.protected !== 'boolean'
    || typeof candidate.reparsePoint !== 'boolean'
    || !Array.isArray(candidate.rules)
  ) {
    throw new Error('Windows protected ACL verification returned an invalid snapshot');
  }
  for (const rule of candidate.rules) {
    if (
      typeof rule !== 'object'
      || rule === null
      || typeof rule.sid !== 'string'
      || typeof rule.type !== 'string'
      || typeof rule.inherited !== 'boolean'
      || typeof rule.rights !== 'string'
    ) {
      throw new Error('Windows protected ACL verification returned an invalid rule');
    }
  }
  return candidate as WindowsAclSnapshot;
}

function verifyWindowsAclSnapshot(snapshot: WindowsAclSnapshot, currentUserSid: string): void {
  if (snapshot.ownerSid !== currentUserSid) throw new Error('Windows protected path has an unexpected owner SID');
  if (!snapshot.protected) throw new Error('Windows protected path still inherits ACL entries');
  if (snapshot.reparsePoint) throw new Error('Windows protected path must not be a reparse point');
  if (snapshot.rules.length !== 2) throw new Error('Windows protected path has unexpected ACL entries');

  const expectedSids = new Set([currentUserSid, LOCAL_SYSTEM_SID]);
  for (const rule of snapshot.rules) {
    if (
      !expectedSids.delete(rule.sid)
      || rule.type !== 'Allow'
      || rule.inherited
      || rule.rights !== 'FullControl'
    ) {
      throw new Error('Windows protected path has an unsafe ACL entry');
    }
  }
  if (expectedSids.size !== 0) throw new Error('Windows protected path is missing a required ACL entry');
}

function applyArgs(input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>, sid: string): string[] {
  const inheritance = input.kind === 'directory' ? '(OI)(CI)' : '';
  return [
    input.path,
    '/inheritancelevel:r',
    '/grant:r',
    `*${sid}:${inheritance}F`,
    `*${LOCAL_SYSTEM_SID}:${inheritance}F`,
  ];
}

function inspectionArgs(path: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_INSPECTION_SCRIPT, path];
}

export function createWindowsProtectedAclBoundary(params: Readonly<{
  runCommand?: WindowsProtectedAclCommandRunner;
}> = {}): WindowsProtectedAclBoundary {
  const runCommand = params.runCommand ?? defaultRunCommand;
  let currentUserSidPromise: Promise<string> | null = null;
  const runChecked = async (command: string, args: readonly string[]) => {
    const result = await runCommand(command, args);
    if (result.exitCode !== 0) throw new Error(`Windows protected ACL command failed: ${command}`);
    return result;
  };
  const resolveSid = () => currentUserSidPromise ??= runChecked('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
    .then((result) => parseCurrentUserSid(result.stdout));
  const verify = async (input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>) => {
    const sid = await resolveSid();
    const result = await runChecked('powershell.exe', inspectionArgs(input.path));
    verifyWindowsAclSnapshot(parseWindowsAclSnapshot(result.stdout), sid);
  };
  return Object.freeze({
    async applyAndVerify(input) {
      const sid = await resolveSid();
      await runChecked('icacls.exe', [input.path, '/setowner', `*${sid}`]);
      await runChecked('icacls.exe', applyArgs(input, sid));
      await verify(input);
    },
    verify,
  });
}

export function createWindowsProtectedAclBoundarySync(params: Readonly<{
  runCommand?: WindowsProtectedAclCommandRunnerSync;
}> = {}): WindowsProtectedAclBoundarySync {
  const runCommand = params.runCommand ?? defaultRunCommandSync;
  let currentUserSid: string | null = null;
  const runChecked = (command: string, args: readonly string[]) => {
    const result = runCommand(command, args);
    if (result.exitCode !== 0) throw new Error(`Windows protected ACL command failed: ${command}`);
    return result;
  };
  const resolveSid = () => currentUserSid ??= parseCurrentUserSid(
    runChecked('whoami.exe', ['/user', '/fo', 'csv', '/nh']).stdout,
  );
  const verify = (input: Readonly<{ path: string; kind: WindowsProtectedPathKind }>) => {
    const sid = resolveSid();
    const result = runChecked('powershell.exe', inspectionArgs(input.path));
    verifyWindowsAclSnapshot(parseWindowsAclSnapshot(result.stdout), sid);
  };
  return Object.freeze({
    applyAndVerify(input) {
      const sid = resolveSid();
      runChecked('icacls.exe', [input.path, '/setowner', `*${sid}`]);
      runChecked('icacls.exe', applyArgs(input, sid));
      verify(input);
    },
    verify,
  });
}
