import type { ProviderRedactionLease } from '@/providers/spawn/redaction';

export type ProjectNativeToolchainIo = Readonly<{
  /** Incumbent managedDependencies/systemTools resolution; never installs. */
  resolveTool: (tool: string, signal?: AbortSignal) => Promise<Readonly<{ executablePath: string; args?: readonly string[]; version: string }> | null>;
  /** Incumbent supervised process IO, including process-tree cancellation. Output is private. */
  run: (request: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; signal?: AbortSignal;
    /** Host-owned native config input; existing supervisor owns byte custody. */
    stdin?: Uint8Array;
    /** Host-only stage capture; the supervisor sanitizes before this sink or its result buffers. */
    output?: Readonly<{ redaction: ProviderRedactionLease; onChunk(stream: 'stdout' | 'stderr', chunk: Uint8Array): void }>;
  }>) => Promise<Readonly<{ exitCode: number; stdout: string; stderr?: string }>>;
}>;
