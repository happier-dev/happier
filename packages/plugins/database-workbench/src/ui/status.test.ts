import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { projectWorkbenchStatus } from './hooks.js';

it('does not label a declined resource read as an offline Machine', () => {
    const error = new PluginError({ code: 'denied' });
    expect(projectWorkbenchStatus({ status: 'failed', error })).toBe('unavailable');
    expect(projectWorkbenchStatus({ status: 'failed', data: ['held row'], error })).toBe('stale');
});
