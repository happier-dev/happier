import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createDeferred, renderScreen } from '@/dev/testkit';
import type { MachinePluginSettingsResult } from '@/sync/ops/machineContributionRegistryProjection';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const machinePluginSettingsGetMock = vi.hoisted(() => vi.fn());
const machinePluginSettingsSetMock = vi.hoisted(() => vi.fn());
const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSettingsGet: (...args: unknown[]) => machinePluginSettingsGetMock(...args),
    machinePluginSettingsSet: (...args: unknown[]) => machinePluginSettingsSetMock(...args),
}));

const PLUGIN_ID = 'acme.hooks';
const GROUP_ID = 'acme.hooks.settings';
const ENDPOINT_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.endpoint.input`;
const ENDPOINT_SAVE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.endpoint.save`;
const SECRET_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.input`;
const SECRET_SAVE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.save`;
const SWITCH_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.enabled`;

const SETTINGS_FIELDS: readonly PluginProjectionEditableSettingField[] = [
    {
        key: 'endpoint',
        control: 'text',
        valueType: 'string',
        valueSchema: { type: 'string' },
        title: 'Endpoint URL',
        subtitle: 'Used when hook handlers call the remote API.',
        order: 1,
        groupId: null,
        redaction: 'none',
        clearWhenEmpty: 'persist',
    },
    {
        key: 'apiToken',
        control: 'password',
        valueType: 'string',
        valueSchema: { type: 'string' },
        title: 'API token',
        subtitle: 'Stored locally for this plugin.',
        order: 2,
        groupId: null,
        redaction: 'secret',
        clearWhenEmpty: 'omit',
    },
    {
        key: 'enabled',
        control: 'switch',
        valueType: 'boolean',
        valueSchema: { type: 'boolean' },
        title: 'Enable hooks',
        subtitle: null,
        order: 3,
        groupId: null,
        redaction: 'none',
        clearWhenEmpty: 'persist',
        defaultBooleanValue: true,
    },
];

function createProjection(
    generation: number,
    fields: readonly PluginProjectionEditableSettingField[] = SETTINGS_FIELDS,
): PluginProjectionEntry {
    return {
        pluginId: PLUGIN_ID,
        title: 'Acme hooks',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation,
        generationLabel: String(generation),
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: [{
            id: GROUP_ID,
            pluginId: PLUGIN_ID,
            version: 1,
            title: 'Acme hook settings',
            storageScope: 'local',
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields,
        }],
    };
}

function settingsResult(
    values: Readonly<Record<string, unknown>>,
    redactedKeys: readonly string[] = ['apiToken'],
    revision = '0',
): Extract<MachinePluginSettingsResult, { supported: true }> {
    return {
        supported: true,
        snapshot: {
            protocolVersion: 1,
            pluginId: PLUGIN_ID,
            storageScope: 'local',
            revision,
            values,
            redactedKeys: [...redactedKeys],
        },
    };
}

const unsupportedResult: MachinePluginSettingsResult = {
    supported: false,
    reason: 'error',
};

async function flushAsync(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

async function renderSection(projection: PluginProjectionEntry = createProjection(1)) {
    const { PluginDetailGenericSettingsSection } = await import('./PluginDetailGenericSettingsSection');
    const element = (
        <PluginDetailGenericSettingsSection
            pluginId={PLUGIN_ID}
            projection={projection}
            machineId="machine-1"
            serverId="server-1"
            daemonOperationsAvailable
        />
    );
    const screen = await renderScreen(element);
    await flushAsync();
    return { PluginDetailGenericSettingsSection, element, screen };
}

function findSwitch(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => (
        typeof node.props?.onValueChange === 'function'
        && typeof node.props?.value === 'boolean'
    ))[0] ?? null;
}

function hasPressableTestIdAncestor(
    node: ReturnType<typeof findSwitch>,
    testID: string,
): boolean {
    let ancestor = node?.parent ?? null;
    while (ancestor) {
        if (ancestor.type === Pressable && ancestor.props?.testID === testID) return true;
        ancestor = ancestor.parent;
    }
    return false;
}

describe('PluginDetailGenericSettingsSection', () => {
    beforeEach(() => {
        platformEnvironment.platform = 'web';
        machinePluginSettingsGetMock.mockReset();
        machinePluginSettingsSetMock.mockReset();
        machinePluginSettingsGetMock.mockResolvedValue(settingsResult({
            endpoint: 'https://api.example.test',
            apiToken: 'must-not-render',
            enabled: true,
        }));
    });

    it('keeps generic text controls at least 44 points tall', async () => {
        const { screen } = await renderSection();

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ minHeight: 44 }),
        ]));
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ minHeight: 44 }),
        ]));
    });

    it('keeps generic text controls at least 48dp tall on Android', async () => {
        platformEnvironment.platform = 'android';
        try {
            const { screen } = await renderSection();
            expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.style).toEqual(expect.arrayContaining([
                expect.objectContaining({ minHeight: 48 }),
            ]));
            expect(screen.findByTestId(SECRET_INPUT_ID)?.props.style).toEqual(expect.arrayContaining([
                expect.objectContaining({ minHeight: 48 }),
            ]));
        } finally {
            platformEnvironment.platform = 'web';
        }
    });

    it('keeps retained values inert and performs no settings GET or SET while daemon operations are unavailable', async () => {
        const { PluginDetailGenericSettingsSection, screen } = await renderSection();
        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable={false}
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(false);
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://offline.example.test');
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            findSwitch(screen)?.props.onValueChange(false);
            await Promise.resolve();
        });

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');

        machinePluginSettingsGetMock.mockResolvedValueOnce(settingsResult({
            endpoint: 'https://reconnected.example.test',
            enabled: false,
        }));
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://reconnected.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(true);
    });

    it('ignores a settings save that completes after daemon operations become unavailable', async () => {
        const pendingSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(pendingSave.promise);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://pending.example.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'endpoint',
            value: 'https://pending.example.test',
        }));

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable={false}
                />,
            );
        });

        await act(async () => {
            pendingSave.resolve(settingsResult({
                endpoint: 'https://late-result.example.test',
                enabled: true,
            }));
            await pendingSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://pending.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(false);
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
    });

    it('keeps text edits local until Save and preserves a newer draft when that save completes', async () => {
        const firstSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://api.newer.test',
                enabled: true,
            }));
        const { screen } = await renderSection();

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.first.test');
        });

        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Endpoint URL');

        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenNthCalledWith(1, 'machine-1', {
            serverId: 'server-1',
            pluginId: PLUGIN_ID,
            fieldId: 'endpoint',
            value: 'https://api.first.test',
            expectedRevision: '0',
        });

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.newer.test');
        });
        await act(async () => {
            firstSave.resolve(settingsResult({
                endpoint: 'https://api.first.test',
                enabled: true,
            }));
            await firstSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(machinePluginSettingsSetMock.mock.calls[1]?.[1]).toMatchObject({
            fieldId: 'endpoint',
            value: 'https://api.newer.test',
        });
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
    });

    it('does not attribute an older failed save to a newer text draft', async () => {
        const firstSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://api.newer.test',
                enabled: true,
            }));
        const { screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.first.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.newer.test');
        });

        await act(async () => {
            firstSave.resolve(unsupportedResult);
            await firstSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Endpoint URL');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock.mock.calls.map((call) => call[1]?.value)).toEqual([
            'https://api.first.test',
            'https://api.newer.test',
        ]);
    });

    it('preserves a failed secret draft for retry and clears only the exact successful draft', async () => {
        const retrySave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock
            .mockResolvedValueOnce(unsupportedResult)
            .mockReturnValueOnce(retrySave.promise)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://api.example.test',
                apiToken: 'newer-secret',
                enabled: true,
            }));
        const { screen } = await renderSection();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.secureTextEntry).toBe(true);
        expect(screen.getTextContent()).not.toContain('must-not-render');

        await act(async () => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'retry-secret');
        });
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('retry-secret');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('retry-secret');
        expect(screen.findByTestId(SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.retry: API token');
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsSaveError');
        expect(screen.getTextContent()).not.toContain('retry-secret');

        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'newer-secret');
        });
        await act(async () => {
            retrySave.resolve(settingsResult({
                endpoint: 'https://api.example.test',
                apiToken: 'retry-secret',
                enabled: true,
            }));
            await retrySave.promise;
        });

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('newer-secret');
        expect(screen.getTextContent()).not.toContain('retry-secret');
        expect(screen.getTextContent()).not.toContain('newer-secret');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock.mock.calls.map((call) => call[1]?.value)).toEqual([
            'retry-secret',
            'retry-secret',
            'newer-secret',
        ]);
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.getTextContent()).not.toContain('newer-secret');
    });

    it('keeps a pending save serialized and authoritative across a same-scope projection refresh', async () => {
        const pendingSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(pendingSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-two.test',
                enabled: false,
            }));
        const firstProjection = createProjection(1);
        const secondProjection = createProjection(2);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://old-scope-draft.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://old-scope-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            pendingSave.resolve(settingsResult({
                endpoint: 'https://old-scope-draft.test',
                enabled: true,
            }));
            await pendingSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://old-scope-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('keeps an existing draft visible during a same-scope refresh and usable after refresh failure', async () => {
        const refresh = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockReturnValueOnce(refresh.promise);
        machinePluginSettingsSetMock.mockResolvedValueOnce(settingsResult({
            endpoint: 'https://local-draft.test',
            enabled: true,
        }));
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://local-draft.test');
        });
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://local-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            refresh.resolve(unsupportedResult);
            await refresh.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://local-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsLoadError');

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'endpoint',
            value: 'https://local-draft.test',
        }));
    });

    it('keeps different-field results isolated when their saves complete in reverse order', async () => {
        const endpointSave = createDeferred<MachinePluginSettingsResult>();
        const switchSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(endpointSave.promise)
            .mockReturnValueOnce(switchSave.promise);
        const { screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.changed.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            screen.pressByTestId(SWITCH_ID);
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            switchSave.resolve(settingsResult({
                endpoint: 'https://api.example.test',
                enabled: false,
            }));
            await switchSave.promise;
        });
        expect(findSwitch(screen)?.props.value).toBe(false);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.changed.test');

        await act(async () => {
            endpointSave.resolve(settingsResult({
                endpoint: 'https://api.changed.test',
                enabled: true,
            }));
            await endpointSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.changed.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('invalidates a pending switch save once its field is removed, even if the key is reintroduced', async () => {
        const removedFieldSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(removedFieldSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-two.test',
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-three.test',
                enabled: true,
            }));
        const fieldsWithoutSwitch = SETTINGS_FIELDS.filter((field) => field.key !== 'enabled');
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        act(() => {
            screen.pressByTestId(SWITCH_ID);
        });
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2, fieldsWithoutSwitch)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();
        expect(findSwitch(screen)).toBeNull();

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(3)}
                    machineId="machine-1"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);

        await act(async () => {
            removedFieldSave.resolve(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: false,
            }));
            await removedFieldSave.promise;
        });

        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
    });

    it('invalidates a pending save when the machine storage scope changes', async () => {
        const oldMachineSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(oldMachineSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://machine-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://machine-two.test',
                enabled: false,
            }));
        const projection = createProjection(1);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(projection);

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://old-machine-draft.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={projection}
                    machineId="machine-2"
                    serverId="server-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://machine-two.test');

        await act(async () => {
            oldMachineSave.resolve(settingsResult({
                endpoint: 'https://old-machine-draft.test',
                enabled: true,
            }));
            await oldMachineSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://machine-two.test');
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('serializes rapid switch interaction and restores the persisted value after failure', async () => {
        const firstSave = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://api.example.test',
                enabled: false,
            }));
        const { screen } = await renderSection();

        const initialSwitch = findSwitch(screen);
        expect(initialSwitch?.props.value).toBe(true);
        expect(initialSwitch?.props.accessibilityLabel).toBe('Enable hooks');
        expect(hasPressableTestIdAncestor(initialSwitch, SWITCH_ID)).toBe(false);

        act(() => {
            screen.pressByTestId(SWITCH_ID);
            screen.pressByTestId(SWITCH_ID);
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock.mock.calls[0]?.[1]).toMatchObject({
            fieldId: 'enabled',
            value: false,
        });
        expect(findSwitch(screen)?.props.value).toBe(false);
        expect(findSwitch(screen)?.props.disabled).toBe(true);

        await act(async () => {
            firstSave.resolve(unsupportedResult);
            await firstSave.promise;
        });

        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            screen.pressByTestId(SWITCH_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(findSwitch(screen)?.props.value).toBe(false);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
    });

    it('renders a per-active-server field from canonical presentation and writes its hidden backing map', async () => {
        const boundFields: readonly PluginProjectionEditableSettingField[] = [{
            key: 'serverUrl',
            control: 'text',
            valueType: 'string',
            valueSchema: { type: 'string' },
            title: 'Server URL',
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: {
                control: 'text',
                binding: {
                    kind: 'perActiveServer',
                    fallbackSettingId: 'serverUrl',
                    byServerIdSettingId: 'serverUrlByServerId',
                },
            },
        }, {
            key: 'serverUrlByServerId',
            control: 'json',
            valueType: 'object',
            valueSchema: { type: 'object', additionalProperties: { type: 'string' } },
            title: 'Per-server URLs',
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: { control: 'json', hidden: true },
        }];
        machinePluginSettingsGetMock.mockResolvedValueOnce(settingsResult({
            serverUrl: 'https://fallback.example',
            serverUrlByServerId: { 'server-1': 'https://scoped.example' },
        }, []));
        machinePluginSettingsSetMock.mockResolvedValueOnce(settingsResult({
            serverUrl: 'https://fallback.example',
            serverUrlByServerId: { 'server-1': 'https://updated.example' },
        }, [], '1'));
        const { screen } = await renderSection(createProjection(1, boundFields));
        const inputId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.input`;
        const saveId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.save`;

        expect(screen.findByTestId(inputId)?.props.value).toBe('https://scoped.example');
        expect(screen.getTextContent()).not.toContain('Per-server URLs');
        act(() => {
            screen.findByTestId(inputId)?.props.onChangeText('https://updated.example');
        });
        await act(async () => {
            screen.pressByTestId(saveId);
            await Promise.resolve();
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'serverUrlByServerId',
            value: { 'server-1': 'https://updated.example' },
        }));
    });

});
