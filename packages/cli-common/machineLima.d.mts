export type LimaCommandResult = Readonly<{ exitCode: number | null; out?: string; err?: string }>;
export type LimaExecutor<TResult extends LimaCommandResult = LimaCommandResult> = Readonly<{
  capture(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>>; input?: string | Uint8Array }): Promise<TResult>;
  run(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>>; input?: string | Uint8Array }): Promise<TResult>;
  /** Optional live channel process (the provisioner `stream` role). */
  channel?(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<unknown>;
}>;
export type LimaInstance = Record<string, unknown>;
export type LimaIdentity = Readonly<{ instance: string; store?: string }>;
export type LimaInstanceOptions = LimaIdentity & Readonly<{ executor: LimaExecutor }>;
export function validateLimaInstanceName(value: unknown): string;
export function validateLimaStore(value: unknown): string;
export function parseLimaVersion(output: unknown): number[] | null;
export function limaVersionAtLeast(actual: readonly number[] | null, minimum?: readonly number[]): boolean;
export function limaInstanceField(instance: LimaInstance | null, lower: string, upper?: string): unknown;
export function decodeLimaInstanceOutput(output: unknown, identity: LimaIdentity): LimaInstance | null;
export function runLimaCommand(options: { executor: LimaExecutor; store?: string; instance?: string; args: readonly string[]; input?: string | Uint8Array; interactive?: boolean }): Promise<LimaCommandResult>;
export function inspectLimaCapabilities(options: { executor: LimaExecutor }): Promise<{ hostOS: string; hostArch: string; vmTypes: readonly string[];
  limaHome?: string; defaultTemplate?: Readonly<Record<string, unknown>> }>;
export function inspectLimaInstance(options: LimaInstanceOptions): Promise<LimaInstance | null>;
export function getLimaStatus(options: LimaInstanceOptions): Promise<{ exists: boolean; status: string; instance: LimaInstance | null }>;
export function changeLimaPower(options: LimaInstanceOptions & { intent: 'start' | 'stop'; force?: boolean }): Promise<{ changed: boolean; status: string }>;
export function createLimaInstance(options: LimaInstanceOptions & { createArgs: readonly string[] }): Promise<{ created: boolean; reconciled: boolean; instance: LimaInstance }>;
export function deleteLimaInstance(options: LimaInstanceOptions): Promise<{ kind: 'absent' | 'unknown' }>;
export function runLimaGuestCommand<TResult extends LimaCommandResult>(options: LimaIdentity & { executor: LimaExecutor<TResult>; argv: readonly string[]; input?: string | Uint8Array; workdir?: string; interactive?: boolean }): Promise<TResult>;
export function execLimaGuest<TResult extends LimaCommandResult>(options: LimaIdentity & { executor: LimaExecutor<TResult>; argv: readonly string[]; input?: string | Uint8Array }): Promise<TResult>;
export function openLimaGuestChannel<TChannel>(options: LimaIdentity & { executor: LimaExecutor & { channel(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<TChannel> }; argv: readonly string[] }): Promise<TChannel>;
export function putLimaGuestFile(options: LimaInstanceOptions & { guestPath: string; bytes: Uint8Array; mode?: string }): Promise<{ kind: 'written' | 'unknown' }>;
