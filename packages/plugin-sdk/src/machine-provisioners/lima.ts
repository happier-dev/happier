/** @moduleRealm daemon */
import * as native from '@happier-dev/cli-common/machineLima';

export type LimaCommandResult = native.LimaCommandResult;
export type LimaExecutor<TResult extends LimaCommandResult = LimaCommandResult> = native.LimaExecutor<TResult>;
export type LimaInstance = Record<string, unknown>;
export type LimaIdentity = Readonly<{ instance: string; store?: string }>;
export type LimaInstanceOptions = LimaIdentity & Readonly<{ executor: LimaExecutor }>;

// Public declarations name only the injected native IO contract. The shared
// adapter remains the sole owner of Lima commands, identity and observations.
export const validateLimaStore: (value: unknown) => string = native.validateLimaStore;
export const parseLimaVersion: (output: unknown) => number[] | null = native.parseLimaVersion;
export const limaVersionAtLeast: (actual: readonly number[] | null, minimum?: readonly number[]) => boolean = native.limaVersionAtLeast;
export const limaInstanceField: (instance: LimaInstance | null, lower: string, upper?: string) => unknown = native.limaInstanceField;
export const runLimaCommand: (options: { executor: LimaExecutor; store?: string; args: readonly string[]; input?: string | Uint8Array; interactive?: boolean }) => Promise<LimaCommandResult> = native.runLimaCommand;
export const inspectLimaCapabilities: (options: { executor: LimaExecutor }) => Promise<{ hostOS: string; hostArch: string; vmTypes: readonly string[];
  limaHome?: string; defaultTemplate?: Readonly<Record<string, unknown>> }> = native.inspectLimaCapabilities;
export const inspectLimaInstance: (options: LimaInstanceOptions) => Promise<LimaInstance | null> = native.inspectLimaInstance;
export const changeLimaPower: (options: LimaInstanceOptions & { intent: 'start' | 'stop'; force?: boolean }) => Promise<{ changed: boolean; status: string }> = native.changeLimaPower;
export const createLimaInstance: (options: LimaInstanceOptions & { createArgs: readonly string[] }) => Promise<{ created: boolean; reconciled: boolean; instance: LimaInstance }> = native.createLimaInstance;
export const deleteLimaInstance: (options: LimaInstanceOptions) => Promise<{ kind: 'absent' | 'unknown' }> = native.deleteLimaInstance;
export const execLimaGuest: <TResult extends LimaCommandResult>(options: LimaIdentity & { executor: LimaExecutor<TResult>; argv: readonly string[]; input?: string | Uint8Array }) => Promise<TResult> = native.execLimaGuest;
export const putLimaGuestFile: (options: LimaInstanceOptions & { guestPath: string; bytes: Uint8Array; mode?: string }) => Promise<{ kind: 'written' | 'unknown' }> = native.putLimaGuestFile;
