import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionModelPicker, type SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
import { SessionModelSourceUsage } from '@/components/sessions/modelPicker/SessionModelSourceUsage';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/schemas';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

const noop = () => {};
const MODELS = [
    { value: 'default', label: 'Use CLI settings', description: 'Configure models in CLI settings' },
    { value: 'opus-5-5', label: 'Opus 5.5', description: 'Latest Opus model for long-running agentic and knowledge work.' },
    { value: 'sonnet-5', label: 'Sonnet 5', description: 'Latest balanced Claude model for coding, agentic work, editing, and analysis.' },
];

const BASE: Pick<SessionModelPickerProps,
    'agentTargetKey' | 'providerGroups' | 'providerProjectionAuthoritative' | 'selected' | 'onSelect'> = {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerGroups: [],
    providerProjectionAuthoritative: false,
    selected: null,
    onSelect: noop,
};

/** A browsed source's balance line, which a Home without a usage-reporting source cannot show. */
const SOURCE_USAGE = {
    supported: true,
    refreshing: false,
    failed: false,
    pendingApproval: null,
    presentation: {
        groups: [{ scope: 'account' as const, meters: [{
            meterId: 'balance', label: 'Balance', unit: 'usd', currency: 'USD',
            amount: { kind: 'remaining' as const, remaining: 5 }, remainingPct: null, tone: 'neutral' as const, estimated: false,
        }] }],
        billingSlots: [], checked: true, fetchedAt: Date.UTC(2026, 10, 5, 9, 8), sourceErrors: [], connectionError: null,
    },
};

