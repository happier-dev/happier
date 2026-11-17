import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PublicProfileOwnerRecordV1Schema, PublicProfileOwnerReadV1Schema, PublicProfileUpdateBodyV1Schema, PublicProfileMutationResultV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileLayoutV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfileSnapshot } from '@happier-dev/protocol/account/projectPublicProfile';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createPublicProfileDraft, type PublicProfileDraft } from './publicProfileDraft';
import { usePublicProfileConsent } from './usePublicProfileConsent';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';

// The Metro loader and Home HTTP are boundaries; mounted execution and preparation stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const account = createProviderSettingsAccountHarness();
const disposeLoader = await installRealActionExecutorModuleLoader();
const pendingReleases: Array<() => void> = [];
afterAll(() => disposeLoader());
afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release();
  standardCleanup();
  await account.reset();
});

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
  pendingReleases.push(release);
  await account.restore({ currentAccount: true,
    waivedActions: ['account.public_profile.update'],
    features: createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } }),
    httpAnswers: {
      'GET /v1/account/public-profile': { select: () => ({ body: PublicProfileOwnerReadV1Schema.parse(serverRecord
        ? { kind: 'ready', context, record: serverRecord } : { kind: 'absent', context }) }) },
      'POST /v2/usage/query': { status: 503, body: { error: 'usage_unavailable' } },
      'PUT /v1/account/public-profile/policy': { select: async input => {
        const request = PublicProfileUpdateBodyV1Schema.parse(input);
        writes.push(request);
        await held;
        if (options.refuse) return { status: 503, body: { error: 'unavailable' } };
        const policy = request.policy;
        if (!serverRecord || !policy) throw new Error('Expected a policy-only update');
        serverRecord = PublicProfileOwnerRecordV1Schema.parse({ ...serverRecord, policy,
          snapshot: projectPublicProfileSnapshot(serverRecord.snapshot!, policy) });
        if (options.uncertain) return { dispatchThenFail: true };
        return { body: PublicProfileMutationResultV1Schema.parse({ kind: 'updated', record: serverRecord }) };
      } },
    },
  });
  const scope = { serverId: account.serverId, accountId: 'account-a' };
  const hook = await renderHook(() => {
    const execution = useMountedActionExecution(scope);
    const owner = usePublicProfileOwnerRead(execution, scope);
    const record = owner.state.kind === 'ready' && owner.state.read.kind === 'ready' ? owner.state.read.record : null;
    const [draft, setDraft] = React.useState<PublicProfileDraft | null>(() => ({
      ...createPublicProfileDraft(serverRecord, { layout }),
      layout: { v: 1, items: [{ kind: 'widget', id: 'private-draft', size: 'medium', frameStyle: 'plain',
        presentation: { kind: 'usage', widgetId: 'usage_planet', inputs: {} } }] },
      appearance: createPublicProfileDraft(null, { layout }).appearance,
    }));
    const consent = usePublicProfileConsent({ record, draft, setDraft, execution, onAcknowledged: owner.acknowledge });
    return { ...consent, record, draft, reload: owner.reload, ownerReady: owner.state.kind === 'ready' };
  });
  await vi.waitFor(() => expect(hook.getCurrent().ownerReady).toBe(true));
  return { hook, writes, release };
}

describe('published profile consent', () => {
  it('acknowledges a hide without Usage and refuses an Undo that cannot prepare its widened facts', async () => {
    const { hook, writes, release } = await setup();
    const privateLayout = hook.getCurrent().draft!.layout;
    const privateLook = hook.getCurrent().draft!.appearance;
    let pending!: Promise<void>;
    await act(async () => { pending = hook.getCurrent().updateField('activeDays', false); });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
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
