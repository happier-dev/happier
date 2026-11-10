import { readFileSync } from 'node:fs';

/** Match native_process_priority.sh's user-systemd payload placement, even
 * when the broker itself runs outside the jobs slice. */
export function readLinuxAdmissionMemory({ waitingResidentMemoryKiB = 0 } = {}) {
  const memory = readFileSync('/proc/meminfo', 'utf8');
  const totalMemoryKiB = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
  const availableMemoryKiB = Math.min(totalMemoryKiB,
    Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) + waitingResidentMemoryKiB);
  const uid = process.getuid();
  const cgroup = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/happier.slice/happier-jobs.slice`;
  const readLimit = name => {
    try {
      const value = readFileSync(`${cgroup}/${name}`, 'utf8').trim();
      return value === 'max' ? Infinity : Number(value);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return Infinity;
      throw error;
    }
  };
  const limit = Math.min(readLimit('memory.high'), readLimit('memory.max'));
  if (limit === Infinity) return { availableMemoryKiB, totalMemoryKiB };
  // memory.high is the kernel's existing throttle boundary, not a new budget.
  // A finite limit requires its usage observation; never fall back to the host
  // when that observation is unavailable.
  const current = Number(readFileSync(`${cgroup}/memory.current`, 'utf8').trim());
  return { totalMemoryKiB: Math.min(totalMemoryKiB, Math.floor(limit / 1024)),
    availableMemoryKiB: Math.min(availableMemoryKiB, Math.max(0, Math.floor((limit - current) / 1024))) };
}
