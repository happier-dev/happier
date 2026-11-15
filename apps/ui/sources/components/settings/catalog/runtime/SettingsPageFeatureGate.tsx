import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { resolveFeatureToggleHref } from '@/components/settings/features/featuresSettings';
import { getUiFeatureDefinition } from '@/sync/domains/features/featureRegistry';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { t, tLoose } from '@/text';
import { resolveSettingsHost } from '../settingDeclarations';
import { readSettingsPageGate } from '../pageCatalog';
import { resolveSettingsPageGateUnavailableReason } from '../settingsPageGateAvailability';
import type { SettingsPageGate } from '../types';

/** Direct routes consume the catalog's feature admission before mounting resource-owning children. */
export function SettingsPageFeatureGate(props: Readonly<{ pageId: string; children: React.ReactNode }>) {
    const gate = readSettingsPageGate(props.pageId);
    return gate?.featureId
        ? <GatedPage gate={gate} featureId={gate.featureId}>{props.children}</GatedPage>
        : <>{props.children}</>;
}

function GatedPage(props: Readonly<{ gate: SettingsPageGate; featureId: FeatureId; children: React.ReactNode }>) {
    const decision = useFeatureDecision(props.featureId);
    const enabled = decision?.state === 'enabled';
    const useProfiles = Boolean(useSetting('useProfiles'));
    const devModeEnabled = Boolean(useLocalSetting('devModeEnabled'));
    const experimentsEnabled = useSetting('experiments') === true;
    const router = useRouter();
    const unavailable = resolveSettingsPageGateUnavailableReason(props.gate, {
        useProfiles, devModeEnabled, tauriDesktop: resolveSettingsHost().desktop,
        features: { [props.featureId]: enabled },
    });
    if (!unavailable) return <>{props.children}</>;
    // Until the server answers, admission is unknown: say so (it narrates a long wait itself) rather
    // than claim the feature is off or mount resource-owning children early.
    if (decision === null) return <SurfaceStateCard kind="loading" title={t('settings.voiceAssistant')} />;
    // The decision's own reason says why: the person's Features switch leads back to it; only a
    // server that turned the feature off is called off on the server.
    const arm = resolveFeatureAvailabilityArm(decision);
    const featuresHref = arm === 'policy_disabled' && decision.blockedBy === 'local_policy'
        ? resolveFeatureToggleHref(props.featureId, experimentsEnabled) : undefined;
    const featureTitleKey = getUiFeatureDefinition(props.featureId).settingsToggle?.titleKey;
    const reason = featuresHref && featureTitleKey
        ? t('settingsVoice.pages.conversations.agentFeatureRequired', { feature: t(featureTitleKey) })
        : arm === 'unknown' ? tLoose('voice.readiness.server_feature_unknown') : tLoose('voice.readiness.server_feature_disabled');
    return <SurfaceStateCard
        kind="unavailable"
        accessibilitySemantics="alert"
        title={t('settings.voiceAssistant')}
        reason={reason}
        action={featuresHref
            ? { label: t('voice.readiness.actions.open_features'), onPress: () => router.push(featuresHref as never) }
            : { label: t('common.close'), onPress: () => router.replace('/settings/voice') }}
    />;
}
