export function isProcessAlive(pid: number): boolean;
export function terminateProcessTreeByPid(
  pid: number,
  opts?: { graceMs?: number; pollMs?: number; skipAliveCheck?: boolean; additionalPids?: number[] },
): Promise<void>;
