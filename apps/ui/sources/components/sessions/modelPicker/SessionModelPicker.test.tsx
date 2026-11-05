import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import {
    buildSessionModelPickerNotes,
    resolveSessionModelPickerSelection,
    SessionModelPicker,
    type SessionModelPickerExperimentalConfirmationController,
} from './SessionModelPicker';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SessionModelApplyTimingContext } from './SessionModelSourceBrowseHandoff';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import { t } from '@/text';
import { router as expoRouter } from 'expo-router';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAccountAgentProviderRequirements, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { createSessionActiveModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

/**
 * Committing a freeform model id is a SUBMIT, not a keystroke: the overlay's custom
 * input only stores the draft on change and commits on `onSubmitEditing`/blur. A test
 * that stopped at `changeText` asserted the binding without ever exercising it.
 */
function submitCustomModelValue(screen: Readonly<{
    findByTestId: (testID: string) => { props: Record<string, unknown> } | null;
}>): void {
    const input = screen.findByTestId('model-picker-overlay-custom-input');
    const onSubmitEditing = input?.props.onSubmitEditing;
    if (typeof onSubmitEditing !== 'function') {
        throw new Error('Custom model input is not wired for submit');
    }
    act(() => { (onSubmitEditing as () => void)(); });
}

function experimentalProviderGroup(id: string) {
    const connectionId = ProviderConnectionIdSchema.parse(id);
    const selected = {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: connectionId,
        modelId: 'experimental-model',
    } as const;
    const providerGroups = [{
        connectionId,
        providerName: 'Gateway',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
        connectionRevision: 3,
        authorization: { authorized: true as const },
        manualModelPolicy: 'catalog-only' as const,
        supportsFreeformModelIds: false,
        suppressedConnectedServiceIds: [],
        modelLoadAction: 'descriptor_absent' as const,
        rows: [{
            ref: selected,
            descriptor: { id: selected.modelId, name: 'Experimental model' },
            sources: { manual: false, static: true, probe: false },
            confidence: 'verified_static' as const,
            compatibility: {
                result: {
                    status: 'experimental' as const,
                    selectedProtocol: 'openai-responses' as const,
                    reasons: ['compatibility_evidence_missing' as const],
                    confirmationScope: { kind: 'model' as const, modelId: selected.modelId },
                },
                compatibilityFingerprint: 'compatibility:v1:experimental',
                confirmed: false,
            },
            endpointHealth: 'available' as const,
            catalog: { stale: false },
            loadState: 'unknown' as const,
            visibility: 'visible' as const,
        }],
    }];
    return { connectionId, selected, providerGroups };
}

describe('SessionModelPicker', () => {
    it('selects the runtime-applied Team row rather than a same-model Built-in row after a V1 launch', async () => {
        const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna' };
        const active = createSessionActiveModelSelection({ selection, source: 'runtime_apply', runner: { pid: 42, processStartTimeMs: 10 },
            teamCredentialModel: { kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource',
                expectedResourceRevision: 0, deliveryMode: 'brokered', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId } });
        if (active?.v !== 2) throw new Error('Expected canonical Team runtime fact');
        const metadata = MetadataSchema.parse({ path: '/workspace', host: 'test',
            modelSelectionIntentV1: { v: 1, updatedAt: 11, selection },
            sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 0, currentModelId: selection.modelId,
                availableModels: [{ id: selection.modelId, name: 'Luna' }], activeSelectionV1: active } });
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: 'QA43 Leeroy brokered', resourceRevision: 0,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [{
                selection: active.teamCredentialModel, descriptor: { id: selection.modelId, name: 'Luna' },
                application: { agentTargetKey: selection.agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
                sourceRevision: 'source-v1', availability: 'available',
            }], sourcePresentation: { kind: 'provider', provider: { identity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, definitionRevision: 1 } } });
        for (const sessionActive of [true, false]) {
            const disposition = resolveSessionModelSelectionDisposition({ metadata, agentId: 'codex', agentTargetKey: selection.agentTargetKey,
                sessionActive, currentRunnerProcessIdentity: sessionActive ? active.runner : null });
            const screen = await renderScreen(<SessionModelPicker agentTargetKey={selection.agentTargetKey} declarationContext={{ kind: 'account' }}
                nativeModels={[{ value: selection.modelId, label: 'Luna' }]} providerGroups={[]} providerProjectionAuthoritative
                teamCredentialResources={[resource]} currentTeamCredentialResourceKeys={new Set(['team:resource'])}
                selected={selection} selectedTeamCredentialModel={disposition.selectedTeamCredentialModel}
                reportedModel={{ ref: disposition.reportedTeamCredentialModel ?? selection, status: 'last_used' }}
                onSelect={() => {}} />);
            const list = screen.findByType(SelectionList);
            expect(list.props.selectedOptionId).toBe(sessionModelSelectionKey(active.teamCredentialModel));
            expect(list.props.selectedOptionId).not.toBe(sessionModelSelectionKey(selection));
            expect(screen.findByTestId(`model-picker-overlay-option-selected-indicator:${sessionModelSelectionKey(active.teamCredentialModel)}`)).toBeTruthy();
            expect(screen.findByTestId(`model-picker-overlay-option-selected-indicator:${sessionModelSelectionKey(selection)}`)).toBeNull();
            expect(screen.findByTestId(`model-picker-overlay-option-status-icon:${sessionModelSelectionKey(active.teamCredentialModel)}`)).toBeTruthy();
            expect(screen.findByTestId(`model-picker-overlay-option-status-icon:${sessionModelSelectionKey(selection)}`)).toBeNull();
            await screen.unmount();
        }
    });
    it('keeps independent Account model rows inert until the addressed Machine answers, and after withdrawal', async () => {
        const { selected, providerGroups } = experimentalProviderGroup('pc_independent_account');
        const group = createProviderModelProjectionGroupFixture({ ...providerGroups[0]!,
            rows: providerGroups[0]!.rows.map(row => ({ ...row, compatibility: { ...row.compatibility, confirmed: true } })),
        });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                providerRequirements: readAccountAgentProviderRequirements(selected.agentTargetKey, { kind: 'account' }) },
        } });
        const onSelect = vi.fn();
        const picker = (declarationContext: ProviderDeclarationContext) => <SessionModelPicker
            agentTargetKey={selected.agentTargetKey}
            declarationContext={declarationContext}
            nativeModels={[]}
            providerGroups={[group]}
            providerProjectionAuthoritative
            selected={selected}
            onSelect={onSelect}
        />;
        const screen = await renderScreen(picker({ kind: 'machine', projection: null }));
        const optionId = `model-picker-overlay-option:${JSON.stringify([selected.agentTargetKey, selected.providerConnectionId, selected.modelId])}`;
        for (const context of [
            { kind: 'machine', projection: null },
            { kind: 'machine', projection },
            { kind: 'machine', projection: null },
            { kind: 'account' },
        ] satisfies ProviderDeclarationContext[]) {
            await screen.update(picker(context));
            onSelect.mockClear();
            await screen.pressByTestIdAsync(optionId);
            if (context.kind === 'account' || context.projection) expect(onSelect).toHaveBeenCalledWith(selected);
            else expect(onSelect).not.toHaveBeenCalled();
        }
    });
    it.each(['model', 'connection'] as const)('passes the exact source and worker scope to the existing experimental confirmation (%s)', scope => {
        const { selected, providerGroups } = experimentalProviderGroup('connected-source:catalog-a');
        const connectedAccountTarget = { kind: 'group' as const,
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool-a' };
        const group = createProviderModelProjectionGroupFixture({ ...providerGroups[0]!, connectedAccountTarget, connectionRevision: 0,
            rows: providerGroups[0]!.rows.map(row => ({ ...row,
                confirmationSource: { connectionId: selected.providerConnectionId, catalogSourceKey: 's'.repeat(43) },
                compatibility: { ...row.compatibility, result: { ...row.compatibility.result,
                    confirmationScope: scope === 'connection' ? { kind: 'connection' } : { kind: 'model', modelId: selected.modelId },
                } },
            })),
        });
        expect(resolveSessionModelPickerSelection({
            groups: [group], ref: selected,
        })).toMatchObject({ kind: 'confirm-experimental', connectedAccountTarget,
            connectionId: selected.providerConnectionId, expectedConnectionRevision: 0,
            catalogSourceKey: 's'.repeat(43), modelId: scope === 'model' ? selected.modelId : null });
    });
    it.each([false, true])('finds authoritative native models by exact id and label despite an unavailable Provider projection (favorite %s)', async (favorite) => {
        const agentTargetKey = 'agent:acme.agent/reviewer';
        const modelId = 'openai/gpt-6.1-sol';
        const selected = { agentTargetKey, providerConnectionId: null, modelId };
        const onSelect = vi.fn();
        const screen = await renderScreen(<SessionModelPicker
            agentTargetKey={agentTargetKey}
            nativeModels={[
                { value: 'default', label: 'Automatic' },
                { value: modelId, label: 'GPT-6.1 Sol' },
                { value: `${modelId}-fast`, label: 'GPT-6.1 Sol Fast' },
                ...Array.from({ length: 8 }, (_, i) => ({ value: `other/${i}`, label: `Other model ${i}` })),
            ]}
            providerGroups={[]}
            providerProjectionAuthoritative={false}
            projectionError={createProviderErrorV1('provider_catalog_unavailable')}
            favoriteEntries={favorite ? [{ ref: selected }] : undefined}
            probe={{ phase: 'idle', failed: false }}
            selected={null}
            onSelect={onSelect}
        />);
        const optionId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, null, modelId])}`;
        expect(screen.findByTestId(optionId)).toBeTruthy();
        for (const query of [modelId, 'gpt-6.1-sol', 'GPT-6.1 Sol']) {
            act(() => screen.changeTextByTestId('model-picker-overlay-search', query));
            expect(screen.findByTestId(optionId)).toBeTruthy();
            expect(screen.getTextContent()).not.toContain('Other model 0');
        }
        await screen.pressByTestIdAsync(optionId);
        expect(onSelect).toHaveBeenCalledWith(selected);
        expect(screen.findByTestId('provider-error:provider_catalog_unavailable')).toBeNull();
    });
    it('retains an unavailable Provider catalog diagnostic for a named connection, Provider selection or no discovered native catalog', async () => {
        const agentTargetKey = 'agent:acme.agent/reviewer';
        for (const scenario of ['connection', 'selection', 'no-native']) {
            const error = createProviderErrorV1('provider_catalog_unavailable', scenario === 'connection'
                ? { connectionId: 'pc_work' } : undefined);
            const screen = await renderScreen(<SessionModelPicker
                agentTargetKey={agentTargetKey}
                nativeModels={scenario === 'no-native'
                    ? [{ value: 'default', label: 'Automatic' }]
                    : [{ value: 'native/model', label: 'Native model' }]}
                providerGroups={[]}
                providerProjectionAuthoritative={false}
                projectionError={error}
                selected={scenario === 'selection' ? { agentTargetKey,
                    providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'work/model' } : null}
                onSelect={vi.fn()}
            />);
            expect(screen.findByTestId('provider-error:provider_catalog_unavailable')).toBeTruthy();
        }
    });
    it('confirms unconfirmed experimental compatibility through the Account regardless of model-load availability', () => {
        const ref = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'), modelId: 'manual-model' };
        const group = createProviderModelProjectionGroupFixture({ modelLoadAction: 'machine_required', rows: [{
            ref, descriptor: { id: ref.modelId, name: 'Manual model' },
            confidence: 'account_unverified', loadState: 'unknown', visibility: 'visible',
            sources: { manual: true, static: false, probe: false }, endpointHealth: 'not_checked', catalog: { stale: false },
            compatibility: { compatibilityFingerprint: 'compatibility:v1:declaration', confirmed: false,
                result: { status: 'experimental' as const, selectedProtocol: 'openai-responses' as const,
                    reasons: ['compatibility_evidence_missing' as const],
                    confirmationScope: { kind: 'model' as const, modelId: ref.modelId } } },
        }] });
        expect(resolveSessionModelPickerSelection({ groups: [group], ref }))
            .toMatchObject({ kind: 'confirm-experimental', connectionId: ref.providerConnectionId,
                expectedConnectionRevision: group.connectionRevision, modelId: ref.modelId,
                compatibilityFingerprint: 'compatibility:v1:declaration' });
        expect(resolveSessionModelPickerSelection({ groups: [{ ...group, modelLoadAction: 'available' }], ref }))
            .toMatchObject({ kind: 'confirm-experimental', modelId: ref.modelId });
        expect(resolveSessionModelPickerSelection({ groups: [{ ...group, rows: group.rows.map(row => ({
            ...row, compatibility: { ...row.compatibility, confirmed: true },
        })) }], ref })).toEqual({ kind: 'select', ref });
    });
    it('labels model groups only when there is more than one to tell apart', async () => {
        const selected = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-sol' } as const;
        const render = (favoriteEntries?: React.ComponentProps<typeof SessionModelPicker>['favoriteEntries']) => renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[
                    { value: 'gpt-5.6-terra', label: '5.6 Terra' },
                    { value: 'gpt-5.6-sol', label: '5.6 Sol' },
                ]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={selected}
                favoriteEntries={favoriteEntries}
                onSelect={() => {}}
            />,
        );
        const sectionTitles = (screen: Awaited<ReturnType<typeof render>>) => (
            (screen.findByType(SelectionList).props.rootStep.sections as ReadonlyArray<{ title?: string }>)
                .map((section) => section.title ?? '')
        );

        // One group of built-in models: a heading over the only group is noise.
        const lone = await render();
        expect(sectionTitles(lone)).toEqual(['']);
        await lone.unmount();

        // Favorites plus the rest: both groups are named.
        const grouped = await render([{ ref: selected, label: '5.6 Sol' }]);
        expect(sectionTitles(grouped).every((title) => title.length > 0)).toBe(true);
        await grouped.unmount();
    });

    it('keeps selection styling on the requested model and marks the reported runtime model separately', async () => {
        const requested = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-sol',
        } as const;
        const reported = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-terra',
        } as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[
                    { value: 'gpt-5.6-terra', label: '5.6 Terra' },
                    { value: 'gpt-5.6-sol', label: '5.6 Sol' },
                ]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={requested}
                reportedModel={{ ref: reported, status: 'last_used' }}
                onSelect={() => {}}
            />,
        );

        expect(screen.findByType(SelectionList).props.selectedOptionId).toBe(
            JSON.stringify([requested.agentTargetKey, requested.providerConnectionId, requested.modelId]),
        );
        expect(screen.findByTestId(
            `model-picker-overlay-option-selected-indicator:${JSON.stringify([
                requested.agentTargetKey,
                requested.providerConnectionId,
                requested.modelId,
            ])}`,
        )).toBeTruthy();
        expect(screen.findByTestId(
            `model-picker-overlay-option-selected-indicator:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        )).toBeNull();
        const reportedIcon = screen.findByTestId(
            `model-picker-overlay-option-status-icon:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        );
        expect(reportedIcon).toBeTruthy();
        expect(reportedIcon?.findByProps({ name: 'clock' })).toBeTruthy();
        expect(screen.findByTestId(
            `model-picker-overlay-option-icon:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        )).toBeNull();
        expect(screen.getTextContent()).toContain('Last used: 5.6 Terra');
    });

    it('explains connected-service suppression without changing selection identity', () => {
        const connectionId = ProviderConnectionIdSchema.parse('pc_suppression');
        expect(buildSessionModelPickerNotes({
            notes: ['Existing'],
            groups: [{ connectionId, suppressedConnectedServiceIds: ['openai-codex'] }],
            selected: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'm' },
            suppressionNote: 'Native sign-in is not used.',
        })).toEqual(['Existing', 'Native sign-in is not used.']);
    });

    it('gives experimental confirmation ownership of the exact selection commit', async () => {
        const { connectionId, selected, providerGroups } = experimentalProviderGroup('pc_experimental');
        const onSelect = vi.fn();
        const confirm = vi.fn<SessionModelPickerExperimentalConfirmationController['confirm']>(async () => true);
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={providerGroups}
                providerProjectionAuthoritative
                selected={null}
                experimentalConfirmation={{
                    confirm,
                    pending: false,
                    error: null,
                    retry: null,
                    clear: vi.fn(),
                }}
                onSelect={onSelect}
            />,
        );

        await screen.pressByTestIdAsync(`model-picker-overlay-option:${JSON.stringify([
            selected.agentTargetKey,
            connectionId,
            selected.modelId,
        ])}`);

        expect(confirm).toHaveBeenCalledOnce();
        const commitSelection = confirm.mock.calls[0]?.[1];
        expect(commitSelection).toBeTypeOf('function');
        expect(onSelect).not.toHaveBeenCalled();

        act(() => commitSelection?.());

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith(selected);
    });

    it('keeps an experimental confirmation waiting for approval reviewable in place without a second request', async () => {
        const { connectionId, selected, providerGroups } = experimentalProviderGroup('pc_experimental_approval');
        const confirm = vi.fn<SessionModelPickerExperimentalConfirmationController['confirm']>(async () => false);
        const href = buildApprovalHref('approval-artifact-1', 'srv_picker');
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={providerGroups}
                providerProjectionAuthoritative
                selected={null}
                experimentalConfirmation={{
                    confirm,
                    pending: true,
                    pendingModelName: 'Experimental model',
                    pendingApproval: { artifactId: 'approval-artifact-1', href },
                    error: null,
                    retry: null,
                    clear: vi.fn(),
                }}
                onSelect={vi.fn()}
            />,
        );

        expect(screen.findByTestId('model-picker-experimental-approval')).toBeTruthy();
        // The line says WHICH choice is waiting, not only that something is.
        expect(screen.findByTestId('model-picker-experimental-approval.subject')?.props.children).toBe('Experimental model');
        await screen.pressByTestIdAsync('model-picker-experimental-approval.open');
        expect(expoRouter.push).toHaveBeenCalledWith(href);
        await screen.pressByTestIdAsync(`model-picker-overlay-option:${JSON.stringify([
            selected.agentTargetKey,
            connectionId,
            selected.modelId,
        ])}`);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('shows a discovery failure as one compact line, without a second "discovery unavailable" note', async () => {
        const retryProjection = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.claude/claude"
                nativeModels={[{ value: 'default', label: 'Automatic' }, { value: 'opus', label: 'Opus' }]}
                providerGroups={[]}
                providerProjectionAuthoritative={false}
                projectionError={createProviderErrorV1('provider_rpc_response_invalid')}
                retryProjection={retryProjection}
                probe={{ phase: 'idle', failed: true }}
                notes={[t('agentInput.model.unavailable')]}
                selected={null}
                onSelect={vi.fn()}
            />,
        );

        expect(screen.findByTestId('provider-error:provider_rpc_response_invalid')).toBeTruthy();
        expect(screen.findByTestId('provider-error-action:provider_rpc_response_invalid')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain(t('agentInput.model.unavailable'));
    });

    it('emits an exact native structured ref for native freeform entry', async () => {
        const onSelect = vi.fn();
        const clear = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={null}
                canEnterCustomNativeValue
                experimentalConfirmation={{
                    confirm: vi.fn(async () => false),
                    pending: false,
                    error: createProviderErrorV1('provider_endpoint_unavailable'),
                    retry: vi.fn(async () => false),
                    clear,
                }}
                onSelect={onSelect}
            />,
        );
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        act(() => screen.changeTextByTestId('model-picker-overlay-custom-input', 'native-unlisted'));
        submitCustomModelValue(screen);
        expect(onSelect).toHaveBeenCalledWith({
            agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'native-unlisted',
        });
        expect(clear).toHaveBeenCalledOnce();
    });

    const freeformProviderGroup = (freeformPolicy: Readonly<{
        manualModelPolicy: 'allowed' | 'catalog-only';
        supportsFreeformModelIds: boolean;
    }>) => {
        const connectionId = ProviderConnectionIdSchema.parse('pc_freeform');
        const selected = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'listed' } as const;
        return {
            connectionId,
            selected,
            group: {
                connectionId, providerName: 'Gateway', connectionName: 'Work',
                connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
                authorization: { authorized: true as const },
                manualModelPolicy: freeformPolicy.manualModelPolicy,
                supportsFreeformModelIds: freeformPolicy.supportsFreeformModelIds,
                suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent' as const,
                rows: [{
                    ref: selected, descriptor: { id: 'listed', name: 'Listed' },
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static' as const,
                    compatibility: {
                        result: { status: 'verified' as const, selectedProtocol: 'openai-responses' as const, evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' } },
                        compatibilityFingerprint: 'compatibility:v1:freeform', confirmed: true,
                    },
                    endpointHealth: 'available' as const, catalog: { stale: false }, loadState: 'unknown' as const, visibility: 'visible' as const,
                }],
            },
        };
    };

    it('keeps the selected native account heading even when it is the only source', async () => {
        const render = (nativeSourceLabel?: string) => renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={null}
                canEnterCustomNativeValue
                nativeSourceLabel={nativeSourceLabel}
                onSelect={() => {}}
            />,
        );
        const customText = (screen: Awaited<ReturnType<typeof render>>) => {
            const node = screen.findByTestId('model-picker-overlay-custom');
            if (!node) return '';
            return node.findAll((child) => typeof child.props?.children === 'string')
                .map((child) => String(child.props.children)).join(' ');
        };
        const bare = await render();
        expect(bare.findByType(SelectionList).props.rootStep.sections[0].title).toBeUndefined();
        expect(customText(bare)).not.toContain(t('settingsProviders.models.builtIn'));
        expect(customText(bare)).toContain(t('agentInput.model.customDescription'));
        const sourced = await render('Codex · Work pool');
        expect(sourced.findByType(SelectionList).props.rootStep.sections[0].title).toBe('Codex · Work pool');
        expect(customText(sourced)).toContain('Codex · Work pool');
    });

    it('binds freeform entry to the exact selected Provider connection', async () => {
        const { connectionId, selected, group } = freeformProviderGroup({
            manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        });
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={[group]}
                providerProjectionAuthoritative
                selected={selected}
                onSelect={onSelect}
            />,
        );
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        act(() => screen.changeTextByTestId('model-picker-overlay-custom-input', 'provider/unlisted'));
        submitCustomModelValue(screen);
        expect(onSelect).toHaveBeenCalledWith({
            agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'provider/unlisted',
        });
    });

    it('offers no custom model entry when the presentation restricts models to a list', async () => {
        const { selected, group } = freeformProviderGroup({
            manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        });
        // The underlying Provider permits custom ids; this presentation admits only listed choices.
        const restrictedProps = { canEnterCustomValue: false };
        const screen = await renderScreen(
            <SessionModelPicker
                {...restrictedProps}
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'native', label: 'Native' }]}
                canEnterCustomNativeValue
                providerGroups={[group]}
                providerProjectionAuthoritative
                selected={selected}
                onSelect={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: 'model-picker-overlay-custom' })).toHaveLength(0);
        await screen.unmount();
    });

    // Offering the entry is a promise the launch owner has to keep: an id the
    // two-sided policy refuses is rejected at spawn as `provider_model_not_found`,
    // so the picker must not offer custom entry when either side is closed.
    it.each([
        ['the Provider refuses manual ids', { manualModelPolicy: 'catalog-only' as const, supportsFreeformModelIds: true }],
        ['the Agent refuses unverifiable ids', { manualModelPolicy: 'allowed' as const, supportsFreeformModelIds: false }],
    ])('offers no freeform entry on the selected connection when %s', async (_label, freeformPolicy) => {
        const { selected, group } = freeformProviderGroup(freeformPolicy);
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={[group]}
                providerProjectionAuthoritative
                selected={selected}
                onSelect={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: 'model-picker-overlay-custom' })).toHaveLength(0);
    });

    it('does not guess a freeform target when multiple Provider connections are eligible', async () => {
        const makeGroup = (connectionId: string) => ({
            connectionId: ProviderConnectionIdSchema.parse(connectionId),
            providerName: 'Gateway', connectionName: connectionId,
            connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
            authorization: { authorized: true as const }, manualModelPolicy: 'allowed' as const,
            supportsFreeformModelIds: true, suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent' as const,
            rows: [],
        });
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={[makeGroup('pc_work'), makeGroup('pc_personal')]}
                providerProjectionAuthoritative
                selected={null}
                onSelect={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: 'model-picker-overlay-custom' })).toHaveLength(0);
    });

    it('presents a first-load Provider projection error through the canonical retry owner', async () => {
        const retryProjection = vi.fn(async () => {});
        const error = createProviderErrorV1('provider_endpoint_unreachable', {
            machineId: 'machine-a',
        });
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_unreachable'),
            modelId: 'provider-only-model',
        } as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative={false}
                projectionError={error}
                retryProjection={retryProjection}
                selected={selected}
                onSelect={() => {}}
            />,
        );

        const errorItems = screen.findByType(ProviderErrorItems.type);
        expect(errorItems.props.error).toBe(error);
        expect(errorItems.props.retry).toBeTypeOf('function');
        await act(async () => { await errorItems.props.retry(); });
        expect(retryProjection).toHaveBeenCalledOnce();
    });

    it('presents every connection refresh failure through the same retry owner', async () => {
        const retryProjection = vi.fn(async () => {});
        const failures = [
            {
                connectionId: ProviderConnectionIdSchema.parse('pc_secret'),
                error: createProviderErrorV1('provider_secret_missing', {
                    machineId: 'machine-a', connectionId: 'pc_secret',
                }),
            },
            {
                connectionId: ProviderConnectionIdSchema.parse('pc_endpoint'),
                error: createProviderErrorV1('provider_endpoint_unavailable', {
                    machineId: 'machine-a', connectionId: 'pc_endpoint',
                }),
            },
        ] as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={[]}
                providerProjectionAuthoritative
                projectionFailures={failures}
                retryProjection={retryProjection}
                selected={null}
                onSelect={() => {}}
            />,
        );

        const errorItems = screen.findAllByType(ProviderErrorItems.type);
        expect(errorItems.map((item) => item.props.error)).toEqual(failures.map((failure) => failure.error));
        await act(async () => { await errorItems[1]!.props.retry(); });
        expect(retryProjection).toHaveBeenCalledOnce();
    });

    it('names the failing source on its failure line, never a bare "Provider is unreachable"', async () => {
        const { connectionId, providerGroups } = experimentalProviderGroup('pc_gateway_work');
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[]}
                providerGroups={providerGroups}
                providerProjectionAuthoritative
                projectionFailures={[{
                    connectionId,
                    error: createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a', connectionId }),
                }]}
                retryProjection={vi.fn(async () => {})}
                selected={null}
                onSelect={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Gateway · Work');
    });

    it('leaves retry to the header refresh when the picker already has one', async () => {
        const headerRefresh = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative={false}
                projectionError={createProviderErrorV1('agent_timeout', { machineId: 'machine-a' })}
                retryProjection={vi.fn(async () => {})}
                probe={{ phase: 'idle', onRefresh: headerRefresh }}
                selected={null}
                onSelect={() => {}}
            />,
        );

        // The header refresh re-runs the same projection; a second refresh on the error line
        // would put two identical controls a few pixels apart.
        const errorItems = screen.findByType(ProviderErrorItems.type);
        expect(errorItems.props.retry).toBeUndefined();
    });

    it('projects exact favorites as the first canonical section and keeps unavailable favorites removable', async () => {
        const available = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'available',
        } as const;
        const unavailable = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_removed'),
            modelId: 'unavailable',
        } as const;
        const onToggleFavorite = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="agent:happier.agent.codex/codex"
                nativeModels={[{ value: 'available', label: 'Available model' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={available}
                favoriteEntries={[
                    { ref: available, label: 'Stored available' },
                    { ref: unavailable, label: 'Stored unavailable' },
                ]}
                favoriteKeys={new Set([
                    JSON.stringify([available.agentTargetKey, available.providerConnectionId, available.modelId]),
                    JSON.stringify([unavailable.agentTargetKey, unavailable.providerConnectionId, unavailable.modelId]),
                ])}
                onToggleFavorite={onToggleFavorite}
                favoriteActionVisibility="all"
                onSelect={() => {}}
            />,
        );

        const rootStep = screen.findByType(SelectionList).props.rootStep;
        expect(rootStep.sections[0]).toMatchObject({
            id: 'favorites',
            title: 'Favorites',
            options: [
                { label: 'Available model', disabled: undefined },
                { label: 'Stored unavailable', disabled: true },
            ],
        });
        await screen.pressByTestIdAsync(
            `model-picker-overlay-option-favorite:${JSON.stringify([
                unavailable.agentTargetKey,
                unavailable.providerConnectionId,
                unavailable.modelId,
            ])}`,
        );
        expect(onToggleFavorite).toHaveBeenCalledWith(unavailable);
    });

    it('preserves the list scope when only experimental-confirmation state changes', async () => {
        await withPopoverWebGlobals(async () => {
            const nativeModels = Array.from({ length: 100 }, (_, index) => ({
                value: `model-${index}`,
                label: `Model ${index}`,
            }));
            const providerGroups = [] as const;
            const confirm = vi.fn(async () => false);
            const clear = vi.fn();
            const renderPicker = (pending: boolean) => (
                <SessionModelPicker
                    agentTargetKey="agent:happier.agent.codex/codex"
                    nativeModels={nativeModels}
                    providerGroups={providerGroups}
                    providerProjectionAuthoritative
                    selected={null}
                    experimentalConfirmation={{
                        confirm,
                        pending,
                        error: null,
                        retry: null,
                        clear,
                    }}
                    onSelect={() => {}}
                />
            );
            const screen = await renderScreen(renderPicker(false));
            const rootStepBefore = screen.findByType(SelectionList).props.rootStep;

            await screen.update(renderPicker(true));

            expect(screen.findByType(SelectionList).props.rootStep).toBe(rootStepBefore);
        });
    });

    it('says when a change applies on the running line the host supplies', async () => {
        const reported = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-sol' } as const;
        const screen = await renderScreen(
            <SessionModelApplyTimingContext.Provider
                value={{ timing: 'Applies from your next message', notes: ['Kept for resume'] }}
            >
                <SessionModelPicker
                    multiColumn
                    agentTargetKey="agent:happier.agent.codex/codex"
                    nativeModels={[{ value: 'gpt-5.6-sol', label: '5.6 Sol' }, { value: 'gpt-5.6-terra', label: '5.6 Terra' }]}
                    providerGroups={[]}
                    providerProjectionAuthoritative
                    selected={reported}
                    reportedModel={{ ref: reported, status: 'running' }}
                    onSelect={() => {}}
                />
            </SessionModelApplyTimingContext.Provider>,
        );

        // One line says what runs and when a change takes effect (the composer's own engine
        // pane says the same through AgentInput); the host's resume note stays a note.
        const text = screen.getTextContent();
        expect(text).toContain(`${t('agentInput.model.running', { model: '5.6 Sol' })} · Applies from your next message`);
        expect(text).toContain('Kept for resume');
    });
});
