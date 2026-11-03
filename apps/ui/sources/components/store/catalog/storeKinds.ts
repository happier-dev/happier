import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Host presentation only. The family retains its own incomplete/unavailable facts and next-page handle. */
export type InstalledFamilyResult<InstalledRow, NativeReason, NativeContinuation> = Readonly<{
    rows: readonly InstalledRow[];
    coverage: 'loading' | 'available' | Readonly<{ unavailable: NativeReason }> | Readonly<{ partial: NativeReason }>;
    continuation?: NativeContinuation;
}>;
export type StoreDemand = Readonly<{ presented: boolean }>;
export type StoreInstalledInput = Readonly<{
    scope: ServerAccountScope | null;
    machine: MachineAdministrationTargetV1 | null;
    projectKey: string | null;
}>;
