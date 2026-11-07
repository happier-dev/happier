import { useEffect, useState } from 'react';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import { forgeCiReadQueryKeyV1, type ForgeCiReadsV1 } from '../runtime/reads.js';
import type { ForgeCiPagedReadLeaseV1, ForgeCiPagedReadOperationV1 } from '../runtime/paging.js';

/** Cursor windows share the ordinary read owner; only explicit loadMore admits another page. */
export function useForgeCiPagedQueryV1<K extends ForgeCiPagedReadOperationV1>(
  reads: ForgeCiReadsV1 | null, operation: K, input: ForgeCiActionInputByOperationV1[K] | null, enabled = true,
  /** Pause demand without discarding the person's explicitly loaded cursor window. */
  consumed = true,
): ForgeCiPagedReadLeaseV1<K> | null {
  const { active } = usePluginSurfaceActivity();
  const key = input === null ? null : forgeCiReadQueryKeyV1(operation, input);
  const [held, setHeld] = useState<Readonly<{ reads: ForgeCiReadsV1; key: string; lease: ForgeCiPagedReadLeaseV1<K> }> | null>(null);
  useEffect(() => {
    if (!reads || input === null || key === null || !enabled) { setHeld(null); return; }
    const lease = reads.acquirePaged(operation, input, { active: active && consumed });
    setHeld({ reads, key, lease });
    return () => { lease.release(); };
  }, [reads, operation, key, enabled]);
  const lease = held?.reads === reads && held.key === key && enabled ? held.lease : null;
  useEffect(() => { lease?.setActive(active && consumed); }, [lease, active, consumed]);
  return lease;
}
