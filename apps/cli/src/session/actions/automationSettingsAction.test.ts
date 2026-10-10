import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationV3SettingsSchema, type AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';

import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';

afterEach(() => vi.restoreAllMocks());

describe('headless Automation setting declarations', () => {
    const baseUrl = 'https://automation-owner.test';
    const credentials = { token: 'automation-account', encryption: null };
    const capAnchor = 'settings.workflowRuns.maxActiveRunsPerMachine';
    const retentionAnchor = 'settings.workflowRuns.runRetention';

    it.each([
        { anchor: capAnchor, value: 2_147_483_647, expected: { maxActiveRunsPerMachine: 2_147_483_647, runRetention: 'keepForever' } },
        { anchor: retentionAnchor, value: 'thirtyDays', expected: { maxActiveRunsPerMachine: 17, runRetention: 'thirtyDays' } },
    ] as const)('writes $anchor through the server owner and preserves its sibling', async ({ anchor, value, expected }) => {
        let persisted: AutomationV3Settings = { maxActiveRunsPerMachine: 17, runRetention: 'keepForever' };
        // Only HTTP is replaced: declaration admission, domain mutation and strict schemas remain real.
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            expect(url).toBe(`${baseUrl}/v3/automations/settings`);
            expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
            return { data: persisted };
        });
        vi.spyOn(axios, 'put').mockImplementation(async (url, body, config) => {
            expect(url).toBe(`${baseUrl}/v3/automations/settings`);
            expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
            persisted = AutomationV3SettingsSchema.parse(body);
            return { data: persisted };
        });
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        expect(await action({ actionId: 'settings.set', input: { anchor, value }, context: { surface: 'cli' } }))
            .toEqual({ anchor, value });
        expect(persisted).toEqual(expected);
        expect(await action({ actionId: 'settings.get', input: { anchor }, context: { surface: 'cli' } }))
            .toEqual({ anchor, value });
    });

    it.each([
        { anchor: capAnchor, value: 0 },
        { anchor: retentionAnchor, value: 'invented' },
    ])('rejects invalid $anchor without reading or writing the server', async input => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        expect(await action({ actionId: 'settings.set', input, context: { surface: 'cli' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it.each([
        { actionId: 'settings.get', input: { anchor: capAnchor, includeVersion: true } },
        { actionId: 'settings.set', input: { anchor: capAnchor, value: 3, expectedSettingsVersion: 1 } },
        { actionId: 'settings.set', input: { anchor: retentionAnchor, value: 'thirtyDays', reversal: { kind: 'capture' } } },
    ] as const)('rejects Account preference version/reversal semantics for $actionId', async request => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        expect(await action({ ...request, context: { surface: 'cli' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_conditional_mutation_unsupported' });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it('does not write after the captured credential retires during the read', async () => {
        let current = true;
        vi.spyOn(axios, 'get').mockImplementation(async () => {
            current = false;
            return { data: { maxActiveRunsPerMachine: 7, runRetention: 'keepForever' } };
        });
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl,
            isCredentialCurrent: () => current });
        expect(await action({ actionId: 'settings.set', input: { anchor: capAnchor, value: 3 }, context: { surface: 'cli' } }))
            .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
        expect(write).not.toHaveBeenCalled();
    });

    it('does not write when cancelled during the server read', async () => {
        const controller = new AbortController();
        vi.spyOn(axios, 'get').mockImplementation(async () => {
            controller.abort();
            return { data: { maxActiveRunsPerMachine: 7, runRetention: 'keepForever' } };
        });
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        await expect(action({ actionId: 'settings.set', input: { anchor: capAnchor, value: 3 },
            context: { surface: 'cli', signal: controller.signal } })).rejects.toMatchObject({ name: 'AbortError' });
        expect(write).not.toHaveBeenCalled();
    });

    it('does not disclose the updated field after the captured credential retires during the write', async () => {
        let current = true;
        let persisted: AutomationV3Settings = { maxActiveRunsPerMachine: 7, runRetention: 'keepForever' };
        vi.spyOn(axios, 'get').mockResolvedValue({ data: persisted });
        vi.spyOn(axios, 'put').mockImplementation(async (_url, body) => {
            persisted = AutomationV3SettingsSchema.parse(body);
            current = false;
            return { data: persisted };
        });
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl,
            isCredentialCurrent: async () => current });
        expect(await action({ actionId: 'settings.set', input: { anchor: capAnchor, value: 3 }, context: { surface: 'cli' } }))
            .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
        expect(persisted).toEqual({ maxActiveRunsPerMachine: 3, runRetention: 'keepForever' });
    });

    it('preserves a server admission refusal without writing through another owner', async () => {
        const refusal = Object.assign(new Error('automation feature disabled'), { response: { status: 404 } });
        vi.spyOn(axios, 'get').mockRejectedValue(refusal);
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        await expect(action({ actionId: 'settings.set', input: { anchor: capAnchor, value: 3 }, context: { surface: 'cli' } }))
            .rejects.toBe(refusal);
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects malformed full records before disclosing a setting or replacing a sibling', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ data: { maxActiveRunsPerMachine: 7, runRetention: 'invented' } });
        const write = vi.spyOn(axios, 'put');
        const action = createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: baseUrl });
        await expect(action({ actionId: 'settings.get', input: { anchor: capAnchor }, context: { surface: 'cli' } }))
            .rejects.toBeDefined();
        await expect(action({ actionId: 'settings.set', input: { anchor: capAnchor, value: 3 }, context: { surface: 'cli' } }))
            .rejects.toBeDefined();
        expect(write).not.toHaveBeenCalled();
    });
});
