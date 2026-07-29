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
            setting_key: 'claudeRemoteSettingSourcesV2',
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

    it('does not track undeclared or forbidden values', () => {
        emitPluginSettingChangedEvent({
            previousValue: 'before',
            nextValue: 'after',
            field: {
                key: 'secret',
                control: 'password',
                valueType: 'string',
                valueSchema: { type: 'string' },
                title: 'Secret',
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
            previousValue: false,
            nextValue: true,
            field: {
                key: 'untracked',
                control: 'switch',
                valueType: 'boolean',
                valueSchema: { type: 'boolean' },
                title: 'Untracked',
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
