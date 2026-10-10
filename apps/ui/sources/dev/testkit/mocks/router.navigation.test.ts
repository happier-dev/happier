import { describe, expect, it, vi } from 'vitest';
import { createExpoRouterMock } from './router';

describe('Expo navigation boundary', () => {
    it('supplies the navigator when no override was requested', () => {
        const navigator = createExpoRouterMock().module.useNavigation();
        expect(navigator).toMatchObject({ setOptions: expect.any(Function) });
    });

    it('preserves the supplied navigator and its option updates', () => {
        const navigator = { setOptions: vi.fn() };
        const observed = createExpoRouterMock({ navigation: navigator }).module.useNavigation();
        expect(observed).toBe(navigator);
        navigator.setOptions({ title: 'Detail' });
        expect(navigator.setOptions).toHaveBeenCalledWith({ title: 'Detail' });
    });

    it('keeps an explicitly absent navigator absent', () => {
        expect(createExpoRouterMock({ navigation: null }).module.useNavigation()).toBeNull();
    });
});
