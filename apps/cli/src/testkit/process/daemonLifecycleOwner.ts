import { vi } from 'vitest';

type DaemonDoctorModule = typeof import('@/daemon/doctor');

export function withCurrentProcessAsDaemonLifecycleOwner(
  actual: DaemonDoctorModule,
): DaemonDoctorModule {
  return {
    ...actual,
    classifyDaemonLifecycleProcessByPid: async (pid: number) => pid === process.pid
      ? {
          kind: 'daemon' as const,
          process: {
            pid,
            command: `${process.execPath} ${process.cwd()}/src/index.ts daemon start-sync`,
            type: 'dev-daemon',
          },
        }
      : await actual.classifyDaemonLifecycleProcessByPid(pid),
  };
}

/**
 * Treat the Vitest process as the daemon lifecycle owner for state-file fixtures that use
 * `process.pid`. Process inspection is an OS boundary; keeping this fixture here prevents each
 * daemon suite from inventing a partial `doctor` mock when ownership classification evolves.
 */
export function mockCurrentProcessAsDaemonLifecycleOwner(): void {
  vi.doMock('@/daemon/doctor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/doctor')>();
    return withCurrentProcessAsDaemonLifecycleOwner(actual);
  });
}
