import { describe, expect, it } from 'vitest';
import { createActionExecutor, ActionsSettingsV1Schema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

describe('host read Action preparation', () => {
    it('uses canonical settings admission before a read can join retained Resource output', async () => {
        const executor = createActionExecutor({ isActionApprovalRequired: () => false } as ActionExecutorDeps);
        const execute = createFrontDoorActionExecute(executor);
        const prepare = execute.prepare;
        expect(typeof prepare).toBe('function');
        const result = await prepare('settings.get', { anchor: 'themePreference' }, {
            surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'acme.preview' },
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.get': { enabled: false } } }),
        });
        expect(result).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
    });
});
