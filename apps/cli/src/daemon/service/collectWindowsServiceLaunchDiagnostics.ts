import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  parseWindowsScheduledTaskStatusPowerShellJson,
} from '@happier-dev/cli-common/service';

/**
 * Collect post-mortem diagnostics for a Windows scheduled-task daemon launch
 * that *should* have produced a running daemon but didn't. Used by
 * `assertExpectedDaemonServiceOwnership` to enrich the otherwise-opaque
 * "service did not become the active daemon within Xms" timeout with the
 * actual reason the wrapper exited.
 *
 * Three signals are queried, all best-effort — if anything is missing we
 * return a partial result rather than throw:
 *
 * - PowerShell's ScheduledTasks API for the task: last run time, last result
 *   exit code, current state, and the action arguments. `LastTaskResult` is
 *   the smoking gun — Windows surfaces the wrapper's exit code there before
 *   the daemon ever has a chance to claim relay ownership. Localized
 *   `schtasks` text is only used as a fallback.
 * - Tail of the wrapper's stderr log (where any pre-redirection failure
 *   like `MODULE_NOT_FOUND` or PowerShell `$ErrorActionPreference = "Stop"`
 *   crashes get written, after a successful start).
 * - Tail of the wrapper's stdout log (the daemon's own structured log lines,
 *   including auth failures, ECONNREFUSED to the relay, etc.).
 *
 * Output is plain text, ready to append directly to an Error message.
 */
export function collectWindowsServiceLaunchDiagnostics(params: Readonly<{
  taskName: string;
  stdoutPath: string;
  stderrPath: string;
}>): string | null {
  const sections: string[] = [];

  const scheduledTaskInfo = readScheduledTaskListInfo(params.taskName);
  if (scheduledTaskInfo) {
    sections.push(scheduledTaskInfo);
  }

  const stderrTail = tailLogFile(params.stderrPath, 25);
  if (stderrTail) {
    sections.push(`Wrapper stderr (${params.stderrPath}):\n${stderrTail}`);
  }
  const stdoutTail = tailLogFile(params.stdoutPath, 25);
  if (stdoutTail) {
    sections.push(`Wrapper stdout (${params.stdoutPath}):\n${stdoutTail}`);
  }

  if (sections.length === 0) {
    return null;
  }
  return sections.join('\n\n');
}

const SCHTASKS_FIELD_ALIASES: Record<string, readonly string[]> = {
  'Status': [
    'Status',
    'Statut', // fr
    'État', // fr (some builds)
    'Status', // de (same word)
    'Estado', // es / pt
    'Stato', // it
    'ステータス', // ja
    'スケジュールされたタスクの状態', // ja (alt)
    'Statut de la tâche planifiée', // fr
  ],
  'Last Run Time': [
    'Last Run Time',
    'Heure de la dernière exécution', // fr
    'Letzte Laufzeit', // de
    'Última hora de ejecución', // es
    'Última hora de execução', // pt
    'Ultima ora di esecuzione', // it
  ],
  'Last Result': [
    'Last Result',
    'Dernier résultat', // fr
    'Letztes Ergebnis', // de
    'Último resultado', // es / pt
    'Ultimo risultato', // it
  ],
  'Task To Run': [
    'Task To Run',
    'Tâche à exécuter', // fr
    'Auszuführende Aufgabe', // de
    'Tarea a ejecutar', // es
    'Tarefa a Executar', // pt
    'Operazione da eseguire', // it
  ],
};

function readScheduledTaskListInfo(taskName: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }
  const powerShellInfo = readScheduledTaskPowerShellInfo(taskName);
  if (powerShellInfo) {
    return powerShellInfo;
  }
  return readScheduledTaskSchtasksListInfo(taskName);
}

function splitWindowsScheduledTaskName(taskName: string): { taskPath: string; leafTaskName: string } {
  const normalized = String(taskName ?? '').trim().replaceAll('/', '\\');
  const parts = normalized.split('\\').map((part) => part.trim()).filter(Boolean);
  const leafTaskName = parts.pop() ?? normalized;
  const taskPath = parts.length > 0 ? `\\${parts.join('\\')}\\` : '\\Happier\\';
  return { taskPath, leafTaskName };
}

