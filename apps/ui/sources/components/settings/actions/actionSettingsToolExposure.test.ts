import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1, type ActionId, type ActionsSettingsV1 } from '@happier-dev/protocol';

import * as actionSettingsTargets from './actionSettingsTargets';

type ActionSettingsToolExposureMode = 'direct' | 'discoverable_only';
type ActionSettingsToolExposureControlValue = 'default' | ActionSettingsToolExposureMode;
type ActionSettingsToolExposureState =
    | Readonly<{
        kind: 'visible';
        value: ActionSettingsToolExposureControlValue;
        defaultMode: ActionSettingsToolExposureMode;
        resolvedMode: ActionSettingsToolExposureMode;
        explicit: boolean;
        disabled: boolean;
        surface: string;
    }>
    | Readonly<{ kind: 'hidden' }>;

type ResolveActionSettingsToolExposureState = (params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: actionSettingsTargets.ActionSettingsTargetId;
    available?: boolean;
}>) => ActionSettingsToolExposureState;

type SetActionSettingsToolExposureMode = (params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: actionSettingsTargets.ActionSettingsTargetId;
    value: ActionSettingsToolExposureControlValue;
}>) => ActionsSettingsV1;

function expectResolveToolExposureStateExport(): ResolveActionSettingsToolExposureState {
    const candidate = (
        actionSettingsTargets as typeof actionSettingsTargets & {
            resolveActionSettingsToolExposureState?: ResolveActionSettingsToolExposureState;
        }
    ).resolveActionSettingsToolExposureState;
    expect(typeof candidate).toBe('function');
    return candidate ?? (() => ({ kind: 'hidden' }));
}

function expectSetToolExposureModeExport(): SetActionSettingsToolExposureMode {
    const candidate = (
        actionSettingsTargets as typeof actionSettingsTargets & {
            setActionSettingsToolExposureMode?: SetActionSettingsToolExposureMode;
        }
    ).setActionSettingsToolExposureMode;
    expect(typeof candidate).toBe('function');
    return candidate ?? ((params) => params.settings);
}

function readToolExposureModes(settings: ActionsSettingsV1, actionId: ActionId): Record<string, string> | undefined {
    const action = settings.actions[actionId] as unknown;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
        return undefined;
    }
    const modes = (action as { toolExposureModes?: unknown }).toolExposureModes;
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) {
        return undefined;
    }
    return modes as Record<string, string>;
}

describe('action settings tool exposure', () => {
    it('resolves session-agent exposure to discoverable-only by default for tool-backed actions', () => {
        const resolveToolExposureState = expectResolveToolExposureStateExport();

        expect(resolveToolExposureState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent',
        })).toMatchObject({
            kind: 'visible',
            value: 'default',
            defaultMode: 'discoverable_only',
            resolvedMode: 'discoverable_only',
            explicit: false,
            disabled: false,
            surface: 'agent',
        });
    });

    it('resolves external MCP and CLI exposure to direct by default', () => {
        const resolveToolExposureState = expectResolveToolExposureStateExport();

        expect(resolveToolExposureState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'visible',
            value: 'default',
            defaultMode: 'direct',
            resolvedMode: 'direct',
        });
        expect(resolveToolExposureState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'cli',
        })).toMatchObject({
            kind: 'visible',
            value: 'default',
            defaultMode: 'direct',
            resolvedMode: 'direct',
        });
    });

    it('writes an explicit direct override for session-agent exposure', () => {
        const setToolExposureMode = expectSetToolExposureModeExport();

        const next = setToolExposureMode({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent',
            value: 'direct',
        });

        expect(readToolExposureModes(next, 'review.start')).toEqual({
            agent: 'direct',
        });
    });

    it('clears an explicit exposure override when selecting the default value', () => {
        const setToolExposureMode = expectSetToolExposureModeExport();
        const direct = setToolExposureMode({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent',
            value: 'direct',
        });

        const next = setToolExposureMode({
            settings: direct,
            actionId: 'review.start',
            targetId: 'agent',
            value: 'default',
        });

        expect(next.actions['review.start']).toBeUndefined();
    });

    it('hides exposure controls for non-tool placement targets', () => {
        const resolveToolExposureState = expectResolveToolExposureStateExport();

        expect(resolveToolExposureState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({ kind: 'hidden' });
    });

    it('keeps exposure preferences disabled but intact when the target is off', () => {
        const resolveToolExposureState = expectResolveToolExposureStateExport();
        const setToolExposureMode = expectSetToolExposureModeExport();
        const direct = setToolExposureMode({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent',
            value: 'direct',
        });
        const targetOff = actionSettingsTargets.setActionTargetSelected({
            settings: direct,
            actionId: 'review.start',
            targetId: 'agent',
            selected: false,
        });

        expect(resolveToolExposureState({
            settings: targetOff,
            actionId: 'review.start',
            targetId: 'agent',
        })).toMatchObject({
            kind: 'visible',
            value: 'direct',
            resolvedMode: 'direct',
            explicit: true,
            disabled: true,
        });
        expect(readToolExposureModes(targetOff, 'review.start')).toEqual({
            agent: 'direct',
        });
    });
});
