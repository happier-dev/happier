import * as React from 'react';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ManagedDataOperation } from './managedData';

const organizationProfileKeys = { profile: ['connectedAccountsV4'], profileScope: true } as const;

/** Shared operands for managed data forms; declared organization fields receive an editable profile default. */
export function useManagedDataForm(operation: ManagedDataOperation | null | undefined, lifetime: ServerAccountScopeLifetime) {
  const [account, selectAccount] = React.useState<QualifiedConnectedAccountRef | null>(null);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const organizationId = storage(state => account && areServerAccountScopesEqual(state.profileScope, lifetime.scope)
    ? state.profile.connectedAccountsV4.find(profile => sameQualifiedConnectedAccountRef(profile.ref, account))?.providerIdentity?.organizationId ?? undefined
    : undefined, organizationProfileKeys);
  const seeded = React.useMemo(() => {
    if (!operation) return values;
    const organizationField = operation.inputHints.fields.some(field => field.path === 'providerAccountId');
    const defaults = organizationField && organizationId && values.providerAccountId === undefined
      ? { ...values, providerAccountId: organizationId } : values;
    return seedInputByFieldHints(operation, defaults);
  }, [operation, values, organizationId]);
  const setAccount = (next: QualifiedConnectedAccountRef | null) => {
    if (account === next || account && next && sameQualifiedConnectedAccountRef(account, next)) return;
    selectAccount(next);
    setValues(current => {
      if (!Object.hasOwn(current, 'providerAccountId')) return current;
      const { providerAccountId: _previousOrganization, ...retained } = current;
      return retained;
    });
  };
  return { account, setAccount, setValues, seeded };
}
