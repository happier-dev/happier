import { expect, it } from 'vitest';
import { createDeploymentVariableBindingV1 } from '../testing/v1.js';
import { createDeploymentTargetVariableSyncV1 } from './variables.js';

function binding(name: string, value: string, phase: 'build' | 'runtime' = 'runtime') {
    return createDeploymentVariableBindingV1({ name, phase, source: { kind: 'value', value } });
}

function variable(key: string, providerId: string, providerRevision?: string) {
    return { key, providerId, secret: false, ...(providerRevision === undefined ? {} : { providerRevision }) };
}

function ownership(key: string, providerId: string) {
    return { key, providerId, providerRevision: 'before', desiredRevision: 1 };
}

it('only transfers or removes exact ownership after reviewed conflict resolution and provider acknowledgement', () => {
    const pending = variable('PENDING', 'pending-id', 'before');
    const removed = variable('REMOVE', 'remove-id', 'before');
    const replacement = variable('REPLACED', 'replacement-id');
    const kept = variable('KEEP', 'keep-id', 'after');
    const unknownRevision = variable('UNKNOWN', 'unknown-revision-id');
    const review = createDeploymentTargetVariableSyncV1({
        desiredRevision: 2,
        owned: [ownership('PENDING', pending.providerId), ownership('REMOVE', removed.providerId),
            ownership('REPLACED', 'retired-id'), ownership('KEEP', kept.providerId),
            ownership('CHANGED', 'changed-id'), ownership('UNKNOWN', unknownRevision.providerId)],
        set: [binding('DUPLICATE', 'runtime'), binding('DUPLICATE', 'build', 'build'), binding('KEEP', 'ignored'),
            binding('CHANGED', 'drift'), binding('ADOPT', 'reviewed'), binding('UNKNOWN', 'has-no-revision'),
            binding('OPAQUE', 'disallowed'), binding('UNSUPPORTED', 'not-available', 'build')],
        remove: [pending.key, removed.key, replacement.key, kept.key],
        keepTheirs: [kept.key], useOurs: ['ADOPT', 'OPAQUE'],
    }, [pending, removed, replacement, kept, unknownRevision, variable('CHANGED', 'changed-id', 'after'),
        variable('ADOPT', 'adopt-id', 'before')], { opaqueKeys: new Set(['OPAQUE']), unsupportedSetKeys: new Set(['UNSUPPORTED']) });

    expect(review.set.map(value => value.name)).toEqual(['ADOPT', 'UNKNOWN']);
    expect(review.remove).toEqual([pending, removed]);
    review.acknowledgeSet(variable('ADOPT', 'adopt-id', 'after'));
    review.acknowledgeRemove(removed.key);
    review.fail(pending.key, 'outcome_unknown');
    const result = review.result();
    expect(result.owned).toEqual([ownership('PENDING', pending.providerId), ownership('CHANGED', 'changed-id'),
        ownership('UNKNOWN', unknownRevision.providerId), { ...ownership('ADOPT', 'adopt-id'), providerRevision: 'after', desiredRevision: 2 }]);
    expect(result.variables).toEqual([
        { ...pending, present: true, owned: true, drift: 'current' },
        { ...replacement, present: true, owned: false, drift: 'unknown' },
        { ...kept, present: true, owned: false, drift: 'unknown' },
        { ...unknownRevision, present: true, owned: true, drift: 'unknown' },
        { ...variable('CHANGED', 'changed-id', 'after'), present: true, owned: true, drift: 'changed' },
        { ...variable('ADOPT', 'adopt-id', 'after'), present: true, owned: true, drift: 'current' },
    ]);
    expect(result.failures).toEqual([
        { key: 'DUPLICATE', code: 'deployment_conflict' }, { key: 'CHANGED', code: 'deployment_conflict' },
        { key: 'OPAQUE', code: 'deployment_conflict' }, { key: 'UNSUPPORTED', code: 'deployment_content_unavailable' },
        { key: 'PENDING', code: 'outcome_unknown' },
    ]);
});
