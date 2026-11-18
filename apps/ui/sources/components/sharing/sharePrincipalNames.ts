import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { resolveSessionAccessPrincipals } from '@/sync/api/session/sessionAccessApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { sharePrincipalKey } from './sharePrincipalPresentation';
import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';
import { openTeamGroupNameProjection } from '@/sync/ops/teams/teamGroupLabels';
import { projectSessionAccessPrincipal } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** Names already acknowledged by the resource's authorized sharing read, scoped to its confirmation. */
export const SharePrincipalNamesContext = React.createContext<Readonly<{
  serverId: string | null;
  names: ReadonlyMap<string, string>;
}> | null>(null);

/**
 * Display names for exact principals, keyed by `sharePrincipalKey`, through the existing authorized
 * resolver. A Group reads with its Team ("Design, Acme"). An unresolved or unavailable identity is
 * absent: a name never grants access, so the caller keeps its own fallback.
 */
export async function readSharePrincipalNames(
  subjects: readonly PrincipalRefV1[],
  scope: ServerAccountScope,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<ReadonlyMap<string, string>> {
  if (subjects.length === 0) return NO_NAMES;
  try {
    const principals = await resolveSessionAccessPrincipals({
      scope,
      subjects,
      availability: 'available',
      signal,
      isCurrent,
    });
    const names = new Map<string, string>();
    for (const principal of principals) {
      const openedGroupDisplayName = principal.kind === 'group'
        ? await openTeamGroupNameProjection({ client: createPrivateLabelClient(scope),
            groupId: principal.groupId, name: principal.name, signal })
        : undefined;
      if (principal.kind === 'group' && openedGroupDisplayName === null) continue;
      const presentation = projectSessionAccessPrincipal(principal, { accountId: scope.accountId }, openedGroupDisplayName);
      names.set(
        presentation.key,
        principal.kind === 'group'
          ? presentation.accessibilityLabel
          : presentation.displayName,
      );
    }
    return names;
  } catch {
    return NO_NAMES;
  }
}

/** One exact read per mounted principal set and credential lifetime, with no directory scan or render-driven refresh. */
export function useSharePrincipalNames(
  subjects: readonly PrincipalRefV1[] | null,
  serverId: string | null,
): Readonly<{
  names: ReadonlyMap<string, string> | null;
  resolving: boolean;
}> {
  const wanted = subjects !== null && subjects.length > 0;
  const key = wanted ? JSON.stringify(subjects.map(sharePrincipalKey)) : null;
  const reading = useScopedPrincipalNameRead(key, serverId,
    (scope, signal, isCurrent) => readSharePrincipalNames(subjects ?? [], scope, signal, isCurrent));
  return { names: reading.value, resolving: reading.resolving };
}

/** Exact name projections share one credential-bound read and retirement lifecycle. */
export function useScopedPrincipalNameRead<T>(
  key: string | null,
  serverId: string | null,
  read: (scope: ServerAccountScope, signal: AbortSignal, isCurrent: () => boolean) => Promise<T>,
): Readonly<{ value: T | null; resolving: boolean }> {
  const { binding, resolution } = useServerCredentialAccountScopeBinding(key === null ? null : serverId);
  // A reader captures the current operands, but only their stable key starts a new read.
  const currentRead = React.useRef(read);
  currentRead.current = read;
  const [reading, setReading] = React.useState<Readonly<{
    binding: typeof binding;
    key: string;
    value: T | null;
  }> | null>(null);
  React.useEffect(() => {
    if (!binding || key === null) return;
    const abort = new AbortController();
    const retirement = binding.onRetire(() => abort.abort());
    void currentRead.current(
      binding.scope,
      abort.signal,
      binding.isCurrent,
    ).then((value) => {
      if (!abort.signal.aborted && binding.isCurrent())
        setReading({ binding, key, value });
    }, () => {
      // Optional name reads settle unavailable; retiring a row only withdraws
      // its interest and must not leave a rejected promise or publish old data.
      if (!abort.signal.aborted && binding.isCurrent())
        setReading({ binding, key, value: null });
    });
    return () => {
      abort.abort();
      retirement.dispose();
    };
  }, [binding, key]);
  const current =
    reading?.binding === binding && reading.key === key && binding?.isCurrent()
      ? reading
      : null;
  return {
    value: current?.value ?? null,
    resolving:
      key !== null &&
      (resolution.kind === 'resolving' ||
        (binding !== null && current === null)),
  };
}
