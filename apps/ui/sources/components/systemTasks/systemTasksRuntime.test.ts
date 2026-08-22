import { describe, expect, it } from 'vitest';

import { resolveSystemTaskRunnerMode } from './systemTasksRuntime';

describe('resolveSystemTaskRunnerMode', () => {
    it('selects native system tasks automatically on iOS and Android when no explicit mode is set', () => {
        expect(resolveSystemTaskRunnerMode({
            explicitMode: '',
            isDesktopHost: false,
            nodeEnv: 'production',
            platformOS: 'ios',
        })).toBe('native');
        expect(resolveSystemTaskRunnerMode({
            explicitMode: '',
            isDesktopHost: false,
            nodeEnv: 'production',
            platformOS: 'android',
        })).toBe('native');
    });

    it('keeps web production unavailable unless desktop or explicit mode is present', () => {
        expect(resolveSystemTaskRunnerMode({
            explicitMode: '',
            isDesktopHost: false,
            nodeEnv: 'production',
            platformOS: 'web',
        })).toBe('unavailable');
    });
});
