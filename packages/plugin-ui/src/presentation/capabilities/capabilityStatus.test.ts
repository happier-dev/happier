import { describe, expect, it } from 'vitest';

import {
  pickMostBlockingHappierCapabilityStatus,
  presentHappierCapabilityStatus,
  resolveHappierCapabilityBlockingNotice,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
} from './capabilityStatus.js';

const labels: HappierCapabilityStatusLabels = {
  status: (kind, machine) => (machine === undefined ? kind : `${kind}@${machine}`),
  fix: (kind) => `fix:${kind}`,
};
const status = (kind: HappierCapabilityStatus['kind'], extra: Partial<HappierCapabilityStatus> = {}): HappierCapabilityStatus => ({ kind, ...extra });
const present = (value: HappierCapabilityStatus, placement: HappierCapabilityStatusPlacement = 'row') =>
  presentHappierCapabilityStatus(value, placement, labels);

describe('presentHappierCapabilityStatus', () => {
  it('uses plain canonical words in catalog rows while retaining row silence, tone and fix', () => {
    for (const kind of ['cantrun', 'masked', 'revoked', 'error'] as const) {
      const value = status(kind);
      const catalog = presentHappierCapabilityStatus(value, 'catalog', labels);
      expect(catalog.pill).toEqual({ ...present(value).pill, chrome: 'plain' });
      expect(catalog.tone).toBe(present(value).tone);
      expect(catalog.fixLabel).toBe(present(value).fixLabel);
      expect(catalog.blockingRank).toBe(present(value).blockingRank);
    }
    for (const kind of ['ready', 'off', 'connected'] as const) {
      expect(presentHappierCapabilityStatus(status(kind), 'catalog', labels).pill).toBeNull();
    }
  });

  it('keeps healthy silent and names the one fix for a problem', () => {
    expect(present(status('ready')).pill).toBeNull();
    const signin = present(status('signin'));
    expect(signin.pill).toMatchObject({ variant: 'attention', chrome: 'pill', label: 'signin' });
    expect(signin.tone).toBe('needs_you');
    expect(signin.fixLabel).toBe('fix:sign_in');
    const access = present(status('more_access'));
    expect(access.fixLabel).toBe('fix:grant_access');
    expect(access.blockingRank).toBe(signin.blockingRank);
    expect(present(status('error', { machineName: 'nl2' })).pill).toMatchObject({ variant: 'danger', label: 'error@nl2' });
    // The caller's fix kind wins over the status's default fix.
    expect(present(status('error', { fix: { kind: 'reconnect', onPress: () => {} } })).fixLabel).toBe('fix:reconnect');
  });

  it('keeps the pill short and hands a stop or a blocked run its reason to say on its own line', () => {
    const stopped = present(status('error', { machineName: 'nl2', detail: 'sign-in not passed' }));
    expect(stopped.pill?.detail).toBeUndefined();
    expect(stopped.reason).toBe('sign-in not passed');
    expect(present(status('cantrun', { detail: 'node is missing' })).reason).toBe('node is missing');
    const expired = present(status('expired', { detail: 'Oct 10' }));
    expect(expired.pill?.detail).toBe('Oct 10');
    expect(expired.reason).toBeUndefined();
  });

  it('is silent for Off and Connected in rows and plain in headers', () => {
    expect(present(status('off')).pill).toBeNull();
    expect(present(status('off')).fixLabel).toBeUndefined();
    expect(present(status('off'), 'header').pill).toMatchObject({ chrome: 'plain', label: 'off' });
    expect(present(status('connected')).pill).toBeNull();
    expect(present(status('connected'), 'header').pill).toMatchObject({ chrome: 'plain', label: 'connected' });
  });
});

describe('pickMostBlockingHappierCapabilityStatus', () => {
  it('lets the most blocking drawn status win at each placement', () => {
    expect(pickMostBlockingHappierCapabilityStatus([status('offline'), status('error')])?.kind).toBe('error');
    expect(pickMostBlockingHappierCapabilityStatus([status('unused'), status('update')])?.kind).toBe('update');
    expect(pickMostBlockingHappierCapabilityStatus([status('off'), status('unused')], 'row')?.kind).toBe('unused');
    expect(pickMostBlockingHappierCapabilityStatus([status('off'), status('unused')], 'header')?.kind).toBe('off');
    expect(pickMostBlockingHappierCapabilityStatus([status('ready'), status('off')], 'row')).toBeNull();
  });
});

describe('resolveHappierCapabilityBlockingNotice', () => {
  it('leads only blocking pages, amber with the fix for needs-you and rose with a quieter fix for a failure', () => {
    const onPress = () => {};
    expect(resolveHappierCapabilityBlockingNotice(status('update', { fix: { kind: 'review_update', onPress } }), labels)).toBeNull();
    expect(resolveHappierCapabilityBlockingNotice(status('key', { fix: { kind: 'add_key', onPress } }), labels))
      .toEqual({ tone: 'warning', action: { label: 'fix:add_key', onPress } });
    expect(resolveHappierCapabilityBlockingNotice(status('error', { fix: { kind: 'try_again', onPress } }), labels))
      .toEqual({ tone: 'danger', action: { label: 'fix:try_again', onPress, display: 'secondary' } });
    expect(resolveHappierCapabilityBlockingNotice(status('signin'), labels)).toEqual({ tone: 'warning', action: null });
  });
});