/** A Provider source's last-known models (its refresh may have failed since; the rows stay). */
const providerSource = (connectionId: string, providerName: string, connectionName: string, models: ReadonlyArray<[string, string]>) => ({
    connectionId: ProviderConnectionIdSchema.parse(connectionId), providerName, connectionName,
    connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
    authorization: { authorized: true as const }, manualModelPolicy: 'allowed' as const, supportsFreeformModelIds: true,
    suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent' as const, modelLoadPreflightPolicy: null,
    rows: models.map(([modelId, name]) => ({
        ref: { agentTargetKey: BASE.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse(connectionId), modelId },
        descriptor: { id: modelId, name }, sources: { manual: false, static: true, probe: false },
        confidence: 'verified_static' as const,
        compatibility: { result: { status: 'verified' as const, selectedProtocol: 'openai-responses' as const,
            evidence: { sourceUrls: ['https://openrouter.ai/docs'], verifiedAt: '2026-10-12' } },
            compatibilityFingerprint: `compatibility:v1:${connectionId}`, confirmed: true },
        endpointHealth: 'available' as const, catalog: { stale: false }, loadState: 'unknown' as const, visibility: 'visible' as const,
    })),
});
const PROVIDER_SOURCES = [
    providerSource('openrouter', 'OpenRouter', 'Work', [['anthropic/claude-sonnet-5', 'Sonnet 5'], ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro']]),
    providerSource('lm-studio', 'LM Studio', 'Studio', [['qwen3-coder-30b', 'Qwen3 Coder 30B']]),
    providerSource('azure-foundry', 'Azure AI Foundry', 'Contoso', [['gpt-5.5', 'GPT-5.5']]),
] as unknown as SessionModelPickerProps['providerGroups'];
/** Each source's refresh failed with its own typed cause; the shared error presenter titles each one. */
const failure = (connectionId: string, code: Parameters<typeof createProviderErrorV1>[0]) => ({
    connectionId: ProviderConnectionIdSchema.parse(connectionId), error: createProviderErrorV1(code, { connectionId }),
});
const SOURCE_FAILURES = [
    failure('openrouter', 'provider_probe_response_invalid'),
    failure('lm-studio', 'provider_materialization_failed'),
    failure('azure-foundry', 'provider_agent_runtime_unsupported'),
];

const CODEX = BASE.agentTargetKey;
const teamModel = (resourceId: string, modelId: string, name: string) => ({
    selection: { kind: 'team_credential_provider_model', teamId: 'acme', resourceId, expectedResourceRevision: 1,
        deliveryMode: 'brokered', agentTargetKey: CODEX, modelId },
    descriptor: { id: modelId, name }, sourceRevision: 'source-1', availability: 'available',
    application: { agentTargetKey: CODEX, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' },
});
const teamResource = (id: string, readiness: { kind: string }, models: ReturnType<typeof teamModel>[], named = true) =>
    TeamCredentialResourceCatalogEntryV1Schema.parse({
        id, teamId: 'acme', resourceRevision: 1, readiness, recoveryAction: readiness.kind === 'available' ? null : 'source_owner_action',
        displayName: named ? { content: { t: 'plain', v: id }, recipientEnvelope: null, legacyPlaintext: true } : null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
        providerModels: models,
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
    });
/** A Team's shared credentials as a member sees them: one healthy, one behind an offline broker, one unreadable. */
const TEAM_RESOURCES = [
    teamResource('team-codex', { kind: 'available' }, [
        teamModel('team-codex', 'gpt-5.5-codex', 'GPT-5.5 Codex'), teamModel('team-codex', 'gpt-5.5-mini', 'GPT-5.5 mini')]),
    teamResource('design-chatgpt', { kind: 'broker_unavailable' }, [
        teamModel('design-chatgpt', 'gpt-5.5', 'GPT-5.5'), teamModel('design-chatgpt', 'gpt-5.5-codex', 'GPT-5.5 Codex'),
        teamModel('design-chatgpt', 'o5-pro', 'o5 pro')]),
    teamResource('old-pool', { kind: 'resource_corrupt' }, [], false),
];
const TEAM_PROPS = {
    declarationContext: { kind: 'account' as const },
    teamCredentialResources: TEAM_RESOURCES,
    teamCredentialDisplayNames: { 'team-codex': 'Team Codex', 'design-chatgpt': 'Design ChatGPT', 'old-pool': null },
    teamNameById: { acme: 'Acme' },
    homeNameByTeamId: { acme: 'Acme Cloud' },
};

/** The model pane's states: `?frame=normal|loading|refreshing|empty|pending|usage|failures|team|inherited`. */
function frameProps(frame: string): SessionModelPickerProps {
    const none = { ...BASE, nativeModels: [], allowAutomatic: false, canEnterCustomNativeValue: false };
    switch (frame) {
        case 'loading': return { ...none, probe: { phase: 'loading' } };
        case 'refreshing': return { ...none, probe: { phase: 'refreshing' } };
        case 'empty': return { ...none, probe: { phase: 'idle', onRefresh: noop } };
        case 'pending': return {
            ...none,
            probe: { phase: 'loading' },
            projectionApproval: { artifactId: 'dev-approval', href: buildApprovalHref('dev-approval', 'dev-home') },
        };
        case 'failures': return { ...BASE, nativeModels: MODELS, providerGroups: PROVIDER_SOURCES,
            providerProjectionAuthoritative: true, projectionFailures: SOURCE_FAILURES, retryProjection: noop,
            selected: { agentTargetKey: BASE.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('openrouter'), modelId: 'anthropic/claude-sonnet-5' },
            probe: { phase: 'idle', onRefresh: noop } };
        case 'team': return { ...BASE, ...TEAM_PROPS, nativeModels: MODELS, probe: { phase: 'idle', onRefresh: noop } };
        // Lab L11 nsPop: the selected model came from the project's Team default and says so on its row only.
        case 'inherited': return { ...BASE, ...TEAM_PROPS, nativeModels: MODELS, probe: { phase: 'idle', onRefresh: noop },
            selected: ProviderBoundModelRefSchema.parse({ agentTargetKey: BASE.agentTargetKey, modelId: 'opus-5-5' }),
            selectedAttribution: 'Acme · acme/web' };
        default: return { ...BASE, nativeModels: MODELS, probe: { phase: 'idle', onRefresh: noop } };
    }
}

/**
 * Dev-only: the New Session model pane through the real `SessionModelPicker`, for the states a live
 * Home cannot hold still (loading, empty, a refresh waiting on its approval). Never linked from product surfaces.
 */
export function ModelPickerStatesSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame = props.frame ?? 'normal';
    return (
        <View style={styles.page} testID={`model-picker-states-${frame}`}>
            <View style={styles.pane}>
                {frame === 'usage' ? <SessionModelSourceUsage usage={SOURCE_USAGE as never} onOpenApproval={null} onOpenConnection={noop} /> : null}
                <SessionModelPicker multiColumn fillAvailableSpace {...frameProps(frame)} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base, alignItems: 'center', padding: theme.space.s16 },
    pane: { width: '100%', maxWidth: 640, height: 560 },
}));
