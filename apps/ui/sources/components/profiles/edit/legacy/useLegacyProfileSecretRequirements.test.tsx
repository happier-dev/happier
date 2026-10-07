import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import type { SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useLegacyProfileSecretRequirements } from './useLegacyProfileSecretRequirements';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';

const previousSettings = storage.getState().settings;
afterEach(() => storage.setState({ settings: previousSettings }));

const capture = vi.hoisted(() => ({
    modalShow: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: unknown[]) => capture.modalShow(...args),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('useLegacyProfileSecretRequirements', () => {
    it('keeps a selected default secret in the profile draft until save', async () => {
        capture.modalShow.mockReset();
        storage.setState({ settings: settingsParse({
            secrets: [{
                id: 'secret-1', name: 'OpenRouter', kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                createdAt: 1, updatedAt: 1,
            }],
        }) });
        const bindingsBefore = storage.getState().settings.currentSecretBindingsByProfileId;
        const profile = AIBackendProfileSchema.parse({
            id: 'profile-1',
            name: 'OpenRouter profile',
            environmentVariables: [{ name: 'TEST_API_KEY', value: '', isSecret: true }],
            envVarRequirements: [{ name: 'TEST_API_KEY', kind: 'secret', required: true }],
            isBuiltIn: false,
            createdAt: 1,
            updatedAt: 1,
            version: '1.0.0',
        });
        const hook = await renderHook(() => useLegacyProfileSecretRequirements({
            profile,
            profileName: profile.name,
            environmentVariables: profile.environmentVariables,
        }));

        act(() => hook.getCurrent().openDefaultSecretModalForSourceVar('TEST_API_KEY'));
        const modalConfig = capture.modalShow.mock.calls.at(-1)?.[0] as Readonly<{
            props: Readonly<{ onResolve: (result: SecretRequirementModalResult) => void }>;
        }>;
        await act(async () => {
            modalConfig.props.onResolve({
                action: 'selectSaved',
                envVarName: 'TEST_API_KEY',
                secretId: 'secret-1',
                setDefault: true,
            });
        });

        expect(hook.getCurrent().getDefaultSecretNameForSourceVar('TEST_API_KEY')).toBe('OpenRouter');
        expect(hook.getCurrent().profileSecretBindings).toEqual({ TEST_API_KEY: 'secret-1' });
        expect(storage.getState().settings.currentSecretBindingsByProfileId).toEqual(bindingsBefore);
    });
});
