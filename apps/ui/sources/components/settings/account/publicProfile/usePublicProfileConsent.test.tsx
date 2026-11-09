import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { bindPublicProfileActionPorts } from '@happier-dev/protocol/actions/executor/publicProfileActions';
import { bindPublicProfilePreparedHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { PublicProfileOwnerRecordV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileLayoutV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfileSnapshot } from '@happier-dev/protocol/account/projectPublicProfile';
import { act, renderHook } from '@/dev/testkit';
import { createPublicProfileDraft, type PublicProfileDraft } from './publicProfileDraft';
import { usePublicProfileConsent } from './usePublicProfileConsent';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';

const layout = { v: 1, items: [] } satisfies PublicProfileLayoutV1;
const context = { handle: 'ada', identity: {}, service: null, urls: null };
const initialRecord = PublicProfileOwnerRecordV1Schema.parse({ state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  metadata: {}, projectSelections: [], query: { period: { relative: '90days' } }, layout,
  appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
  snapshot: { v: 1, computedAtMs: 1, period: { startMs: 0, endMs: 10, timeZoneOffsetMinutes: 0 },
    coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: { activeDays: 4 } },
});

async function setup(options: Readonly<{ published?: boolean; refuse?: boolean; uncertain?: boolean }> = {}) {
  let serverRecord = options.published === false ? null : initialRecord;
  const writes: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // The Account HTTP adapter is the system boundary; preparation, schemas, masking and
  // atomic update admission run through the real shared Action executor.
  const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
    if (args.actionId === 'account.public_profile.get') return serverRecord
      ? { kind: 'ready', context, record: serverRecord } : { kind: 'absent', context };
    const request = bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest);
    writes.push(request.body);
    await held;
    if (options.refuse) return { ok: false, errorCode: 'network_error', error: 'network_error' };
    const policy = args.preparedRequest?.operation === 'update' ? args.preparedRequest.body.policy : undefined;
    if (!serverRecord || !policy) throw new Error('Expected a policy-only update');
    serverRecord = { ...serverRecord, policy, snapshot: projectPublicProfileSnapshot(serverRecord.snapshot!, policy) };
    if (options.uncertain) throw Object.assign(new Error('Connection lost after commit'), { code: 'outcome_unknown' });
    return { kind: 'updated', record: serverRecord };
  };
  const executor = createActionExecutor({ homeDomainAction,
    publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
  } as ActionExecutorDeps);
  const execution = { execute: (id: Parameters<typeof executor.execute>[0], value: unknown) => executor.execute(id, value,
    { surface: 'ui', authority: 'present_user', serverId: 'home', expectedAccountId: 'account' }) };
  const hook = await renderHook(() => {
    const owner = usePublicProfileOwnerRead({ ready: true, executeValue: async (id, value) => {
      const result = await execution.execute(id, value);
      if (!result.ok) throw new Error(result.errorCode);
      return result.result;
    } });
    const record = owner.state.kind === 'ready' && owner.state.read.kind === 'ready' ? owner.state.read.record : null;
    const [draft, setDraft] = React.useState<PublicProfileDraft | null>(() => ({
      ...createPublicProfileDraft(serverRecord, { layout }),
      layout: { v: 1, items: [{ kind: 'widget', id: 'private-draft', size: 'medium', frameStyle: 'plain',
        presentation: { kind: 'usage', widgetId: 'usage_planet', inputs: {} } }] },
      appearance: createPublicProfileDraft(null, { layout }).appearance,
    }));
    const consent = usePublicProfileConsent({ record, draft, setDraft, execution, onAcknowledged: owner.acknowledge });
    return { ...consent, record, draft, reload: owner.reload };
  });
  return { hook, writes, release };
}

describe('published profile consent', () => {
  it('acknowledges a hide without Usage and refuses an Undo that cannot prepare its widened facts', async () => {
    const { hook, writes, release } = await setup();
    const privateLayout = hook.getCurrent().draft!.layout;
    const privateLook = hook.getCurrent().draft!.appearance;
    let pending!: Promise<void>;
    await act(async () => { pending = hook.getCurrent().updateField('activeDays', false); });
    expect(writes).toEqual([{ policy: { ...initialRecord.policy, fields: { ...initialRecord.policy!.fields, activeDays: false } } }]);
    expect(hook.getCurrent().state.kind).toBe('pending');
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(true);
    await act(async () => { await hook.getCurrent().updateField('tokens', false); });
    expect(writes).toHaveLength(1);
    await act(async () => { release(); await pending; });
    expect(hook.getCurrent().state).toMatchObject({ kind: 'acknowledged' });
    expect(hook.getCurrent().record!.snapshot!.facts).not.toHaveProperty('activeDays');
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(false);
    expect(hook.getCurrent().draft!.layout).toBe(privateLayout);
    expect(hook.getCurrent().draft!.appearance).toBe(privateLook);
    await act(async () => { await hook.getCurrent().undo(); });
    expect(hook.getCurrent().state).toMatchObject({ kind: 'failed', errorCode: 'public_profile_preparation_unavailable' });
    expect(writes).toHaveLength(1);
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(false);
    expect(hook.getCurrent().record!.snapshot!.facts).not.toHaveProperty('activeDays');
    await act(async () => { await hook.getCurrent().reload(); });
    expect(hook.getCurrent().record!.policy!.fields.activeDays).toBe(false);
  });

  it('reconciles an uncertain response by reading the committed policy without replaying the write', async () => {
    const { hook, release, writes } = await setup({ uncertain: true });
    const privateLayout = hook.getCurrent().draft!.layout;
    let pending!: Promise<void>;
    await act(async () => { pending = hook.getCurrent().updateField('activeDays', false); });
    await act(async () => { release(); await pending; });
    expect(hook.getCurrent().state).toMatchObject({ kind: 'failed', errorCode: 'action_uncertain' });
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(true);
    await act(async () => { await hook.getCurrent().reload(); });
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(false);
    expect(hook.getCurrent().draft!.layout).toBe(privateLayout);
    expect(writes).toHaveLength(1);
  });

  it('keeps a failed hide visibly unacknowledged and preserves the prior policy', async () => {
    const { hook, release } = await setup({ refuse: true });
    let pending!: Promise<void>;
    await act(async () => { pending = hook.getCurrent().updateField('activeDays', false); });
    await act(async () => { release(); await pending; });
    expect(hook.getCurrent().state.kind).toBe('failed');
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(true);
    expect(hook.getCurrent().record!.policy!.fields.activeDays).toBe(true);
  });

  it('keeps first-publish consent private', async () => {
    const { hook, writes } = await setup({ published: false });
    await act(async () => { await hook.getCurrent().updateField('activeDays', false); });
    expect(hook.getCurrent().draft!.policy.fields.activeDays).toBe(false);
    expect(hook.getCurrent().state.kind).toBe('idle');
    expect(writes).toEqual([]);
  });
});
