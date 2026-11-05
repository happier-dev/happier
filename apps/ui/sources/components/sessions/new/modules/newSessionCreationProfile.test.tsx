import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema, type ProviderBoundModelRef } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from '@/components/sessions/new/components/newSessionComponentsTestHelpers';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { buildSessionModelPickerSections, type SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { restrictPermissionModeOptions } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/constants/PermissionModes';
import { resolveNewSessionCreationProfileAuthoringInput, useNewSessionPanelPropsForCreationProfile } from './newSessionCreationProfile';

installNewSessionComponentsCommonModuleMocks();

const agentTargetKey = 'agent:happier.agent.codex/codex';
type ModelPickerProps = React.ComponentProps<typeof SessionModelPicker>;
type ProfilePanel = NewSessionSimplePanelProps & {
    modelPickerProps?: ModelPickerProps;
    allowedPermissionModes?: readonly PermissionMode[] | null;
};

function providerGroup(connection: string, modelId: string): SessionModelProjectionGroup {
    const connectionId = ProviderConnectionIdSchema.parse(connection);
    return {
        connectionId, providerName: 'Gateway', connectionName: connection,
        connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
        authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent', modelLoadPreflightPolicy: null,
        rows: [{
            ref: { agentTargetKey, providerConnectionId: connectionId, modelId },
            descriptor: { id: modelId, name: `Provider ${modelId}` },
            sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
            compatibility: {
                result: { status: 'verified', selectedProtocol: 'openai-responses', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' } },
                compatibilityFingerprint: `compatibility:v1:${connectionId}`, confirmed: true,
            },
            endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
        }],
    };
}

// The hook consumes choice fields; layout and submission are supplied by the real screen model.
function choicePanel(input: Pick<ProfilePanel, 'modelMode' | 'setModelMode' | 'modelOptions' | 'modelPickerProps' | 'permissionMode' | 'handlePermissionModeChange'>): ProfilePanel {
    return input as ProfilePanel;
}

describe('new-session creation-profile choices', () => {
    it('admits the displayed profile selection without writing the remembered draft', () => {
        const model = { agentTargetKey, providerConnectionId: null, modelId: 'admitted' };
        const input = { modelMode: 'default', permissionMode: 'yolo' as const, modelSelection: null };
        const effective = resolveNewSessionCreationProfileAuthoringInput(input, {
            hostBindsMachine: true, agentTargetKey, allowedModels: [model], permissionModes: ['default'],
        });
        expect(effective).toMatchObject({ modelMode: 'admitted', permissionMode: 'default',
            modelSelection: { v: 1, updatedAt: 0, ref: model } });
        expect(input).toEqual({ modelMode: 'default', permissionMode: 'yolo', modelSelection: null });
        expect(resolveNewSessionCreationProfileAuthoringInput(input, undefined)).toBe(input);
    });
    it('offers only the admitted connection-bound models and commits the full selected ref', async () => {
        const work = providerGroup('pc_work', 'same-model');
        const personal = providerGroup('pc_personal', 'same-model');
        const denied = providerGroup('pc_denied', 'same-model');
        const allowed = [work.rows[0]!.ref, personal.rows[0]!.ref];
        const nativeModels = [{ value: 'default', label: 'Automatic', description: '' }, { value: 'same-model', label: 'Native', description: '' }];
        const profile = { hostBindsMachine: true as const, agentTargetKey, allowedModels: allowed };
        const hook = await renderHook(() => {
            const [selected, select] = React.useState<ProviderBoundModelRef | null>({ agentTargetKey, providerConnectionId: null, modelId: 'same-model' });
            const onSelect = React.useCallback((ref: ProviderBoundModelRef | null) => select(ref), []);
            const panel = useNewSessionPanelPropsForCreationProfile(choicePanel({
                modelMode: selected?.modelId ?? 'default', setModelMode: () => undefined,
                modelOptions: nativeModels, permissionMode: 'default', handlePermissionModeChange: () => undefined,
                modelPickerProps: {
                    agentTargetKey, nativeModels, providerGroups: [work, personal, denied],
                    hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
                    selected, onSelect,
                },
            }), profile) as ProfilePanel;
            return { panel, selected };
        });
        const picker = hook.getCurrent().panel.modelPickerProps!;
        const choices = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, ...picker, hiddenNativeModelKeys: picker.hiddenNativeModelKeys ?? new Set() })
            .flatMap((section) => section.options).filter((option) => !option.disabled);
        expect(choices.map((choice) => choice.value)).toEqual(allowed);
        expect(hook.getCurrent().selected).toEqual({ agentTargetKey, providerConnectionId: null, modelId: 'same-model' });
        expect(picker.selected).toEqual(allowed[0]);
        await act(async () => picker.onSelect(allowed[1]!));
        expect(hook.getCurrent().selected).toEqual(allowed[1]);
        expect(hook.getCurrent().panel.modelPickerProps?.selected).toEqual(allowed[1]);
        await hook.unmount();
    });

    it('offers exactly two admitted permission modes and submits the selected mode', async () => {
        const permissionModes: readonly PermissionMode[] = ['default', 'safe-yolo'];
        const hook = await renderHook(() => {
            const [mode, setMode] = React.useState<PermissionMode>('yolo');
            const panel = useNewSessionPanelPropsForCreationProfile(choicePanel({
                modelMode: 'default', setModelMode: () => undefined, modelOptions: [],
                permissionMode: mode, handlePermissionModeChange: setMode,
            }), { hostBindsMachine: true, permissionModes }) as ProfilePanel;
            return { panel, mode };
        });
        const offered = restrictPermissionModeOptions([
            { value: 'default', label: 'Default' }, { value: 'safe-yolo', label: 'Safe' }, { value: 'yolo', label: 'Full' },
        ], hook.getCurrent().panel.allowedPermissionModes ?? null);
        expect(offered.map((option) => option.value)).toEqual(permissionModes);
        expect(hook.getCurrent().mode).toBe('yolo');
        expect(hook.getCurrent().panel.permissionMode).toBe('default');
        await act(async () => hook.getCurrent().panel.handlePermissionModeChange?.('safe-yolo'));
        expect(hook.getCurrent().mode).toBe('safe-yolo');
        expect(hook.getCurrent().panel.permissionMode).toBe('safe-yolo');
        await hook.unmount();
    });
});
