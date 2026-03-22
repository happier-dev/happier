import { describe, expect, it } from 'vitest';

import {
    resolveExecutionRunLauncherIntent,
} from './executionRunLauncherModel';

describe('resolveExecutionRunLauncherIntent', () => {
    it('keeps supported launcher intents and rejects valid but unsupported execution-run intents', () => {
        expect(resolveExecutionRunLauncherIntent('review')).toBe('review');
        expect(resolveExecutionRunLauncherIntent('plan')).toBe('plan');
        expect(resolveExecutionRunLauncherIntent('delegate')).toBe('delegate');
        expect(resolveExecutionRunLauncherIntent('voice_agent')).toBeNull();
        expect(resolveExecutionRunLauncherIntent('memory_hints')).toBeNull();
    });

    it('rejects unknown intents instead of rewriting them', () => {
        expect(resolveExecutionRunLauncherIntent('bogus')).toBeNull();
        expect(resolveExecutionRunLauncherIntent({ intent: 'delegate' })).toBeNull();
    });
});
