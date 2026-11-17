import { expect, it, vi } from 'vitest';
import { beginThemeSurfaceInspection, createThemeSurfaceInspectionBinding } from './themeSurfaceInspection.js';

it('claims the touched native paint host only while picking and releases unmounted refs', () => {
    const selected = vi.fn();
    const address = { surface: 'composer', part: 'send' } as const;
    const binding = createThemeSurfaceInspectionBinding(address);
    const host = { measureInWindow: vi.fn() };
    binding.ref(host);
    expect(binding.onStartShouldSetResponder()).toBe(false);
    const stop = beginThemeSurfaceInspection(selected);
    expect(binding.onStartShouldSetResponder()).toBe(true);
    expect(selected).toHaveBeenCalledWith(address, host);
    stop();
    expect(binding.onStartShouldSetResponder()).toBe(false);
    expect(host.measureInWindow).not.toHaveBeenCalled();
    binding.ref(null);
    const stopAgain = beginThemeSurfaceInspection(selected);
    expect(binding.onStartShouldSetResponder()).toBe(true);
    expect(selected).toHaveBeenCalledTimes(1);
    stopAgain();
});
