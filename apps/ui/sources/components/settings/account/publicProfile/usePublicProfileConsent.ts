import * as React from 'react';
import type { PublicProfileField } from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfileUpdateResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { setPublicProfileDraftField, type PublicProfileDraft } from './publicProfileDraft';

export type PublicProfileConsentState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending'; field: PublicProfileField; shown: boolean }>
  | Readonly<{ kind: 'acknowledged'; field: PublicProfileField; previousShown: boolean }>
  | Readonly<{ kind: 'failed'; field: PublicProfileField; shown: boolean; errorCode: string }>;

/** Published consent is acknowledged independently; placement and Look remain private until Apply. */
export function usePublicProfileConsent(input: Readonly<{
  record: PublicProfileOwnerRecordV1 | null;
  draft: PublicProfileDraft | null;
  setDraft: React.Dispatch<React.SetStateAction<PublicProfileDraft | null>>;
  execution: Pick<ReturnType<typeof useMountedActionExecution>, 'execute'>;
  onAcknowledged: (record: PublicProfileOwnerRecordV1 | null) => void;
}>) {
  const [state, setState] = React.useState<PublicProfileConsentState>({ kind: 'idle' });
  const pending = React.useRef(false);
  const acknowledgedPolicy = input.record?.state !== 'draft' ? input.record?.policy : null;
  React.useEffect(() => {
    if (acknowledgedPolicy) input.setDraft(current => current && current.policy !== acknowledgedPolicy
      ? { ...current, policy: acknowledgedPolicy } : current);
  }, [acknowledgedPolicy, input.setDraft]);
  const updateField = async (field: PublicProfileField, shown: boolean) => {
    if (!input.draft || pending.current) return;
    if (!input.record || input.record.state === 'draft') {
      input.setDraft(current => current ? setPublicProfileDraftField(current, field, shown) : current);
      return;
    }
    const policy = input.record.policy;
    if (!policy || policy.fields[field] === shown) return;
    pending.current = true;
    setState({ kind: 'pending', field, shown });
    try {
      const outcome = await input.execution.execute('account.public_profile.update', {
        policy: { ...policy, fields: { ...policy.fields, [field]: shown } },
      });
      if (!outcome.ok) {
        setState({ kind: 'failed', field, shown,
          errorCode: outcome.errorCode === 'outcome_unknown' ? 'action_uncertain' : outcome.errorCode });
        return;
      }
      const result = PublicProfileUpdateResultV1Schema.parse(outcome.result);
      if (result.kind !== 'updated' || !result.record?.policy) {
        setState({ kind: 'failed', field, shown,
          errorCode: result.kind === 'unavailable' ? result.reason : 'invalid_action_output' });
        return;
      }
      const acknowledgedPolicy = result.record.policy;
      input.onAcknowledged(result.record);
      input.setDraft(current => current ? { ...current, policy: acknowledgedPolicy } : current);
      setState({ kind: 'acknowledged', field, previousShown: policy.fields[field] });
    } catch {
      // An uncertain dispatch is never represented as a confirmed hide or automatically replayed.
      setState({ kind: 'failed', field, shown, errorCode: 'action_uncertain' });
    } finally {
      pending.current = false;
    }
  };
  const undo = async () => {
    if (state.kind === 'acknowledged') await updateField(state.field, state.previousShown);
  };
  return { state, updateField, undo };
}
