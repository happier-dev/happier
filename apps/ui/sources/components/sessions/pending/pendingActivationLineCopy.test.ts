import { describe, expect, it } from 'vitest';

import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import { pendingActivationLineCopy } from './pendingActivationLineCopy';

describe('pendingActivationLineCopy', () => {
  it.each(['queued_offline', 'held_offline', 'waiting_offline'] as const)(
    'names the offline Machine the message waits for (%s)',
    (kind) => {
      const copy = pendingActivationLineCopy(kind, 'Studio Mac');
      expect(copy.text).toContain('Studio Mac');
      expect(copy.detail).not.toBe(copy.text);
    },
  );

  it('tells a stopped Session apart from an unstopped one while the Machine is offline', () => {
    expect(
      pendingActivationLineCopy('held_offline', 'Studio Mac').text,
    ).not.toBe(pendingActivationLineCopy('queued_offline', 'Studio Mac').text);
  });

  it('says the Machine is back when the held message can resume', () => {
    expect(pendingActivationLineCopy('held', 'Studio Mac', 'resume').text).toBe('Studio Mac is back ·');
  });

  it('keeps the existing held copy while reachability is unknown', () => {
    expect(pendingActivationLineCopy('held', 'Studio Mac').text).toBe('Stopped');
  });

  it('keeps the existing held-offline line', () => {
    expect(pendingActivationLineCopy('held_offline', 'Studio Mac').text).toBe(
      'Stopped · resume once Studio Mac is back',
    );
  });

  it('uses the existing Machine fallback when the name is unavailable', () => {
    expect(pendingActivationLineCopy('held', getMachineSentenceName(null), 'resume').text).toBe(
      'This machine is back ·',
    );
  });

  it('keeps the full name of a Machine with a long right-to-left name', () => {
    const machine = 'محطة التطوير الرئيسية لاختبار التطبيقات على شبكة المكتب';
    expect(pendingActivationLineCopy('held', machine, 'resume').text).toBe(`${machine} is back ·`);
  });

  it.each(['queued', 'held', 'waiting', 'failed'] as const)(
    'says no Machine condition once it is reachable (%s)',
    (kind) => {
      expect(pendingActivationLineCopy(kind, 'Studio Mac').text).not.toContain(
        'Studio Mac',
      );
    },
  );
});
