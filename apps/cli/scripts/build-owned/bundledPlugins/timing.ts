export type BundledPluginTimingReporter = Readonly<{
  phase(name: string): void;
}>;

export function createBundledPluginTimingReporter({
  now = () => performance.now(),
  readResourceUsage = () => process.resourceUsage(),
  write = (line: string) => process.stderr.write(line),
}: Readonly<{
  now?: () => number;
  readResourceUsage?: () => Pick<NodeJS.ResourceUsage, 'userCPUTime' | 'systemCPUTime' | 'fsRead' | 'fsWrite'>;
  write?: (line: string) => void;
}> = {}): BundledPluginTimingReporter {
  const startedAt = now();
  let previousAt = startedAt;
  let previousResources = readResourceUsage();
  return Object.freeze({
    phase(name: string): void {
      const currentAt = now();
      const currentResources = readResourceUsage();
      const resourceUsage = {
        scope: 'self',
        pid: process.pid,
        userCpuMicros: currentResources.userCPUTime - previousResources.userCPUTime,
        systemCpuMicros: currentResources.systemCPUTime - previousResources.systemCPUTime,
        fsRead: currentResources.fsRead - previousResources.fsRead,
        fsWrite: currentResources.fsWrite - previousResources.fsWrite,
      };
      write(
        `bundled-plugins: phase=${name} deltaMs=${Math.round(currentAt - previousAt)} totalMs=${Math.round(currentAt - startedAt)} resourceUsage=${JSON.stringify(resourceUsage)}\n`,
      );
      previousAt = currentAt;
      previousResources = currentResources;
    },
  });
}
