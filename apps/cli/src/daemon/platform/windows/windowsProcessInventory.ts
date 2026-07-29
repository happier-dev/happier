export type WindowsProcessInventoryFact = Readonly<{
  pid: number;
  name?: string;
  ppid?: number;
  processStartTimeMs?: number;
  command?: string;
  executablePath?: string;
}>;

export type WindowsProcessInventoryExecFile = (
  command: string,
  args: readonly string[],
  options: Readonly<{ timeout: number; maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

// PowerShell 5.1 plus CIM startup can exceed two seconds on supported
// Windows 11 hosts. Keep one bounded owner-wide deadline for full and
// PID-filtered inventories so custody and identity readers agree.
const WINDOWS_PROCESS_INVENTORY_TIMEOUT_MS = 5_000;

type WindowsProcessJsonRow = Readonly<{
  ProcessId?: unknown;
  Name?: unknown;
  ParentProcessId?: unknown;
  ProcessStartTimeMs?: unknown;
  CreationDate?: unknown;
  CommandLine?: unknown;
  ExecutablePath?: unknown;
}>;

function parsePositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseWindowsCreationDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const powershellDate = /^\\?\/Date\((\d+)(?:[+-]\d+)?\)\\?\/$/u
    .exec(value.trim());
  if (powershellDate?.[1]) {
    const milliseconds = Number(powershellDate[1]);
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0
      ? milliseconds
      : undefined;
  }
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-]\d{3})?$/u
      .exec(value.trim());
  if (!match?.[1]) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : undefined;
  }
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number((match[7] ?? '0').padEnd(3, '0').slice(0, 3)),
  );
  const offsetMinutes = match[8] ? Number(match[8]) : 0;
  return Number.isFinite(utc)
    ? utc - offsetMinutes * 60_000
    : undefined;
}

function processRows(value: unknown): readonly WindowsProcessJsonRow[] {
  if (Array.isArray(value)) {
    return value.filter(
      (row): row is WindowsProcessJsonRow =>
        row !== null && typeof row === 'object',
    );
  }
  return value !== null && typeof value === 'object'
    ? [value as WindowsProcessJsonRow]
    : [];
}

export function parseWindowsProcessInventoryJson(
  output: string,
): ReadonlyMap<number, WindowsProcessInventoryFact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Windows process inventory was unreadable');
  }

  const processes = new Map<number, WindowsProcessInventoryFact>();
  for (const row of processRows(parsed)) {
    const pid = parsePositiveInteger(row.ProcessId);
    if (!pid) continue;
    const name =
      typeof row.Name === 'string' ? row.Name.trim() : '';
    const ppid = parsePositiveInteger(row.ParentProcessId);
    const projectedStartTime =
      typeof row.ProcessStartTimeMs === 'number'
        ? row.ProcessStartTimeMs
        : Number(row.ProcessStartTimeMs);
    const processStartTimeMs =
      Number.isSafeInteger(projectedStartTime)
      && projectedStartTime >= 0
        ? projectedStartTime
        : parseWindowsCreationDate(row.CreationDate);
    const command =
      typeof row.CommandLine === 'string'
        ? row.CommandLine.trim()
        : '';
    const executablePath =
      typeof row.ExecutablePath === 'string'
        ? row.ExecutablePath.trim()
        : '';
    processes.set(pid, {
      pid,
      ...(name ? { name } : {}),
      ...(ppid ? { ppid } : {}),
      ...(processStartTimeMs !== undefined
        ? { processStartTimeMs }
        : {}),
      ...(command ? { command } : {}),
      ...(executablePath ? { executablePath } : {}),
    });
  }
  return processes;
}

export async function readWindowsProcessInventory(
  input: Readonly<{
    execFile: WindowsProcessInventoryExecFile;
    pids?: readonly number[];
  }>,
): Promise<ReadonlyMap<number, WindowsProcessInventoryFact>> {
  const pids = input.pids
    ? [...new Set(input.pids.filter(
        (pid) => Number.isInteger(pid) && pid > 0,
      ))]
    : null;
  if (pids?.length === 0) return new Map();

  const source = pids
    ? `Get-CimInstance Win32_Process -Filter "${
        pids.map((pid) => `ProcessId = ${pid}`).join(' OR ')
      }"`
    : 'Get-CimInstance Win32_Process';
  const script = [
    `$rows = ${source} | Select-Object ProcessId,Name,ParentProcessId,@{Name='ProcessStartTimeMs';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}},CommandLine,ExecutablePath`,
    "if ($null -eq $rows) { Write-Output '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join('; ');
  const result = await input.execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: WINDOWS_PROCESS_INVENTORY_TIMEOUT_MS,
      maxBuffer: pids ? 1024 * 1024 : 8 * 1024 * 1024,
    },
  );
  return parseWindowsProcessInventoryJson(
    typeof result.stdout === 'string'
      ? result.stdout
      : result.stdout.toString('utf8'),
  );
}
