import { readFileSync } from 'node:fs';

/** Match native_process_priority.sh's user-systemd payload placement, even
 * when the broker itself runs outside the jobs slice. */
const jobsSlice = uid => `/user.slice/user-${uid}.slice/user@${uid}.service/happier.slice/happier-jobs.slice`;

/** Remote dispatch wrappers place queued admission clients inside the jobs
 * slice (nl1 2026-11-14: 103 clients, 8,066 MiB PSS), so their own pages are
 * charged to the headroom they wait for. Clients elsewhere are not. */
export function isInAdmissionJobsSlice(pid) {
  try {
    const path = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.*)$/m)?.[1] ?? '';
    return path.startsWith(`${jobsSlice(process.getuid())}/`);
  } catch { return false; }
}

/** The kernel high-water mark of this dispatch's jobs scope (cgroup v2
 * memory.peak). Every payload phase runs inside that scope, so it is never
 * below the payload's true peak. Outside the jobs slice there is no peak. */
export function readJobScopePeakKiB() {
  try {
    const path = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m)?.[1] ?? '';
    if (!path.startsWith(`${jobsSlice(process.getuid())}/`)) return null;
    // Only a per-dispatch jobs scope belongs to this payload. A local run that
    // inherits its caller's scope (e.g. a tmux session) reports none.
    if (!/\/happier-jobs-\d+-[^/]+\.scope$/.test(path)) return null;
    const bytes = Number(readFileSync(`/sys/fs/cgroup${path}/memory.peak`, 'utf8').trim());
    return Number.isSafeInteger(bytes) && bytes > 0 ? Math.ceil(bytes / 1024) : null;
  } catch { return null; }
}

/** A recovered slot's job scope memory.current. A scope shared with the reader
 * (same cgroup) is not attributable to that slot, so it reports none. */
export function readProcessJobScopeCurrentKiB(pid) {
  try {
    const scope = file => readFileSync(file, 'utf8').match(/^0::(.*)$/m)?.[1] ?? '';
    const path = scope(`/proc/${pid}/cgroup`);
    if (!path.startsWith(`${jobsSlice(process.getuid())}/`) || path === scope('/proc/self/cgroup')) return null;
    const bytes = Number(readFileSync(`/sys/fs/cgroup${path}/memory.current`, 'utf8').trim());
    return Number.isSafeInteger(bytes) && bytes > 0 ? Math.ceil(bytes / 1024) : null;
  } catch { return null; }
}

export function readLinuxAdmissionMemory({ waitingResidentMemoryKiB = 0, waitingSliceResidentMemoryKiB = 0 } = {}) {
  const memory = readFileSync('/proc/meminfo', 'utf8');
  const totalMemoryKiB = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
  const availableMemoryKiB = Math.min(totalMemoryKiB,
    Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) + waitingResidentMemoryKiB);
  const uid = process.getuid();
  const cgroup = `/sys/fs/cgroup${jobsSlice(uid)}`;
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
  // File LRUs and reclaimable slab can be reclaimed under memory pressure.
  // Crediting only inactive_file discarded windows2's active file cache and
  // reclaimable slab (7.4 GiB, 2026-11-13). Anonymous/shmem and unevictable
  // pages stay charged. Keep both the slice limit and host MemAvailable caps.
  const stat = readFileSync(`${cgroup}/memory.stat`, 'utf8');
  const inactiveFile = Number(/^inactive_file\s+(\d+)/m.exec(stat)?.[1]);
  const activeFile = Number(/^active_file\s+(\d+)/m.exec(stat)?.[1] ?? 0);
  const reclaimableSlab = Number(/^slab_reclaimable\s+(\d+)/m.exec(stat)?.[1] ?? 0);
  const workingSet = Math.max(0, current - inactiveFile - activeFile - reclaimableSlab - waitingSliceResidentMemoryKiB * 1024);
  return { totalMemoryKiB: Math.min(totalMemoryKiB, Math.floor(limit / 1024)),
    availableMemoryKiB: Math.min(availableMemoryKiB, Math.max(0, Math.floor((limit - workingSet) / 1024))) };
}