function readScheduledTaskPowerShellInfo(taskName: string): string | null {
  const { taskPath, leafTaskName } = splitWindowsScheduledTaskName(taskName);
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    buildReadWindowsScheduledTaskStatusPowerShellCommand({
      taskPath,
      taskName: leafTaskName,
    }),
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return null;
  }
  const status = parseWindowsScheduledTaskStatusPowerShellJson(result.stdout);
  if (!status) {
    return null;
  }
  const lines: string[] = [`Scheduled task ${taskName}:`];
  if (!status.exists) {
    lines.push('  Installed:     no');
    return lines.join('\n');
  }
  if (status.stateLabel) lines.push(`  Status:        ${status.stateLabel}`);
  if (status.lastRunTime) lines.push(`  Last run:      ${status.lastRunTime}`);
  if (status.lastTaskResult !== null) lines.push(`  Last result:   ${status.lastTaskResult} (Windows wrapper exit code)`);
  if (status.taskToRun) lines.push(`  Task to run:   ${status.taskToRun}`);
  return lines.join('\n');
}

/**
 * Fallback for machines where the ScheduledTasks PowerShell module is missing
 * or blocked. Its output is localized and may be encoded with the system code
 * page, so the invariant PowerShell JSON path above must remain the primary
 * diagnostic source.
 */
function readScheduledTaskSchtasksListInfo(taskName: string): string | null {
  const result = spawnSync('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return null;
  }
  const fields = parseSchtasksListFields(result.stdout, SCHTASKS_FIELD_ALIASES);
  if (Object.values(fields).every((value) => !value)) {
    return null;
  }
  const lines: string[] = [`Scheduled task ${taskName}:`];
  if (fields['Status']) lines.push(`  Status:        ${fields['Status']}`);
  if (fields['Last Run Time']) lines.push(`  Last run:      ${fields['Last Run Time']}`);
  if (fields['Last Result']) lines.push(`  Last result:   ${fields['Last Result']} (Windows wrapper exit code)`);
  if (fields['Task To Run']) lines.push(`  Task to run:   ${fields['Task To Run']}`);
  return lines.join('\n');
}

/**
 * Parse a `schtasks /FO LIST` block, accepting any of the configured locale
 * aliases for each canonical field name. Output is a flat list of
 * `Key:  Value` lines with arbitrary whitespace; we only look at the first
 * occurrence of each requested key in case multiple tasks were returned
 * (unlikely with `/TN <name>` but defensive).
 */
function parseSchtasksListFields(
  text: string,
  fieldAliases: Record<string, readonly string[]>,
): Record<string, string> {
  const aliasToCanonical = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(fieldAliases)) {
    for (const alias of aliases) aliasToCanonical.set(alias.toLowerCase(), canonical);
  }
  const out: Record<string, string> = {};
  for (const canonical of Object.keys(fieldAliases)) out[canonical] = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const fieldName = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    const canonical = aliasToCanonical.get(fieldName.toLowerCase());
    if (canonical && !out[canonical]) {
      out[canonical] = value;
    }
  }
  return out;
}

/**
 * Read the last `maxLines` non-empty lines from a log file. Skips the file
 * entirely when it doesn't exist, can't be stat'd, or is empty. Decodes at
 * most the last 32 KiB into the error message — that's plenty for the
 * trailing crash/error context.
 *
 * **Encoding**: PowerShell's `>>` redirect on Windows writes UTF-16 LE with
 * a BOM by default. Reading those files as UTF-8 produces "every character
 * is space-separated" garbage (because each ASCII char becomes two bytes:
 * `<low><0x00>`). We sniff the BOM and decode UTF-16 LE / BE accordingly,
 * falling back to UTF-8 for tools that emit it (Bun, Node, manually-written
 * .log files).
 */
function tailLogFile(path: string, maxLines: number): string | null {
  if (!path || !existsSync(path)) return null;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const maxBytes = 32 * 1024;
  const rawBuffer = (() => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  })();
  if (!rawBuffer) return null;

  const { contents, slicedFromMiddle } = decodeTailBuffer(rawBuffer, maxBytes);
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // If we sliced into the middle of a line, drop the partial first one so we
  // don't print "...interrupted text Last result: 1"; if the file fits in
  // maxBytes (slicedFromMiddle === false) keep it.
  const trimmed = slicedFromMiddle && lines.length > 1 ? lines.slice(1) : lines;
  const tail = trimmed.slice(-maxLines);
  return tail.map((line) => `  ${line}`).join('\n');
}

