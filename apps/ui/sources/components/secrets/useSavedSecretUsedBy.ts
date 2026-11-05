import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AccountSettingsSavedSecretReference } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeSavedSecretUsedBySources, projectSavedSecretUsedBy, readSavedSecretUsedBySources,
    subscribeSavedSecretUsedBySources } from '@/sync/store/settings/savedSecretUsedBy';

/** One selected secret, from held metadata. Null = unknown coverage; [] = known unused. */
export function useSavedSecretUsedBy(scope: ServerAccountScope | null, ref: string | null): readonly AccountSettingsSavedSecretReference[] | null {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const readShallow = useShallow(() => readSavedSecretUsedBySources(ref ? captured : null));
    const read = React.useCallback(() => readShallow(undefined), [readShallow]);
    const source = React.useSyncExternalStore(ref && captured ? subscribeSavedSecretUsedBySources : noSubscription, read, read);
    // The census scans referrer slots, once per selected secret or actual source change, never per render.
    const current = React.useMemo(() => projectSavedSecretUsedBy(captured, ref, source), [captured, ref, source]);
    // A catalog revalidating drops coverage for a moment; the same secret keeps its last settled census.
    const key = `${serverId}\n${accountId}\n${ref}`;
    const settled = React.useRef<Readonly<{ key: string; value: readonly AccountSettingsSavedSecretReference[] }> | null>(null);
    if (current) settled.current = { key, value: current };
    return current ?? (settled.current?.key === key ? settled.current.value : null);
}
const noSubscription = () => () => {};

/** Asks each catalog's owner for the census inputs while the secret's page is open. */
export function useSavedSecretUsedBySourcesDemand(scope: ServerAccountScope | null): void {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    React.useEffect(() => serverId && accountId ? observeSavedSecretUsedBySources({ serverId, accountId }) : undefined, [serverId, accountId]);
}
