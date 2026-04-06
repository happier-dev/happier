import * as React from 'react';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskSnapshot } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { setActiveShareableServerUrl, setServerProfileShareableUrl } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';

export type RelayAccessWizardPrimaryState = Readonly<{
    label: string;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

type CreateConfigResult = RelayAccessConfig | null | Promise<RelayAccessConfig | null>;

export type UseRelayAccessWizardConfigStepParams = Readonly<{
    providerId: RelayAccessProviderId;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
    isSaveNeeded: boolean;
    isPrimaryDisabled: boolean;
    createConfig: () => CreateConfigResult;
    control: Readonly<{
        configure: (payload: Readonly<{ providerId: RelayAccessProviderId; config: RelayAccessConfig }>) => Promise<string | null>;
        isBusy: boolean;
        isUnavailable: boolean;
        lastErrorMessage?: string | null;
        activeTaskSnapshot: SystemTaskRunState | null;
        snapshot: RelayAccessTaskSnapshot | null;
    }>;
    matchesConfiguredSnapshot?: (snapshot: RelayAccessTaskSnapshot) => boolean;
}>;

export function useRelayAccessWizardConfigStep(params: UseRelayAccessWizardConfigStepParams) {
    const {
        control,
        createConfig,
        isPrimaryDisabled,
        isSaveNeeded,
        matchesConfiguredSnapshot: customMatchesConfiguredSnapshot,
        onRequestAdvance,
        onWizardPrimaryChange,
        providerId,
        serverProfileId,
        onShareUrlChange,
        upstreamUrl,
    } = params;
    const [advanceAfterSaveRequested, setAdvanceAfterSaveRequested] = React.useState(false);
    const matchesConfiguredSnapshot = React.useCallback((candidate: RelayAccessTaskSnapshot) => {
        if (customMatchesConfiguredSnapshot) {
            return customMatchesConfiguredSnapshot(candidate);
        }
        return candidate.configured === true && candidate.providerId === providerId;
    }, [customMatchesConfiguredSnapshot, providerId]);

    const handlePrimaryPress = React.useCallback(async () => {
        if (!isSaveNeeded) {
            onRequestAdvance?.();
            return;
        }

        const config = await createConfig();
        if (!config || control.isUnavailable) {
            setAdvanceAfterSaveRequested(false);
            return;
        }

        const taskId = await control.configure({
            providerId,
            config,
        });
        if (!taskId) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        setAdvanceAfterSaveRequested(true);
    }, [control, createConfig, isSaveNeeded, onRequestAdvance, providerId]);

    React.useEffect(() => {
        if (!onWizardPrimaryChange) return;
        onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: control.isBusy || control.isUnavailable || isPrimaryDisabled,
            onPress: handlePrimaryPress,
        });
        return () => onWizardPrimaryChange?.(null);
    }, [control.isBusy, control.isUnavailable, handlePrimaryPress, isPrimaryDisabled, onWizardPrimaryChange]);

    React.useEffect(() => {
        const snapshot = control.snapshot;
        if (!snapshot) {
            return;
        }
        const shareUrl = snapshot.status?.shareUrl ?? null;
        onShareUrlChange?.(shareUrl);
        if (serverProfileId) {
            setServerProfileShareableUrl(serverProfileId, shareUrl, {
                validatedAgainstServerUrl: upstreamUrl ?? null,
            });
            return;
        }
        setActiveShareableServerUrl(shareUrl, {
            validatedAgainstServerUrl: upstreamUrl ?? null,
        });
    }, [control.snapshot, onShareUrlChange, serverProfileId, upstreamUrl]);

    React.useEffect(() => {
        if (!advanceAfterSaveRequested) return;
        if (control.isBusy) return;
        if (typeof control.lastErrorMessage === 'string' && control.lastErrorMessage.trim().length > 0) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        const snapshot = control.snapshot;
        if (!snapshot) {
            return;
        }
        if (matchesConfiguredSnapshot(snapshot)) {
            setAdvanceAfterSaveRequested(false);
            onRequestAdvance?.();
            return;
        }
    }, [advanceAfterSaveRequested, control.isBusy, control.lastErrorMessage, control.snapshot, matchesConfiguredSnapshot, onRequestAdvance]);
}
