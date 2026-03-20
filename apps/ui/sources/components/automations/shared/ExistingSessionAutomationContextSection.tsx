import React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

function resolveResumeSupportSubtitle(availability: ExistingSessionAutomationAuthoringContext['availability']): string | null {
    if (availability.kind !== 'ready') {
        return null;
    }

    return availability.eligibility.strategy === 'happy_attach'
        ? t('settingsProviders.resumeSupportSupportedExperimental')
        : t('settingsProviders.resumeSupportSupported');
}

function resolveMcpSelectionCount(selection: SessionAuthoringDraft['mcpSelection']): number {
    const parsed = SessionMcpSelectionV1Schema.safeParse(selection ?? {});
    if (!parsed.success) return 0;
    return parsed.data.forceIncludeServerIds.length
        + parsed.data.forceExcludeServerIds.length
        + (parsed.data.managedServersEnabled === false ? 1 : 0);
}

function resolveConnectedServicesCount(connectedServices: SessionAuthoringDraft['connectedServices']): number {
    if (!connectedServices || typeof connectedServices !== 'object' || Array.isArray(connectedServices)) {
        return 0;
    }
    const bindings = (connectedServices as { bindingsByServiceId?: Record<string, { source?: unknown }> }).bindingsByServiceId;
    if (!bindings || typeof bindings !== 'object') {
        return 0;
    }
    return Object.values(bindings).filter((binding) => binding?.source === 'connected').length;
}

function resolveTranscriptStorageLabel(transcriptStorage: SessionAuthoringDraft['transcriptStorage']): string | null {
    if (transcriptStorage === 'direct') {
        return t('sessionsList.storageDirectTab');
    }
    if (transcriptStorage === 'persisted') {
        return t('sessionsList.storagePersistedTab');
    }
    return null;
}

function resolveSessionEncryptionLabel(sessionEncryptionMode: SessionAuthoringDraft['sessionEncryptionMode']): string | null {
    if (sessionEncryptionMode === 'e2ee') {
        return t('terminal.endToEndEncrypted');
    }
    if (sessionEncryptionMode === 'plain') {
        return t('welcome.chooseEncryptionPlain');
    }
    return null;
}

export function ExistingSessionAutomationContextSection(props: Readonly<{
    context: ExistingSessionAutomationAuthoringContext;
}>): React.JSX.Element | null {
    const { context } = props;
    const capabilities = context.capabilities;

    const rows: React.JSX.Element[] = [];
    if (capabilities.backend === 'inherited') {
        const backendLabel = resolveExecutionRunBackendLabel(context.draft.backendTarget)
            ?? (typeof context.draft.agentId === 'string' ? context.draft.agentId : null);
        if (backendLabel) {
            rows.push(
                <Item
                    key="backend"
                    title={t('settingsSession.replayResume.summaryRunner.backendTitle')}
                    subtitle={backendLabel}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }
    if (capabilities.sessionEncryption === 'inherited') {
        const sessionEncryptionLabel = resolveSessionEncryptionLabel(context.draft.sessionEncryptionMode);
        if (sessionEncryptionLabel) {
            rows.push(
                <Item
                    key="session-encryption"
                    title={t('terminal.encryption')}
                    subtitle={sessionEncryptionLabel}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }
    if (capabilities.transcriptStorage === 'inherited') {
        const transcriptStorageLabel = resolveTranscriptStorageLabel(context.draft.transcriptStorage);
        if (transcriptStorageLabel) {
            rows.push(
                <Item
                    key="transcript"
                    title={t('settingsSession.transcript.title')}
                    subtitle={transcriptStorageLabel}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }
    if (capabilities.machine === 'inherited' && context.availability.kind === 'ready') {
        const displayName = typeof context.session.metadata?.displayName === 'string'
            ? context.session.metadata.displayName
            : null;
        const host = typeof context.session.metadata?.host === 'string'
            ? context.session.metadata.host
            : null;
        const machineLabel = getMachineDisplayName({
            id: context.availability.machineId,
            metadata: {
                displayName,
                host,
            },
        }) ?? context.availability.machineId;
        rows.push(
            <Item
                key="machine"
                title={t('common.machine')}
                subtitle={machineLabel}
                mode="info"
                showChevron={false}
            />,
        );
    }
    if (capabilities.path === 'inherited') {
        rows.push(
            <Item
                key="path"
                title={t('common.path')}
                subtitle={context.draft.directory}
                mode="info"
                showChevron={false}
            />,
        );
    }
    if (capabilities.profile === 'inherited' && context.draft.profileId) {
        rows.push(
            <Item
                key="profile"
                title={t('profiles.title')}
                subtitle={context.draft.profileId}
                mode="info"
                showChevron={false}
            />,
        );
    }
    if (capabilities.mcp === 'inherited') {
        const mcpCount = resolveMcpSelectionCount(context.draft.mcpSelection);
        if (mcpCount > 0) {
            rows.push(
                <Item
                    key="mcp"
                    title={`${t('settingsActions.targets.mcp.title')} (${mcpCount})`}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }
    if (capabilities.connectedServices === 'inherited') {
        const connectedServicesCount = resolveConnectedServicesCount(context.draft.connectedServices);
        if (connectedServicesCount > 0) {
            rows.push(
                <Item
                    key="connected-services"
                    title={`${t('connectedServices.title')} (${connectedServicesCount})`}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }
    if (capabilities.resumeSupport === 'inherited') {
        const subtitle = resolveResumeSupportSubtitle(context.availability);
        if (subtitle) {
            rows.push(
                <Item
                    key="resume-support"
                    title={t('settingsProviders.resumeSupportTitle')}
                    subtitle={subtitle}
                    mode="info"
                    showChevron={false}
                />,
            );
        }
    }

    if (rows.length === 0) {
        return null;
    }

    return (
        <ItemGroup title={t('common.details')}>
            {rows}
        </ItemGroup>
    );
}
