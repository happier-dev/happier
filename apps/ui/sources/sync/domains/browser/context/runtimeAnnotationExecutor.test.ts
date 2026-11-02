import { describe, expect, it } from 'vitest';
import { createBrowserAnnotationRuntimeExecutor } from './runtimeAnnotationExecutor';

describe('browser annotation runtime request boundary', () => {
    it('separates malformed draft comments from a valid request whose mounted view is unavailable', async () => {
        const execute = createBrowserAnnotationRuntimeExecutor({});
        const target = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 2 };
        expect(await execute('browser.context.annotation.setDraftComment', { ...target, comment: 42 }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await execute('browser.context.annotation.setDraftComment', {
            browserSessionId: target.browserSessionId, viewId: target.viewId, comment: 'Fix this',
        })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await execute('browser.context.annotation.setDraftComment', { ...target, comment: 'Fix this' }))
            .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    });
});
