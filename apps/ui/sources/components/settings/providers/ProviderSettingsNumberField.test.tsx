import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_PROVIDER_SETTINGS_PLUGIN } from '@/agents/providers/claude/settings/plugin';
import type { ProviderSettingFieldDef } from '@/agents/providers/shared/providerSettingsPlugin';
import { changeTextTestInstance, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();

describe('Claude provider number fields', () => {
    afterEach(standardCleanup);

    it.each([
        { key: 'claudeLocalPermissionBridgeTimeoutSeconds', values: [300, 600, 900, 601] },
        { key: 'claudeRemoteMaxThinkingTokens', values: [1000, 1024, 2048, 4096, 32000] },
    ])('accepts positive integer values for $key and rejects invalid input', async ({ key, values }) => {
        const field = CLAUDE_PROVIDER_SETTINGS_PLUGIN.uiSections
            .flatMap((section) => section.fields)
            .find((candidate) => candidate.key === key);
        if (!field) throw new Error(`Missing provider field: ${key}`);
        const definition = CLAUDE_PROVIDER_SETTINGS_PLUGIN.settings[key]!;
        const saved = vi.fn();
        const { ProviderSettingsNumberField } = await import('./ProviderSettingsNumberField');

        function FieldHarness() {
            const [value, setValue] = React.useState<unknown>(definition.default);
            const [localInputs, setLocalInputs] = React.useState<Record<string, string>>({});
            const setFieldValue = (_field: ProviderSettingFieldDef, next: unknown) => {
                // Persist only values accepted by the real provider schema.
                const parsed = definition.schema.parse(next);
                saved(parsed);
                setValue(parsed);
            };
            return <ProviderSettingsNumberField
                field={field!}
                value={value}
                localInputs={localInputs}
                setLocalInputs={setLocalInputs}
                setFieldValue={setFieldValue}
            />;
        }

        const screen = await renderScreen(<FieldHarness />);
        expect(screen.getTextContent()).not.toContain('settingsProviders.invalidNumber');
        expect(saved).not.toHaveBeenCalled();

        for (const value of values) {
            await act(async () => {
                changeTextTestInstance(screen.findByType('TextInput'), String(value));
            });
            expect(saved).toHaveBeenLastCalledWith(value);
            expect(screen.getTextContent()).not.toContain('settingsProviders.invalidNumber');
        }

        for (const raw of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
            saved.mockClear();
            await act(async () => {
                changeTextTestInstance(screen.findByType('TextInput'), raw);
            });
            expect(saved).not.toHaveBeenCalled();
            expect(screen.getTextContent()).toContain('settingsProviders.invalidNumber');
        }
    });
});