/**
 * Slice the trailing `maxBytes` and decode using the right charset.
 *
 * UTF-16 detection:
 * - UTF-16 LE BOM is `0xFF 0xFE`; BE is `0xFE 0xFF`.
 * - We also accept "BOM-less UTF-16" by sniffing the trailing window for
 *   the typical pattern of zero-byte high halves on ASCII content (every
 *   second byte being `0x00` strongly suggests UTF-16). PowerShell's
 *   default `>>` produces a BOM, but legacy code paths sometimes don't.
 * - When detected as UTF-16 we slice on a 2-byte boundary so we don't
 *   split a code unit in half.
 */
function decodeTailBuffer(buffer: Buffer, maxBytes: number): { contents: string; slicedFromMiddle: boolean } {
  const utf16BomLE = buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE;
  const utf16BomBE = buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF;
  const utf8Bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;

  if (utf16BomLE || utf16BomBE) {
    // Body is everything past the 2-byte BOM. We tail an even number of
    // bytes so the slice lands on a UTF-16 code-unit boundary.
    const bodyStart = 2;
    const tailBytes = Math.min(buffer.length - bodyStart, maxBytes & ~1);
    const sliceStart = buffer.length - tailBytes;
    const sliceStartAligned = (sliceStart - bodyStart) % 2 === 0 ? sliceStart : sliceStart + 1;
    const sliced = buffer.subarray(sliceStartAligned);
    // Node's Buffer doesn't support UTF-16 BE directly; we manually swap
    // the byte order so we can decode the BE form using its native LE codec.
    const decoded = utf16BomBE ? swapBytes16(sliced).toString('utf16le') : sliced.toString('utf16le');
    const cleaned = decoded.replace(/^﻿/, '');
    return { contents: cleaned, slicedFromMiddle: sliceStartAligned > bodyStart };
  }

  if (looksLikeBomlessUtf16Le(buffer)) {
    const tailBytes = Math.min(buffer.length, maxBytes & ~1);
    const sliceStartRaw = buffer.length - tailBytes;
    const sliceStart = sliceStartRaw % 2 === 0 ? sliceStartRaw : sliceStartRaw + 1;
    const sliced = buffer.subarray(sliceStart);
    return {
      contents: sliced.toString('utf16le').replace(/^﻿/, ''),
      slicedFromMiddle: sliceStart > 0,
    };
  }

  const bodyStart = utf8Bom ? 3 : 0;
  const tailBytes = Math.min(buffer.length - bodyStart, maxBytes);
  const sliceStart = Math.max(bodyStart, buffer.length - tailBytes);
  return {
    contents: buffer.subarray(sliceStart).toString('utf8'),
    slicedFromMiddle: sliceStart > bodyStart,
  };
}

/**
 * Swap byte order for a UTF-16 BE buffer so it can be decoded as UTF-16 LE
 * (which Node's TextDecoder/Buffer handle natively).
 */
function swapBytes16(input: Buffer): Buffer {
  if (input.length % 2 !== 0) return input;
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i += 2) {
    out[i] = input[i + 1];
    out[i + 1] = input[i];
  }
  return out;
}

/**
 * Detect "UTF-16 LE without a BOM" by looking at the byte-distribution in
 * the trailing 2 KiB: if the high-half bytes (offsets 1, 3, 5, ...) are
 * predominantly `0x00`, the content is almost certainly ASCII-encoded as
 * UTF-16. Used as a fallback when there's no BOM but PowerShell
 * append-redirect started writing into a pre-existing UTF-16 file.
 */
function looksLikeBomlessUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 32 || buffer.length % 2 !== 0) return false;
  const sampleStart = Math.max(0, buffer.length - 2048);
  const sampleEnd = buffer.length;
  let zeros = 0;
  let total = 0;
  for (let i = sampleStart + 1; i < sampleEnd; i += 2) {
    if (buffer[i] === 0x00) zeros += 1;
    total += 1;
  }
  return total > 0 && zeros / total > 0.85;
}
