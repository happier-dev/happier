export type PackSandboxTarball = Readonly<{
  ok: true;
  package: Readonly<{
    name: string;
    version: string;
  }>;
  tarball: Readonly<{
    name: string;
    sizeBytes: number;
  }>;
  bundled: Readonly<{
    agents: boolean;
    cliCommon: boolean;
    protocol: boolean;
  }>;
  bundledWorkspaces: unknown;
  enforcement: Readonly<{
    bundledDeps: boolean;
  }>;
  dryRun: Readonly<{
    ok: true;
  }>;
}>;

export function exportPackSandboxTarball(input: Readonly<{
  monorepoRoot: string;
  packageRelDir: string;
  destinationDir: string;
  packageVersion?: string | null;
  env?: NodeJS.ProcessEnv;
}>): Promise<PackSandboxTarball>;
