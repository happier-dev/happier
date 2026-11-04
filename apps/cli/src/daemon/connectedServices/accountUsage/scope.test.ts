import { expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol';
import { createProviderAccountUsageStores } from './scope';

it('shares usage observations for Sessions and detached Runs only within one Home and Account', () => {
    const owner = createProviderAccountUsageStores();
    const scope = { serverId: 'home-a', accountId: 'alice' };
    const session = owner.forAccount(scope);
    const run = owner.forAccount({ ...scope });
    const source = { serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', bindingKind: 'group_member' as const, groupId: 'pool', groupGeneration: 7 };
    const recordKey = { providerId: 'openai-codex', accountSubjectId: 'subscription', subjectKind: 'account' as const, quotaScope: 'account' as const };
    session.recordSnapshot({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'openai-codex', accountSubject: { kind: 'providerSubject', id: 'subscription' },
        observedAtMs: 900, fetchedAtMs: 900, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'unknown', remainingPct: 0,
            utilizationPct: 100, resetsAt: 100_000, status: 'ok', details: {} }] }, { sources: [source] });
    expect(run.resolveBySource(source)?.meters[0]?.remainingPct).toBe(0);
    expect(owner.forAccount({ ...scope, accountId: 'bob' }).resolveBySource(source)).toBeNull();
    expect(owner.forAccount({ ...scope, serverId: 'home-b' }).resolveBySource(source)).toBeNull();
});
