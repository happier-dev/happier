export type BundledPluginTimingReporter = Readonly<{
  phase(name: string): void;
}>;

export function createBundledPluginTimingReporter({
  now = () => performance.now(),
  write = (line: string) => process.stderr.write(line),
}: Readonly<{
  now?: () => number;
  write?: (line: string) => void;
}> = {}): BundledPluginTimingReporter {
  const startedAt = now();
  let previousAt = startedAt;
  return Object.freeze({
    phase(name: string): void {
      const currentAt = now();
      write(
        `bundled-plugins: phase=${name} deltaMs=${Math.round(currentAt - previousAt)} totalMs=${Math.round(currentAt - startedAt)}\n`,
      );
      previousAt = currentAt;
    },
  });
}
