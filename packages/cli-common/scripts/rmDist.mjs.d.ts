export type RmDistSyncOptions = Readonly<{
  targetDir?: string | null;
  retries?: number | null;
  delayMs?: number | null;
  rmSyncImpl?: (path: string, options: { recursive: true; force: true }) => void;
}>;

export declare function rmDistSync(options?: RmDistSyncOptions): void;
export declare function main(): void;
