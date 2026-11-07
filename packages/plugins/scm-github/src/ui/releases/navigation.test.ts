import { describe, expect, it } from 'vitest';
import { createReleaseLocationBindingV1, releaseDetailLocationsV1 } from './navigation.js';

describe('release pane and full-page location binding', () => {
  it('uses declared back locations and renders a different valid host settlement without reads', async () => {
    const calls: unknown[] = [];
    const binding = createReleaseLocationBindingV1({ subPath: '7', host: { async replacePageLocation(subPath, options) {
      calls.push({ subPath, ...options }); return { subPath: '7/page' };
    } } });
    expect(await binding.replace(releaseDetailLocationsV1('7').fullPageLocation)).toBe(true);
    expect(binding.getSnapshot()).toEqual({ subPath: '7/page', kind: 'detail', releaseId: '7', fullPage: true });
    expect(calls).toEqual([{ subPath: '7/page', backLocation: '7' }]);
    let guardCalls = 0;
    const different = createReleaseLocationBindingV1({ subPath: '7/page', canLeave: () => { guardCalls++; return guardCalls === 1; },
      host: { async replacePageLocation() { return { subPath: '8' }; } } });
    expect(await different.replace(releaseDetailLocationsV1('7').returnLocation)).toBe(true);
    expect(different.getSnapshot()?.subPath).toBe('8');
    expect(guardCalls).toBe(1);
  });
  it('retains the prior selected editor on refusal, invalid settlement or unsaved-change rejection', async () => {
    for (const settled of ['../7', 'not-a-release']) {
      const binding = createReleaseLocationBindingV1({ subPath: '7', host: { async replacePageLocation() { return { subPath: settled }; } } });
      const before = binding.getSnapshot();
      expect(await binding.replace({ subPath: '7/page', backLocation: '7' })).toBe(false);
      expect(binding.getSnapshot()).toBe(before);
    }
    const binding = createReleaseLocationBindingV1({ subPath: 'compose', canLeave: () => false,
      host: { async replacePageLocation() { throw new Error('Must not navigate with unsaved changes'); } } });
    const before = binding.getSnapshot();
    expect(await binding.replace({ subPath: '', backLocation: '' })).toBe(false);
    expect(binding.getSnapshot()).toBe(before);
  });
});
