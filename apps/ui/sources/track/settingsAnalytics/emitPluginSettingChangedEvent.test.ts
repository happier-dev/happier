import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tracking: {
        capture: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('@/track', () => ({
    tracking: mocks.tracking,
}));

import { emitPluginSettingChangedEvent } from './emitPluginSettingChangedEvent';

describe('emitPluginSettingChangedEvent', () => {
    beforeEach(() => {
        mocks.tracking.capture.mockReset();
        mocks.tracking.flush.mockReset();
    });

    it('tracks successful safe canonical settings changes', () => {
        emitPluginSettingChangedEvent({
            pluginId: 'com.happier.claude',
            scope: 'account',
            previousValue: ['user'],
            nextValue: ['project', 'user'],
            field: {
                key: 'claudeRemoteSettingSourcesV2',
                control: 'multiSelect',
                valueType: 'array',
                valueSchema: {
                    type: 'array',
                    items: { type: 'string', enum: ['user', 'project', 'local'] },
                },
                title: 'Setting sources',
                secretCustody: null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
                defaultValue: ['user'],
                analytics: {
                    trackChanges: true,
                    valueKind: 'enum',
                    privacy: 'safe',
                    identityScope: 'person',
                    serializeCurrentRule: 'orderedEnumArrayJoin',
                },
            },
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith('setting_changed', {
            setting_key: 'com.happier.claude/claudeRemoteSettingSourcesV2',
            scope: 'account_setting',
            identity_scope: 'person',
            value_kind: 'enum',
            prev_value: 'user',
            next_value: 'user+project',
            was_default_before: true,
            is_default_after: false,
            source: 'ui',
        });
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('qualifies repeated field ids and reports daemon-local settings as local', () => {
        const field = {
            key: 'enabled',
            control: 'switch' as const,
            valueType: 'boolean' as const,
            valueSchema: { type: 'boolean' as const },
            title: 'Enabled',
            secretCustody: null,
            redaction: 'none' as const,
            clearWhenEmpty: 'persist' as const,
            analytics: {
                trackChanges: true,
                valueKind: 'boolean' as const,
                privacy: 'safe' as const,
                identityScope: 'device_user' as const,
            },
        };

        emitPluginSettingChangedEvent({
            pluginId: 'com.acme.one',
            scope: 'daemon',
            previousValue: false,
            nextValue: true,
            field,
        });
        emitPluginSettingChangedEvent({
            pluginId: 'com.acme.two',
            scope: 'daemon',
            previousValue: false,
            nextValue: true,
            field,
        });

        expect(mocks.tracking.capture.mock.calls.map((call) => call[1])).toEqual([
            expect.objectContaining({
                setting_key: 'com.acme.one/enabled',
                scope: 'local_setting',
            }),
            expect.objectContaining({
                setting_key: 'com.acme.two/enabled',
                scope: 'local_setting',
            }),
        ]);
    });

    it('does not track undeclared or forbidden values', () => {
        emitPluginSettingChangedEvent({
            pluginId: 'com.acme.secrets',
            scope: 'daemon',
            previousValue: 'before',
            nextValue: 'after',
            field: {
                key: 'secret',
                control: 'password',
                valueType: 'string',
                valueSchema: { type: 'string' },
                title: 'Secret',
                secretCustody: 'daemon',
                redaction: 'secret',
                clearWhenEmpty: 'omit',
                analytics: {
                    trackChanges: true,
                    valueKind: 'presence',
                    privacy: 'forbidden',
                    identityScope: 'person',
                },
            },
        });
        emitPluginSettingChangedEvent({
            pluginId: 'com.acme.untracked',
            scope: 'account',
            previousValue: false,
            nextValue: true,
            field: {
                key: 'untracked',
                control: 'switch',
                valueType: 'boolean',
                valueSchema: { type: 'boolean' },
                title: 'Untracked',
                secretCustody: null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
                analytics: {
                    valueKind: 'boolean',
                    privacy: 'safe',
                    identityScope: 'person',
                },
            },
        });

        expect(mocks.tracking.capture).not.toHaveBeenCalled();
        expect(mocks.tracking.flush).not.toHaveBeenCalled();
    });
});
